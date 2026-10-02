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

  // Shared text disappears this long after the last edit.
  textTtlS: int('TEXT_TTL_S', 30 * 60),
  // Longest text a court can hold (characters).
  textMaxLength: int('TEXT_MAX_LENGTH', 50_000),
  // A court code stays valid this long after the last device leaves its court.
  codeTtlS: int('CODE_TTL_S', 30 * 60),

  // ==========================================================================
  //  WebRTC ICE servers: how browsers find a path to each other.
  // ==========================================================================
  //  STUN: "what's my public address?" Free, cheap, enough for most home
  //        networks. Google runs public ones.
  //  TURN: a relay for networks where a direct path is impossible (strict
  //        corporate firewalls, some mobile carriers). Costs bandwidth, so
  //        there is no free public one. Set these to use your own:
  //
  //        TURN_URL=turn:turn.example.com:3478,turns:turn.example.com:5349
  //        then EITHER static credentials:
  //          TURN_USERNAME=...   TURN_CREDENTIAL=...
  //        OR (recommended) a shared secret for time-limited credentials:
  //          TURN_SECRET=...     (coturn: use-auth-secret + static-auth-secret)
  //          TURN_TTL_S=86400    (how long each issued credential works)
  //
  //  The browser fetches this list from GET /api/rtc-config (see src/ice.js).
  // ==========================================================================
  stunUrls: (process.env.STUN_URLS ?? 'stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302')
    .split(',').map((s) => s.trim()).filter(Boolean),
  turn: process.env.TURN_URL
    ? {
        urls: process.env.TURN_URL.split(',').map((s) => s.trim()).filter(Boolean),
        username: process.env.TURN_USERNAME || '',
        credential: process.env.TURN_CREDENTIAL || '',
        secret: process.env.TURN_SECRET || '',
        ttlS: int('TURN_TTL_S', 24 * 60 * 60),
      }
    : null,
};

/** Warnings worth printing at startup (misconfigurations, not errors). */
function configWarnings(c) {
  const warnings = [];
  if (c.trustProxy === true) {
    warnings.push(
      'TRUST_PROXY=true trusts X-Forwarded-For from anyone, so clients can pick any court ' +
        'by faking the header. Use a hop count (e.g. 1) or your proxy\'s addresses instead.',
    );
  }
  if (c.turn && !c.turn.secret && !(c.turn.username && c.turn.credential)) {
    warnings.push('TURN_URL is set but has no credentials (set TURN_SECRET, or TURN_USERNAME + TURN_CREDENTIAL).');
  }
  return warnings;
}

module.exports = { config, parseTrustProxy, configWarnings };
