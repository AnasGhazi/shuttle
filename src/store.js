'use strict';

/**
 * All Redis reads and writes live here, so the key scheme is in one place.
 *
 *   shuttle:court:{<courtId>}:devices   ZSET   member=deviceId, score=last seen (ms)
 *   shuttle:device:<deviceId>           HASH   { session }
 *
 * The {curly braces} are a Redis Cluster "hash tag": every key of one court
 * hashes to the same slot, so multi-key transactions on a court keep working
 * if this ever runs on a cluster. Plain Redis ignores them.
 */

const PREFIX = 'shuttle';

const keys = {
  courtDevices: (courtId) => `${PREFIX}:court:{${courtId}}:devices`,
  device: (deviceId) => `${PREFIX}:device:${deviceId}`,
};

const DEVICE_TTL_S = 24 * 60 * 60; // remember a device's details for a day

function createStore(redis, { presenceStaleMs }) {
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
  };
}

module.exports = { createStore, keys };
