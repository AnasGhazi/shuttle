'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { redisAvailable, startServer, randomPublicIp, joinAs, next, waitFor } = require('./helpers');

test('WebRTC signaling relay (needs Redis)', async (t) => {
  if (!(await redisAvailable())) return t.skip('Redis is not running');

  const server = await startServer();
  const sockets = [];
  t.after(async () => {
    sockets.forEach((s) => s.disconnect());
    await server.close();
  });

  const ip = randomPublicIp();
  const a = await joinAs(server.url, { ip });
  const b = await joinAs(server.url, { ip });
  const outsider = await joinAs(server.url, { ip: randomPublicIp() });
  sockets.push(a.socket, b.socket, outsider.socket);

  await t.test('serves STUN servers to the browser', async () => {
    const res = await fetch(`${server.url}/api/rtc-config`);
    const { iceServers } = await res.json();
    assert.ok(iceServers[0].urls.some((u) => u.startsWith('stun:')));
  });

  await t.test('whoami reports the client IP and court as the server sees them', async () => {
    const res = await fetch(`${server.url}/api/whoami`, { headers: { 'x-forwarded-for': '2001:db8:5:6::9' } });
    assert.deepEqual(await res.json(), { ip: '2001:db8:5:6::9', courtId: 'ip6:2001:db8:5:6::/64' });
  });

  await t.test('relays a signal to a device on the same court, tagged with the sender', async () => {
    const got = next(b.socket, 'rtc:signal');
    a.socket.emit('rtc:signal', { to: b.state.you.id, data: { type: 'offer', pcId: 'x', sdp: { type: 'offer', sdp: 'v=0' } } });
    const msg = await got;
    assert.equal(msg.from, a.state.you.id);
    assert.equal(msg.data.type, 'offer');
  });

  await t.test('refuses to relay to a device on another court', async () => {
    const leak = waitFor(outsider.socket, 'rtc:signal', () => true, 400);
    a.socket.emit('rtc:signal', { to: outsider.state.you.id, data: { type: 'offer' } });
    await assert.rejects(leak, /timed out/);
  });

  await t.test('drops malformed and oversized signals', async () => {
    const leak = waitFor(b.socket, 'rtc:signal', () => true, 400);
    a.socket.emit('rtc:signal', { to: 'not-an-id', data: { type: 'offer' } });
    a.socket.emit('rtc:signal', { to: b.state.you.id, data: 'nope' });
    a.socket.emit('rtc:signal', { to: b.state.you.id, data: { type: 'offer', sdp: 'x'.repeat(40_000) } });
    await assert.rejects(leak, /timed out/);
  });
});
