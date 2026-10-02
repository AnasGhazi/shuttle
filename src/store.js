'use strict';

/**
 * All Redis reads and writes live here, so the key scheme is in one place.
 *
 *   shuttle:court:{<courtId>}:devices   ZSET   member=deviceId, score=last seen (ms)
 *   shuttle:court:{<courtId>}:text      HASH   { text, by, updatedAt, version }  TTL 30 min
 *   shuttle:court:{<courtId>}:files     HASH   fileId -> JSON details            TTL 6 h, refreshed
 *   shuttle:device:<deviceId>           HASH   { name, session }                 TTL 24 h
 *   shuttle:code:<1234>                 STRING courtId                           TTL 30 min, refreshed while in use
 *   shuttle:ratelimit:code:<networkId>  STRING failed code guesses               TTL 60 s
 *
 * The {curly braces} are a Redis Cluster "hash tag": every key of one court
 * hashes to the same slot, so multi-key transactions on a court keep working
 * if this ever runs on a cluster. Plain Redis ignores them.
 */

const crypto = require('node:crypto');
const { randomName } = require('./names');

const PREFIX = 'shuttle';

const keys = {
  courtDevices: (courtId) => `${PREFIX}:court:{${courtId}}:devices`,
  courtText: (courtId) => `${PREFIX}:court:{${courtId}}:text`,
  courtFiles: (courtId) => `${PREFIX}:court:{${courtId}}:files`,
  device: (deviceId) => `${PREFIX}:device:${deviceId}`,
  code: (code) => `${PREFIX}:code:${code}`,
  codeGuesses: (networkCourtId) => `${PREFIX}:ratelimit:code:${networkCourtId}`,
};

// Files on a court. Only their *details* live here (name, size, who has it);
// the bytes stay in the owner's browser and travel peer-to-peer on download.
// Entries vanish when the owner leaves; the TTL only cleans up after crashes.
const FILES_TTL_S = 6 * 60 * 60;
const MAX_FILES_PER_COURT = 50;

const CODE_GUESS_WINDOW_S = 60;
const CODE_MAX_GUESSES = 10; // wrong codes allowed per network per minute

const DEVICE_TTL_S = 24 * 60 * 60; // remember a device's details for a day

/**
 * Save the court's text and hand out a version number, atomically.
 *
 * Why a Lua script? Redis runs a script as a single step: no other command
 * can sneak in between "read the old version" and "write the new one", even
 * with many server instances. Two devices typing at the same moment always
 * get two different versions, and every client keeps the higher one.
 *
 * A fresh key (first text, or the old text expired) starts its version at the
 * current time in ms rather than at 1. A client that saw version 40 before the
 * text expired still accepts the new text, because its version is far higher.
 *
 * KEYS[1] = text key
 * ARGV    = text, by (deviceId), now (ms), ttl (ms)
 */
const SET_TEXT_SCRIPT = `
local v = redis.call('HGET', KEYS[1], 'version')
if v then v = tonumber(v) + 1 else v = tonumber(ARGV[3]) end
-- '%.0f' writes a big number as plain digits (never "1.7e+12")
redis.call('HSET', KEYS[1], 'text', ARGV[1], 'by', ARGV[2], 'updatedAt', ARGV[3], 'version', string.format('%.0f', v))
redis.call('PEXPIRE', KEYS[1], ARGV[4])
return v
`;

function createStore(redis, { presenceStaleMs, textTtlS, codeTtlS }) {
  // An empty or abandoned presence set deletes itself after this long.
  const presenceKeyTtlS = Math.ceil((presenceStaleMs * 2) / 1000);

  return {
    keys,

    // ---- Devices ---------------------------------------------------------

    /**
     * Record which socket currently represents this device, and give it a
     * name if it doesn't have one yet (HSETNX only writes if the field is
     * missing, so a returning device keeps its name). Returns the name.
     */
    async registerDevice(deviceId, session) {
      const key = keys.device(deviceId);
      const [, , name] = await redis
        .multi()
        .hSet(key, { session })
        .hSetNX(key, 'name', randomName())
        .hGet(key, 'name')
        .expire(key, DEVICE_TTL_S)
        .exec();
      return name;
    },

    async renameDevice(deviceId, name) {
      await redis.hSet(keys.device(deviceId), { name });
    },

    async getDeviceSession(deviceId) {
      return redis.hGet(keys.device(deviceId), 'session');
    },

    // ---- Presence --------------------------------------------------------

    /** Add (or refresh) a device in a court. Also used as the heartbeat. */
    async touchPresence(courtId, deviceId) {
      const key = keys.courtDevices(courtId);
      await redis
        .multi()
        .zAdd(key, { score: Date.now(), value: deviceId })
        .expire(key, presenceKeyTtlS)
        .exec();
    },

    async removePresence(courtId, deviceId) {
      await redis.zRem(keys.courtDevices(courtId), deviceId);
    },

    async isPresent(courtId, deviceId) {
      return (await redis.zScore(keys.courtDevices(courtId), deviceId)) !== null;
    },

    /**
     * Everyone on a court right now, as [{ id, session }].
     * Devices whose heartbeat stopped (e.g. their server crashed) are pruned
     * first, so ghosts disappear on their own.
     */
    async listDevices(courtId) {
      const key = keys.courtDevices(courtId);
      const [, ids] = await redis
        .multi()
        .zRemRangeByScore(key, '-inf', Date.now() - presenceStaleMs)
        .zRange(key, 0, -1)
        .exec();
      if (ids.length === 0) return [];

      // Fetch every device hash in one round trip.
      const pipeline = redis.multi();
      for (const id of ids) pipeline.hGetAll(keys.device(id));
      const details = await pipeline.exec();

      return ids.map((id, i) => ({
        id,
        name: details[i]?.name ?? null,
        session: details[i]?.session ?? null,
      }));
    },

    // ---- Shared text -------------------------------------------------------

    /**
     * The court's text, or an empty one if nothing was served (or it expired).
     * `expiresAt` lets the UI show "clears in 12 min".
     */
    async getText(courtId) {
      const key = keys.courtText(courtId);
      const [hash, pttl] = await redis.multi().hGetAll(key).pTTL(key).exec();
      if (!hash || !hash.version) return { text: '', by: null, updatedAt: null, version: 0, expiresAt: null };
      return {
        text: hash.text,
        by: hash.by,
        updatedAt: Number(hash.updatedAt),
        version: Number(hash.version),
        expiresAt: pttl > 0 ? Date.now() + pttl : null,
      };
    },

    // ---- Court codes --------------------------------------------------------

    /**
     * Create a private court and a 4-digit code that points to it.
     * SET ... NX only succeeds if the code isn't already in use, so two
     * courts can never share a code; on a clash we just try another.
     */
    async createCodeCourt() {
      const courtId = `code:${crypto.randomBytes(8).toString('hex')}`;
      for (let attempt = 0; attempt < 20; attempt++) {
        const code = String(crypto.randomInt(0, 10_000)).padStart(4, '0');
        const ok = await redis.set(keys.code(code), courtId, { NX: true, EX: codeTtlS });
        if (ok === 'OK') return { code, courtId, expiresAt: Date.now() + codeTtlS * 1000 };
      }
      throw new Error('no free court codes'); // ~10,000 courts active at once
    },

    /** code -> courtId (refreshing its TTL), or null if unknown/expired. */
    async resolveCode(code) {
      const [courtId] = await redis
        .multi()
        .get(keys.code(code))
        .expire(keys.code(code), codeTtlS)
        .exec();
      return courtId ?? null;
    },

    /** Keep a code alive while its court is in use (called on heartbeats). */
    async touchCode(code, courtId) {
      // Only if it still points at *this* court: an expired code may have been
      // handed to a new court since, and we mustn't extend that one.
      if ((await redis.get(keys.code(code))) === courtId) {
        await redis.expire(keys.code(code), codeTtlS);
      }
    },

    /**
     * Brute-force guard: there are only 10,000 codes, so cap wrong guesses
     * per network. Returns true if this network is currently locked out.
     */
    async codeGuessesExceeded(networkCourtId) {
      const n = Number(await redis.get(keys.codeGuesses(networkCourtId)));
      return n >= CODE_MAX_GUESSES;
    },

    async recordWrongCode(networkCourtId) {
      const key = keys.codeGuesses(networkCourtId);
      // INCR creates the counter at 1; EXPIRE ... NX sets the window only on
      // the first wrong guess, so it really resets 60 s after that guess.
      await redis.multi().incr(key).expire(key, CODE_GUESS_WINDOW_S, 'NX').exec();
    },

    // ---- Files on the court -------------------------------------------------

    /** Returns false if the court already holds too many files. */
    async addFile(courtId, entry) {
      const key = keys.courtFiles(courtId);
      if (!(await redis.hExists(key, entry.id)) && (await redis.hLen(key)) >= MAX_FILES_PER_COURT) return false;
      await redis.multi().hSet(key, entry.id, JSON.stringify(entry)).expire(key, FILES_TTL_S).exec();
      return true;
    },

    async getFile(courtId, fileId) {
      const raw = await redis.hGet(keys.courtFiles(courtId), fileId);
      return raw ? JSON.parse(raw) : null;
    },

    async removeFile(courtId, fileId) {
      await redis.hDel(keys.courtFiles(courtId), fileId);
    },

    /** A device left: everything it was sharing goes with it. */
    async removeFilesByOwner(courtId, owner) {
      const all = await this.listFiles(courtId);
      const ids = all.filter((f) => f.owner === owner).map((f) => f.id);
      if (ids.length) await redis.hDel(keys.courtFiles(courtId), ids);
    },

    /** Every file entry on a court, oldest first. */
    async listFiles(courtId) {
      const hash = await redis.hGetAll(keys.courtFiles(courtId));
      return Object.values(hash)
        .map((raw) => {
          try {
            return JSON.parse(raw);
          } catch {
            return null;
          }
        })
        .filter(Boolean)
        .sort((a, b) => a.servedAt - b.servedAt);
    },

    async setText(courtId, text, by) {
      const now = Date.now();
      const ttlMs = textTtlS * 1000;
      const version = await redis.eval(SET_TEXT_SCRIPT, {
        keys: [keys.courtText(courtId)],
        arguments: [text, by, String(now), String(ttlMs)],
      });
      return { text, by, updatedAt: now, version: Number(version), expiresAt: now + ttlMs };
    },
  };
}

module.exports = { createStore, keys };
