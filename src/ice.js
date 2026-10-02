'use strict';

/**
 * Build the ICE server list the browser uses for WebRTC (GET /api/rtc-config).
 *
 * STUN is always included. TURN is added when configured, in one of two ways:
 *
 * 1. Static credentials (TURN_USERNAME + TURN_CREDENTIAL). Simple, but anyone
 *    who loads /api/rtc-config can copy them and use your relay forever.
 *
 * 2. A shared secret (TURN_SECRET): the "TURN REST API" scheme supported by
 *    coturn (`use-auth-secret` + `static-auth-secret`) and most providers.
 *    We hand out a username that contains an expiry time, and a password
 *    that is an HMAC of it. The TURN server recomputes the HMAC with the same
 *    secret to check it, and rejects it after the expiry. Leaked credentials
 *    stop working on their own.
 */

const crypto = require('node:crypto');

function timeLimitedTurnCredentials(secret, ttlS, now = Date.now()) {
  const expiry = Math.floor(now / 1000) + ttlS;
  const username = `${expiry}:shuttle`;
  const credential = crypto.createHmac('sha1', secret).update(username).digest('base64');
  return { username, credential };
}

function buildIceServers(config, now = Date.now()) {
  const iceServers = [];
  if (config.stunUrls.length) iceServers.push({ urls: config.stunUrls });

  const turn = config.turn;
  if (turn && turn.urls.length) {
    if (turn.secret) {
      iceServers.push({ urls: turn.urls, ...timeLimitedTurnCredentials(turn.secret, turn.ttlS, now) });
    } else {
      iceServers.push({ urls: turn.urls, username: turn.username, credential: turn.credential });
    }
  }
  return iceServers;
}

module.exports = { buildIceServers, timeLimitedTurnCredentials };
