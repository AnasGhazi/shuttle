'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { cleanName } = require('../src/realtime');
const { redisAvailable, startServer, randomPublicIp, joinAs, waitFor } = require('./helpers');

const emitAck = (socket, event, payload) =>
  new Promise((resolve) => socket.emit(event, payload, resolve));

test('cleanName tidies user-chosen names', () => {
  assert.equal(cleanName('  Anas   the  Ace '), 'Anas the Ace');
  assert.equal(cleanName('Zoë'), 'Zoë');
  assert.equal(cleanName('bad\u0000name'), 'badname');
  for (const bad of ['', '   ', '\u0007', 'x'.repeat(33), 42, null]) assert.equal(cleanName(bad), null);
});

test('naming yourself (needs Redis)', async (t) => {
  if (!(await redisAvailable())) return t.skip('Redis is not running');

  const server = await startServer();
  const sockets = [];
  t.after(async () => {
    sockets.forEach((s) => s.disconnect());
    await server.close();
  });

  const ip = randomPublicIp();
  const token = 'cd'.repeat(16);
  const a = await joinAs(server.url, { ip, token });
  const b = await joinAs(server.url, { ip });
  sockets.push(b.socket);

  await t.test('a new name reaches everyone on the court', async () => {
    const seen = waitFor(b.socket, 'court:devices', (list) => list.some((d) => d.name === 'Anas'));
    const ack = await emitAck(a.socket, 'device:rename', { name: '  Anas ' });
    assert.deepEqual(ack, { ok: true, name: 'Anas' });
    await seen;
  });

  await t.test('names must be unique on the court (ignoring case)', async () => {
    const ack = await emitAck(b.socket, 'device:rename', { name: 'anas' });
    assert.equal(ack.error, 'name-taken');
  });

  await t.test('junk is refused', async () => {
    assert.equal((await emitAck(b.socket, 'device:rename', { name: '   ' })).error, 'bad-name');
  });

  await t.test('the name sticks across reconnects', async () => {
    a.socket.disconnect();
    const again = await joinAs(server.url, { ip, token });
    sockets.push(again.socket);
    assert.equal(again.state.you.name, 'Anas');
  });
});
