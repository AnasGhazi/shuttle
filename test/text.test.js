'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { redisAvailable, startServer, randomPublicIp, joinAs, next, waitFor } = require('./helpers');

const emitAck = (socket, event, payload) =>
  new Promise((resolve) => socket.emit(event, payload, resolve));

test('shared text (needs Redis)', async (t) => {
  if (!(await redisAvailable())) return t.skip('Redis is not running');

  // Two server instances on the same Redis, as behind a load balancer.
  const serverA = await startServer();
  const serverB = await startServer();
  const sockets = [];
  t.after(async () => {
    sockets.forEach((s) => s.disconnect());
    await Promise.all([serverA.close(), serverB.close()]);
  });

  const ip = randomPublicIp();
  const phone = await joinAs(serverA.url, { ip });
  const laptop = await joinAs(serverB.url, { ip });
  sockets.push(phone.socket, laptop.socket);

  await t.test('devices on different instances share presence', async () => {
    assert.equal(laptop.state.devices.length, 2);
  });

  await t.test('a new court starts with empty text', () => {
    assert.equal(phone.state.text.text, '');
    assert.equal(phone.state.text.version, 0);
  });

  await t.test('text served on one instance reaches a device on the other', async () => {
    const changed = next(laptop.socket, 'text:changed');
    const ack = await emitAck(phone.socket, 'text:update', { text: 'hello from the phone' });
    assert.equal(ack.ok, true);
    const update = await changed;
    assert.equal(update.text, 'hello from the phone');
    assert.equal(update.by, phone.state.you.id);
    assert.equal(update.version, ack.version);
    assert.ok(update.expiresAt > Date.now() + 29 * 60 * 1000, 'expires in ~30 min');
  });

  await t.test('versions always increase, so clients can drop stale updates', async () => {
    const a = await emitAck(phone.socket, 'text:update', { text: 'one' });
    const b = await emitAck(laptop.socket, 'text:update', { text: 'two' });
    assert.ok(b.version > a.version);
  });

  await t.test('a device joining later gets the current text', async () => {
    const late = await joinAs(serverA.url, { ip });
    sockets.push(late.socket);
    assert.equal(late.state.text.text, 'two');
  });

  await t.test('Redis has the right key with a TTL', async () => {
    const key = serverA.store.keys.courtText(phone.state.court.id);
    assert.match(key, /^shuttle:court:\{ip4:[\d.]+\}:text$/);
    const ttl = await serverA.redis.ttl(key);
    assert.ok(ttl > 1790 && ttl <= 1800, `ttl was ${ttl}`);
  });

  await t.test('oversized text is rejected', async () => {
    const ack = await emitAck(phone.socket, 'text:update', { text: 'x'.repeat(50_001) });
    assert.equal(ack.error, 'text-too-long');
  });

  await t.test('other courts never see it', async () => {
    const stranger = await joinAs(serverB.url, { ip: randomPublicIp() });
    sockets.push(stranger.socket);
    assert.equal(stranger.state.text.text, '');
    await assert.rejects(
      waitFor(stranger.socket, 'text:changed', () => true, 300),
      /timed out/,
    );
    await emitAck(phone.socket, 'text:update', { text: 'secret' });
  });
});
