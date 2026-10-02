'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { buildIceServers, timeLimitedTurnCredentials } = require('../src/ice');

const STUN = ['stun:stun.l.google.com:19302'];

test('STUN only by default', () => {
  assert.deepEqual(buildIceServers({ stunUrls: STUN, turn: null }), [{ urls: STUN }]);
});

test('static TURN credentials are passed through', () => {
  const servers = buildIceServers({
    stunUrls: STUN,
    turn: { urls: ['turn:turn.example.com:3478'], username: 'u', credential: 'p' },
  });
  assert.deepEqual(servers[1], { urls: ['turn:turn.example.com:3478'], username: 'u', credential: 'p' });
});

test('TURN_SECRET produces time-limited credentials a TURN server can verify', () => {
  const now = Date.UTC(2026, 9, 2, 12, 0, 0);
  const servers = buildIceServers(
    { stunUrls: STUN, turn: { urls: ['turns:turn.example.com:5349'], secret: 's3cret', ttlS: 3600 } },
    now,
  );
  const { username, credential } = servers[1];
  assert.equal(username, `${now / 1000 + 3600}:shuttle`);
  // What coturn does on its side: HMAC-SHA1(secret, username), base64.
  const expected = crypto.createHmac('sha1', 's3cret').update(username).digest('base64');
  assert.equal(credential, expected);
});

test('credentials change as time passes', () => {
  const a = timeLimitedTurnCredentials('k', 60, 0);
  const b = timeLimitedTurnCredentials('k', 60, 120_000);
  assert.notEqual(a.username, b.username);
  assert.notEqual(a.credential, b.credential);
});
