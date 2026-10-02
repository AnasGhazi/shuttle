'use strict';

/**
 * Helpers for integration tests: boot a real Shuttle server on a random port
 * and connect Socket.IO clients that pretend to come from any IP we like
 * (the server is told to trust X-Forwarded-For from localhost).
 */

const crypto = require('node:crypto');
const { createClient } = require('redis');
const { io: connect } = require('socket.io-client');
const { createShuttleServer } = require('../src/createServer');
const { config } = require('../src/config');

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

/** Is a Redis server reachable? Integration tests skip themselves if not. */
async function redisAvailable() {
  const client = createClient({ url: REDIS_URL, socket: { reconnectStrategy: false } });
  client.on('error', () => {});
  try {
    await client.connect();
    await client.quit();
    return true;
  } catch {
    return false;
  }
}

async function startServer(overrides = {}) {
  const server = await createShuttleServer({
    ...config, // the real defaults, so tests can't drift from them
    port: 0,
    host: '127.0.0.1',
    redisUrl: REDIS_URL,
    trustProxy: ['loopback'],
    ...overrides,
  });
  await new Promise((resolve) => server.httpServer.listen(0, '127.0.0.1', resolve));
  const { port } = server.httpServer.address();
  return { ...server, url: `http://127.0.0.1:${port}` };
}

/** A random public-looking IPv4 address, so test runs never share courts. */
function randomPublicIp() {
  // First octet 11-99 avoids 10.x (private) and 127.x (loopback).
  const n = (lo, hi) => crypto.randomInt(lo, hi);
  return `${n(11, 100)}.${n(0, 256)}.${n(0, 256)}.${n(1, 255)}`;
}

function client(url, { ip, token = crypto.randomBytes(16).toString('hex') } = {}) {
  return connect(url, {
    auth: { deviceToken: token },
    extraHeaders: ip ? { 'x-forwarded-for': ip } : {},
    transports: ['websocket'],
    forceNew: true,
    reconnection: false,
  });
}

/** Resolve with the next `event` payload (or reject after a timeout). */
function next(socket, event, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for "${event}"`)), timeoutMs);
    socket.once(event, (payload) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}

/** Wait until `predicate(payload)` is true for some `event`. */
function waitFor(socket, event, predicate, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, handler);
      reject(new Error(`timed out waiting for matching "${event}"`));
    }, timeoutMs);
    function handler(payload) {
      if (!predicate(payload)) return;
      clearTimeout(timer);
      socket.off(event, handler);
      resolve(payload);
    }
    socket.on(event, handler);
  });
}

/** Connect and join; resolves with the court:state snapshot. */
async function joinAs(url, opts) {
  const socket = client(url, opts);
  const state = next(socket, 'court:state');
  socket.on('connect', () => socket.emit('court:join', opts?.join ?? {}));
  return { socket, state: await state };
}

module.exports = { redisAvailable, startServer, randomPublicIp, client, next, waitFor, joinAs };
