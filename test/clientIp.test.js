'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createClientIpResolver } = require('../src/clientIp');
const { parseTrustProxy } = require('../src/config');

// A minimal stand-in for Node's http.IncomingMessage.
function fakeReq(socketAddr, xff) {
  return {
    headers: xff === undefined ? {} : { 'x-forwarded-for': xff },
    socket: { remoteAddress: socketAddr },
  };
}

test('no trusted proxy: X-Forwarded-For is ignored (cannot be spoofed)', () => {
  const ip = createClientIpResolver(false);
  assert.equal(ip(fakeReq('198.51.100.9', '6.6.6.6')), '198.51.100.9');
});

test('one trusted hop: the address the proxy saw is used', () => {
  const ip = createClientIpResolver(1);
  assert.equal(ip(fakeReq('10.0.0.2', '203.0.113.7')), '203.0.113.7');
  // A client trying to spoof by sending its own header gets the *last* entry:
  // the one our proxy appended.
  assert.equal(ip(fakeReq('10.0.0.2', '6.6.6.6, 203.0.113.7')), '203.0.113.7');
});

test('subnet list: only listed proxies are believed', () => {
  const ip = createClientIpResolver(['loopback', '10.0.0.0/8']);
  assert.equal(ip(fakeReq('127.0.0.1', '203.0.113.7')), '203.0.113.7');
  assert.equal(ip(fakeReq('10.1.2.3', '203.0.113.7, 10.9.9.9')), '203.0.113.7');
  // Request did not come through a trusted proxy: header ignored.
  assert.equal(ip(fakeReq('198.51.100.1', '203.0.113.7')), '198.51.100.1');
});

test('missing header falls back to the socket address', () => {
  const ip = createClientIpResolver(1);
  assert.equal(ip(fakeReq('::ffff:198.51.100.9')), '::ffff:198.51.100.9');
});

test('parseTrustProxy mirrors the Express setting', () => {
  assert.equal(parseTrustProxy(undefined), false);
  assert.equal(parseTrustProxy('false'), false);
  assert.equal(parseTrustProxy('true'), true);
  assert.equal(parseTrustProxy('2'), 2);
  assert.deepEqual(parseTrustProxy('loopback, 10.0.0.0/8'), ['loopback', '10.0.0.0/8']);
});
