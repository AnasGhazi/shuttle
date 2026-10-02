'use strict';

/**
 * Socket.IO event handlers: identity, courts and presence.
 *
 * Socket.IO "rooms" we use:
 *   court:<courtId>    everyone on a court (for broadcasts)
 *   device:<deviceId>  the one socket of a device (for direct messages)
 *
 * Rooms are local to a server process until the Redis adapter is added
 * (Phase 2). After that, io.to(room).emit() reaches sockets on every instance.
 */

const crypto = require('node:crypto');
const { courtIdFromIp, LOCAL_COURT_ID } = require('./courtId');

const courtRoom = (courtId) => `court:${courtId}`;
const deviceRoom = (deviceId) => `device:${deviceId}`;

/**
 * The browser keeps a random secret token (in sessionStorage) and sends it on
 * connect. Its public device ID is a hash of that token: peers see the ID, but
 * can't work backwards to the token, so they can't impersonate the device.
 */
const TOKEN_RE = /^[0-9a-f]{32}$/;
function deviceIdFromToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex').slice(0, 16);
}

/** Describe a court the way the client should see it. */
function describeCourt(courtId) {
  if (courtId === LOCAL_COURT_ID) return { id: courtId, kind: 'lan', label: 'Local network' };
  if (courtId.startsWith('solo:')) return { id: courtId, kind: 'solo', label: 'Unrecognized network' };
  return { id: courtId, kind: 'network', label: 'Your network' };
}

function attachRealtime(io, { store, clientIp, config }) {
  // Court work that hasn't finished yet. On shutdown we wait for it, so the
  // last "leave" writes reach Redis before the Redis connection closes.
  const inflight = new Set();
  const track = (p) => {
    inflight.add(p);
    p.finally(() => inflight.delete(p));
  };
  async function drain() {
    while (inflight.size) await Promise.allSettled([...inflight]);
  }

  async function broadcastDevices(courtId) {
    io.to(courtRoom(courtId)).emit('court:devices', await store.listDevices(courtId));
  }

  // ---- Handshake middleware: runs once per connection, before 'connection'.
  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth?.deviceToken;
      if (typeof token !== 'string' || !TOKEN_RE.test(token)) {
        return next(new Error('bad-token'));
      }
      const deviceId = deviceIdFromToken(token);

      // If this device already has a live socket (a reload where the old
      // connection hasn't timed out yet, or a duplicated browser tab), the
      // newest connection wins. The old one is told why it's being dropped
      // so a duplicated tab can pick a fresh identity instead of fighting.
      io.to(deviceRoom(deviceId)).emit('session:replaced');
      io.in(deviceRoom(deviceId)).disconnectSockets(true);

      const ip = clientIp(socket.request);
      socket.data.deviceId = deviceId;
      // Unparseable IP: put the device on its own. It can still use a code.
      socket.data.networkCourtId = courtIdFromIp(ip) ?? `solo:${deviceId}`;
      socket.data.court = null;
      next();
    } catch (err) {
      console.error('[handshake]', err);
      next(new Error('server-error'));
    }
  });

  io.on('connection', (socket) => {
    const { deviceId } = socket.data;
    socket.join(deviceRoom(deviceId));

    // Run court changes for this socket one at a time, in order. Without
    // this, a quick "join" followed by "disconnect" could interleave their
    // Redis calls and leave the device listed on a court it already left.
    // (Note: every socket.on() below is registered synchronously. Anything
    // registered after an `await` could miss the client's first messages.)
    let queue = Promise.resolve();
    const serial = (fn) => {
      queue = queue.then(fn).catch((err) => console.error('[court]', err));
      track(queue);
      return queue;
    };

    serial(() => store.registerDevice(deviceId, socket.id));

    async function leaveCurrentCourt() {
      const prev = socket.data.court;
      if (!prev) return;
      socket.leave(courtRoom(prev.id));
      socket.data.court = null;
      // Only remove presence if we are still the device's current session:
      // if a newer tab/reload has taken over, the device is still "here".
      if ((await store.getDeviceSession(deviceId)) === socket.id) {
        await store.removePresence(prev.id, deviceId);
      }
      await broadcastDevices(prev.id);
    }

    async function joinCourt(court) {
      if (socket.data.court?.id !== court.id) await leaveCurrentCourt();
      socket.data.court = court;
      socket.join(courtRoom(court.id));
      await store.touchPresence(court.id, deviceId);

      socket.emit('court:state', {
        court,
        you: { id: deviceId },
        devices: await store.listDevices(court.id),
      });
      // Tell everyone else on the court about the new arrival.
      socket.to(courtRoom(court.id)).emit('court:devices', await store.listDevices(court.id));
    }

    // Client asks to join its court (sent right after every (re)connect).
    socket.on('court:join', () => {
      serial(() => joinCourt(describeCourt(socket.data.networkCourtId)));
    });

    // Heartbeat: refresh our "last seen" score so we don't get pruned.
    const heartbeat = setInterval(() => {
      const court = socket.data.court;
      if (court) store.touchPresence(court.id, deviceId).catch(() => {});
    }, config.presenceHeartbeatMs);

    socket.on('disconnect', () => {
      clearInterval(heartbeat);
      serial(leaveCurrentCourt);
    });
  });

  return { drain };
}

module.exports = { attachRealtime, deviceIdFromToken, courtRoom, deviceRoom };
