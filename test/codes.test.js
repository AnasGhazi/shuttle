'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { redisAvailable, startServer, randomPublicIp, joinAs, next, waitFor } = require('./helpers');

const emitAck = (socket, event, payload) =>
  new Promise((resolve) => socket.emit(event, payload, resolve));

test('court codes and device names (needs Redis)', async (t) => {
  if (!(await redisAvailable())) return t.skip('Redis is not running');

  const server = await startServer();
  const sockets = [];
  t.after(async () => {
    sockets.forEach((s) => s.disconnect());
    await server.close();
  });

  // Simulates the dual-stack problem: one device arrives over IPv4, the other
  // over IPv6, so the server puts them on different network courts.
  const laptop = await joinAs(server.url, { ip: randomPublicIp() });
  const phone = await joinAs(server.url, { ip: '2001:db8:77:1::5' });
  sockets.push(laptop.socket, phone.socket);
  let code;
  let privateCourtId;

  await t.test('every device gets a badminton name', () => {
    assert.match(laptop.state.you.name, /^[A-Z][a-z]+ [A-Z]/);
    assert.equal(laptop.state.devices[0].name, laptop.state.you.name);
  });

  await t.test('dual-stack devices start on different courts', () => {
    assert.notEqual(laptop.state.court.id, phone.state.court.id);
    assert.equal(phone.state.court.id, 'ip6:2001:db8:77:1::/64');
  });

  await t.test('creating a court code moves you to a private court', async () => {
    const state = next(laptop.socket, 'court:state');
    const ack = await emitAck(laptop.socket, 'court:create', {});
    assert.equal(ack.ok, true);
    assert.match(ack.code, /^\d{4}$/);
    code = ack.code;
    const s = await state;
    assert.equal(s.court.kind, 'code');
    assert.equal(s.court.code, code);
    assert.match(s.court.id, /^code:[0-9a-f]{16}$/);
    privateCourtId = s.court.id;

    const ttl = await server.redis.ttl(`shuttle:code:${code}`);
    assert.ok(ttl > 1790 && ttl <= 1800, `code ttl ${ttl}`);
  });

  await t.test('another network can join with the code and they see each other', async () => {
    const seen = waitFor(laptop.socket, 'court:devices', (list) => list.length === 2);
    const state = next(phone.socket, 'court:state');
    const ack = await emitAck(phone.socket, 'court:join', { code });
    assert.equal(ack.ok, true);
    const s = await state;
    assert.equal(s.court.id, privateCourtId);
    assert.deepEqual(s.devices.map((d) => d.id).sort(), [laptop.state.you.id, phone.state.you.id].sort());
    await seen;
  });

  await t.test('names are unique on a court', async () => {
    const list = await server.store.listDevices(privateCourtId);
    assert.equal(new Set(list.map((d) => d.name)).size, list.length);
  });

  await t.test('text on the private court is separate from the network court', async () => {
    const got = next(laptop.socket, 'text:changed');
    await emitAck(phone.socket, 'text:update', { text: 'served across networks' });
    assert.equal((await got).text, 'served across networks');
    const networkText = await server.store.getText(phone.state.court.id);
    assert.equal(networkText.text, '');
  });

  await t.test('rejoining with a code that now belongs to another court is refused', async () => {
    const ack = await emitAck(phone.socket, 'court:join', { code, courtId: 'code:0000000000000000' });
    assert.equal(ack.error, 'code-expired');
  });

  await t.test('leaving the private court returns you to your network court', async () => {
    const state = next(phone.socket, 'court:state');
    await emitAck(phone.socket, 'court:join', {});
    assert.equal((await state).court.id, 'ip6:2001:db8:77:1::/64');
  });

  await t.test('malformed codes are rejected', async () => {
    for (const bad of ['123', '12345', 'abcd', 1234]) {
      const ack = await emitAck(phone.socket, 'court:join', { code: bad });
      assert.equal(ack.error, 'bad-code', String(bad));
    }
  });

  await t.test('wrong guesses are rate limited per network', async () => {
    const guesser = await joinAs(server.url, { ip: randomPublicIp() });
    sockets.push(guesser.socket);
    const results = [];
    // Pick codes that are very unlikely to exist right now.
    for (let i = 0; i < 12; i++) {
      const guess = String((Number(code) + 1 + i) % 10_000).padStart(4, '0');
      const ack = await emitAck(guesser.socket, 'court:join', { code: guess });
      results.push(ack.error ?? 'joined');
    }
    assert.equal(results.at(-1), 'rate-limited');
    // Even the right code is refused while locked out.
    const ack = await emitAck(guesser.socket, 'court:join', { code });
    assert.equal(ack.error, 'rate-limited');
  });
});
