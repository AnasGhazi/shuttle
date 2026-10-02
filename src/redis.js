'use strict';

const { createClient } = require('redis');

/**
 * Connect the Redis client used for Shuttle's own data (presence, text, ...).
 *
 * node-redis reconnects automatically if the connection drops later on. For
 * the *first* connection we give up after a few tries instead, so a missing
 * Redis produces a clear startup error rather than an endless retry loop.
 */
async function connectRedis(url) {
  let everConnected = false;

  const client = createClient({
    url,
    socket: {
      reconnectStrategy(retries, cause) {
        if (!everConnected && retries >= 3) return cause; // stop: connect() rejects
        return Math.min(retries * 200, 3000); // wait this many ms, then retry
      },
    },
  });

  // Without an 'error' listener, a dropped connection would crash the process.
  client.on('error', (err) => {
    if (everConnected) console.error('[redis]', err.message);
  });
  client.on('ready', () => {
    everConnected = true;
  });

  try {
    await client.connect();
  } catch (err) {
    // node-redis wraps the real network error; unwrap it for a clear message.
    throw err.socketError ?? err.originalError ?? err;
  }
  return client;
}

/**
 * A second connection with the same settings. The Socket.IO adapter needs two:
 * a connection in "subscriber" mode can't run normal commands, so publishing
 * and subscribing each get their own.
 */
async function connectDuplicate(client, label) {
  const dup = client.duplicate();
  dup.on('error', (err) => console.error(`[redis:${label}]`, err.message));
  await dup.connect();
  return dup;
}

module.exports = { connectRedis, connectDuplicate };
