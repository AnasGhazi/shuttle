'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { courtIdFromIp, normalizeIp, LOCAL_COURT_ID } = require('../src/courtId');

test('IPv4: public address becomes its own court', () => {
  assert.equal(courtIdFromIp('203.0.113.7'), 'ip4:203.0.113.7');
  assert.equal(courtIdFromIp('8.8.8.8'), 'ip4:8.8.8.8');
});

test('IPv4: surrounding whitespace is ignored', () => {
  assert.equal(courtIdFromIp('  203.0.113.7 '), 'ip4:203.0.113.7');
});

test('IPv4: two devices behind the same router share a court', () => {
  assert.equal(courtIdFromIp('198.51.100.20'), courtIdFromIp('198.51.100.20'));
  assert.notEqual(courtIdFromIp('198.51.100.20'), courtIdFromIp('198.51.100.21'));
});

test('IPv4: private, loopback and link-local addresses share the LAN court', () => {
  for (const ip of ['192.168.1.20', '10.0.0.5', '172.16.4.4', '127.0.0.1', '169.254.10.10']) {
    assert.equal(courtIdFromIp(ip), LOCAL_COURT_ID, ip);
  }
});

test('IPv4-mapped IPv6 is unwrapped to plain IPv4', () => {
  assert.equal(courtIdFromIp('::ffff:203.0.113.7'), 'ip4:203.0.113.7');
  assert.equal(courtIdFromIp('::FFFF:203.0.113.7'), 'ip4:203.0.113.7');
  // Mapped private addresses still land in the LAN court.
  assert.equal(courtIdFromIp('::ffff:192.168.1.5'), LOCAL_COURT_ID);
  assert.equal(courtIdFromIp('::ffff:127.0.0.1'), LOCAL_COURT_ID);
  // The same device must get the same court either way.
  assert.equal(courtIdFromIp('::ffff:198.51.100.9'), courtIdFromIp('198.51.100.9'));
});

test('IPv6: devices on the same /64 share a court', () => {
  const a = courtIdFromIp('2001:db8:abcd:12:1111:2222:3333:4444');
  const b = courtIdFromIp('2001:db8:abcd:12:aaaa:bbbb:cccc:dddd');
  assert.equal(a, 'ip6:2001:db8:abcd:12::/64');
  assert.equal(a, b);
});

test('IPv6: a different /64 is a different court', () => {
  assert.notEqual(
    courtIdFromIp('2001:db8:abcd:12::1'),
    courtIdFromIp('2001:db8:abcd:13::1'),
  );
});

test('IPv6: equivalent spellings normalize to the same court', () => {
  const expanded = courtIdFromIp('2001:0db8:abcd:0012:0000:0000:0000:0001');
  assert.equal(expanded, courtIdFromIp('2001:db8:abcd:12::1'));
  assert.equal(expanded, courtIdFromIp('2001:DB8:ABCD:12::1'));
});

test('IPv6: brackets and zone indexes are stripped', () => {
  assert.equal(courtIdFromIp('[2001:db8:abcd:12::1]'), 'ip6:2001:db8:abcd:12::/64');
  assert.equal(courtIdFromIp('fe80::1%en0'), LOCAL_COURT_ID);
});

test('IPv6: loopback, link-local and unique-local share the LAN court', () => {
  for (const ip of ['::1', 'fe80::1234:5678', 'fd12:3456:789a:1::1']) {
    assert.equal(courtIdFromIp(ip), LOCAL_COURT_ID, ip);
  }
});

test('malformed input returns null', () => {
  const bad = [
    undefined, null, 42, {}, '', '   ',
    'not-an-ip', 'localhost',
    '256.1.1.1', '1.2.3', '1.2.3.4.5', '1.2.3.4/24',
    '127.1', '0x7f.0.0.1', '0177.0.0.1', // legacy IPv4 forms
    '2001:db8::g', '2001:db8:::1', '1:2:3:4:5:6:7:8:9',
    '203.0.113.7, 10.0.0.1', // an unsplit X-Forwarded-For list
    'x'.repeat(1000),
  ];
  for (const input of bad) {
    assert.equal(courtIdFromIp(input), null, `expected null for ${JSON.stringify(input)}`);
  }
});

test('addresses that cannot be a client return null', () => {
  for (const ip of ['0.0.0.0', '::', '255.255.255.255', '224.0.0.1', 'ff02::1']) {
    assert.equal(courtIdFromIp(ip), null, ip);
  }
});

test('normalizeIp returns an ipaddr object with the right kind', () => {
  assert.equal(normalizeIp('::ffff:1.2.3.4').kind(), 'ipv4');
  assert.equal(normalizeIp('2001:db8::1').kind(), 'ipv6');
  assert.equal(normalizeIp('nope'), null);
});
