'use strict';

// Load variables from a local .env file if there is one. This is built into
// Node (>= 20.12), so we don't need the `dotenv` package. On a hosting platform
// you set real environment variables instead and there is no .env file.
try {
  process.loadEnvFile();
} catch {
  // No .env file: that's fine, defaults below apply.
}

/**
 * Parse TRUST_PROXY the same way Express parses its `trust proxy` setting:
 *   "true"/"false" -> boolean
 *   "2"            -> number of proxy hops to trust
 *   "loopback, 10.0.0.0/8" -> list of trusted addresses / subnets
 */
function parseTrustProxy(value) {
  if (value === undefined || value === '' || value === 'false') return false;
  if (value === 'true') return true;
  if (/^\d+$/.test(value)) return Number(value);
  return value.split(',').map((s) => s.trim()).filter(Boolean);
}

function int(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n)) throw new Error(`${name} must be an integer, got "${raw}"`);
  return n;
}

const config = {
  port: int('PORT', 3000),
  host: process.env.HOST || '0.0.0.0',
  redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',
  trustProxy: parseTrustProxy(process.env.TRUST_PROXY),

  // Presence: each connected device refreshes its "last seen" time this often,
  // and anyone not seen for `presenceStaleMs` is treated as gone. This cleans
  // up after a server instance crashes without running its disconnect handlers.
  presenceHeartbeatMs: int('PRESENCE_HEARTBEAT_MS', 20_000),
  presenceStaleMs: int('PRESENCE_STALE_MS', 60_000),
};

module.exports = { config, parseTrustProxy };
