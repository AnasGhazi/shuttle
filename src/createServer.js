'use strict';

const http = require('node:http');
const path = require('node:path');
const express = require('express');
const { Server } = require('socket.io');
const { createAdapter } = require('@socket.io/redis-adapter');

const { connectRedis, connectDuplicate } = require('./redis');
const { createStore } = require('./store');
const { createClientIpResolver } = require('./clientIp');
const { attachRealtime } = require('./realtime');

/**
 * Build the whole app (HTTP + Socket.IO + Redis) without starting to listen.
 * Keeping this separate from index.js lets tests spin up a real server.
 */
async function createShuttleServer(config) {
  const redis = await connectRedis(config.redisUrl);
  const store = createStore(redis, config);
  const clientIp = createClientIpResolver(config.trustProxy);

  const app = express();
  // Keep Express's req.ip consistent with what Socket.IO uses.
  app.set('trust proxy', config.trustProxy);
  app.disable('x-powered-by');

  // A few cheap security headers. The Content-Security-Policy only allows
  // our own scripts/styles (there is no inline JS anywhere), and blob: URLs
  // for previewing/downloading received files.
  app.use((_req, res, next) => {
    res.set({
      'Content-Security-Policy':
        "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; " +
        "connect-src 'self' ws: wss:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    });
    next();
  });

  app.use(express.static(path.join(__dirname, '..', 'public')));

  // Used by load balancers / uptime checks.
  app.get('/healthz', async (_req, res) => {
    try {
      await redis.ping();
      res.json({ ok: true });
    } catch {
      res.status(503).json({ ok: false });
    }
  });

  const httpServer = http.createServer(app);
  const io = new Server(httpServer, {
    // Our biggest message is a few KB of text or an SDP blob; files never
    // travel through the server. A small cap stops abuse.
    maxHttpBufferSize: 256 * 1024,
  });

  // The Redis adapter: when this instance emits to a room, the message is also
  // published on Redis so every other instance delivers it to *its* sockets
  // in that room. Without it, two devices connected to different instances
  // (behind a load balancer) would never see each other.
  const pubClient = await connectDuplicate(redis, 'pub');
  const subClient = await connectDuplicate(redis, 'sub');
  io.adapter(createAdapter(pubClient, subClient, { key: 'shuttle:socket.io' }));

  const realtime = attachRealtime(io, { store, clientIp, config });

  async function close() {
    // Disconnect every socket (their 'disconnect' handlers remove them from
    // their courts), wait for that Redis work, then close Redis.
    await new Promise((resolve) => io.close(() => resolve()));
    await realtime.drain();
    await Promise.all([redis, pubClient, subClient].map((c) => c.quit().catch(() => {})));
  }

  return { app, httpServer, io, redis, store, close };
}

module.exports = { createShuttleServer };
