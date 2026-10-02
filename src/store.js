'use strict';

/**
 * All Redis reads and writes live here, so the key scheme is in one place.
 *
 *   shuttle:court:{<courtId>}:devices   ZSET   member=deviceId, score=last seen (ms)
 *   shuttle:court:{<courtId>}:text      HASH   { text, by, updatedAt, version }  TTL 30 min
 *   shuttle:device:<deviceId>           HASH   { session }
 *
 * The {curly braces} are a Redis Cluster "hash tag": every key of one court
 * hashes to the same slot, so multi-key transactions on a court keep working
 * if this ever runs on a cluster. Plain Redis ignores them.
 */

const PREFIX = 'shuttle';

const keys = {
  courtDevices: (courtId) => `${PREFIX}:court:{${courtId}}:devices`,
  courtText: (courtId) => `${PREFIX}:court:{${courtId}}:text`,
  device: (deviceId) => `${PREFIX}:device:${deviceId}`,
};

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

function createStore(redis, { presenceStaleMs, textTtlS }) {
  // An empty or abandoned presence set deletes itself after this long.
  const presenceKeyTtlS = Math.ceil((presenceStaleMs * 2) / 1000);

  return {
    keys,

    // ---- Devices ---------------------------------------------------------

    /** Record which socket currently represents this device. */
    async registerDevice(deviceId, session) {
      await redis
        .multi()
        .hSet(keys.device(deviceId), { session })
        .expire(keys.device(deviceId), DEVICE_TTL_S)
        .exec();
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

      return ids.map((id, i) => ({ id, session: details[i]?.session ?? null }));
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
