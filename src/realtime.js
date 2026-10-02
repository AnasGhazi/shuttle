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
const { randomName } = require('./names');

const courtRoom = (courtId) => `court:${courtId}`;
const deviceRoom = (deviceId) => `device:${deviceId}`;

/**
 * The browser keeps a random secret token (in sessionStorage) and sends it on
 * connect. Its public device ID is a hash of that token: peers see the ID, but
 * can't work backwards to the token, so they can't impersonate the device.
 */
const TOKEN_RE = /^[0-9a-f]{32}$/;
const DEVICE_ID_RE = /^[0-9a-f]{16}$/;
const CODE_RE = /^\d{4}$/;
// An SDP offer is a few KB; this leaves plenty of room.
const MAX_SIGNAL_BYTES = 32 * 1024;
function deviceIdFromToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex').slice(0, 16);
}

/** Describe a court the way the client should see it. */
function describeCourt(courtId, code) {
  if (code) return { id: courtId, kind: 'code', code, label: `Private court ${code}` };
  if (courtId === LOCAL_COURT_ID) return { id: courtId, kind: 'lan', label: 'Local network court' };
  if (courtId.startsWith('solo:')) return { id: courtId, kind: 'solo', label: 'Unrecognized network' };
  return { id: courtId, kind: 'network', label: 'Your network court' };
}

/** Call a Socket.IO acknowledgement if the client sent one. */
const replier = (ack) => (typeof ack === 'function' ? ack : () => {});

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
      //
      // `.except(socket.id)` matters: with the Redis adapter this request is
      // asynchronous and reaches every instance a moment later. By then the
      // *new* socket has joined the device room too and would kick itself.
      // (Every socket is automatically in a room named after its own id.)
      const others = io.to(deviceRoom(deviceId)).except(socket.id);
      others.emit('session:replaced');
      others.disconnectSockets(true);

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
    const serial = (fn, reply) => {
      queue = queue.then(fn).catch((err) => {
        console.error('[court]', err);
        reply?.({ error: 'server-error' }); // don't leave the client hanging
      });
      track(queue);
      return queue;
    };

    serial(async () => {
      socket.data.name = await store.registerDevice(deviceId, socket.id);
    });

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

      // Two devices on one court with the same name would be confusing:
      // the newcomer picks another.
      let devices = await store.listDevices(court.id);
      const taken = new Set(devices.filter((d) => d.id !== deviceId).map((d) => d.name));
      if (taken.has(socket.data.name)) {
        socket.data.name = randomName(taken);
        await store.renameDevice(deviceId, socket.data.name);
        devices = await store.listDevices(court.id);
      }

      socket.emit('court:state', {
        court,
        you: { id: deviceId, name: socket.data.name },
        devices,
        text: await store.getText(court.id),
      });
      // Tell everyone else on the court about the new arrival.
      socket.to(courtRoom(court.id)).emit('court:devices', devices);
    }

    /**
     * Join a court. Sent right after every (re)connect.
     *   {}                    -> the court for this device's network
     *   { code, courtId? }    -> a private court by its 4-digit code. The
     *                            client includes the courtId it expects when
     *                            rejoining, so an expired code that was
     *                            reused by strangers isn't joined by mistake.
     */
    socket.on('court:join', (payload, ack) => {
      const reply = replier(ack);
      serial(async () => {
        const code = payload?.code;
        if (code === undefined || code === null || code === '') {
          await joinCourt(describeCourt(socket.data.networkCourtId));
          return reply({ ok: true });
        }
        if (typeof code !== 'string' || !CODE_RE.test(code)) return reply({ error: 'bad-code' });

        // Wrong guesses are counted per network (not per device: a script
        // could make up new device tokens all day).
        const network = socket.data.networkCourtId;
        if (await store.codeGuessesExceeded(network)) return reply({ error: 'rate-limited' });

        const courtId = await store.resolveCode(code);
        if (!courtId) {
          await store.recordWrongCode(network);
          return reply({ error: 'code-not-found' });
        }
        if (payload.courtId && payload.courtId !== courtId) return reply({ error: 'code-expired' });

        await joinCourt(describeCourt(courtId, code));
        reply({ ok: true });
      }, reply);
    });

    /** Make a new private court with a fresh code, and move there. */
    socket.on('court:create', (_payload, ack) => {
      const reply = replier(ack);
      serial(async () => {
        const { code, courtId } = await store.createCodeCourt();
        await joinCourt(describeCourt(courtId, code));
        reply({ ok: true, code });
      }, reply);
    });

    // ---- Shared text ------------------------------------------------------
    //
    // The client sends its whole text (debounced while typing). We store it
    // with a fresh version number, tell the sender which version it got (the
    // "ack" callback), and broadcast it to everyone else on the court.
    socket.on('text:update', (payload, ack) => {
      const reply = replier(ack);
      const text = payload?.text;
      if (typeof text !== 'string' || text.length > config.textMaxLength) {
        return reply({ error: 'text-too-long' });
      }
      serial(async () => {
        const court = socket.data.court;
        if (!court) return reply({ error: 'not-on-court' });
        const saved = await store.setText(court.id, text, deviceId);
        reply({ ok: true, version: saved.version, expiresAt: saved.expiresAt });
        socket.to(courtRoom(court.id)).emit('text:changed', saved);
      }, reply);
    });

    // ---- WebRTC signaling --------------------------------------------------
    //
    // Before two browsers can talk directly they must swap an offer, an answer
    // and ICE candidates. We just pass those along, unopened, to the other
    // device, but only if it's on the same court: a stranger elsewhere
    // can't start a connection with you.
    socket.on('rtc:signal', async (payload) => {
      try {
        const to = payload?.to;
        const data = payload?.data;
        if (typeof to !== 'string' || !DEVICE_ID_RE.test(to) || to === deviceId) return;
        if (!data || typeof data !== 'object' || typeof data.type !== 'string') return;
        if (JSON.stringify(data).length > MAX_SIGNAL_BYTES) return;

        const court = socket.data.court;
        if (!court || !(await store.isPresent(court.id, to))) return;

        io.to(deviceRoom(to)).emit('rtc:signal', { from: deviceId, data });
      } catch (err) {
        console.error('[rtc:signal]', err);
      }
    });

    // Heartbeat: refresh our "last seen" score so we don't get pruned.
    const heartbeat = setInterval(() => {
      const court = socket.data.court;
      if (!court) return;
      store.touchPresence(court.id, deviceId).catch(() => {});
      // A private court's code stays valid while anyone is still on it.
      if (court.code) store.touchCode(court.code, court.id).catch(() => {});
    }, config.presenceHeartbeatMs);

    socket.on('disconnect', () => {
      clearInterval(heartbeat);
      serial(leaveCurrentCourt);
    });
  });

  return { drain };
}

module.exports = { attachRealtime, deviceIdFromToken, courtRoom, deviceRoom };
