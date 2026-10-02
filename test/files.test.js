'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { redisAvailable, startServer, randomPublicIp, joinAs, next, waitFor } = require('./helpers');

const emitAck = (socket, event, payload) =>
  new Promise((resolve) => socket.emit(event, payload, resolve));

const fileId = () => Math.random().toString(36).slice(2, 12).padEnd(10, '0');

test('files on the court (needs Redis)', async (t) => {
  if (!(await redisAvailable())) return t.skip('Redis is not running');

  const server = await startServer();
  const sockets = [];
  t.after(async () => {
    sockets.forEach((s) => s.disconnect());
    await server.close();
  });

  const ip = randomPublicIp();
  const owner = await joinAs(server.url, { ip });
  const alice = await joinAs(server.url, { ip });
  const bob = await joinAs(server.url, { ip });
  const stranger = await joinAs(server.url, { ip: randomPublicIp() });
  sockets.push(owner.socket, alice.socket, bob.socket, stranger.socket);

  const publicId = fileId();
  const privateId = fileId();

  await t.test('a served file shows up for everyone on the court', async () => {
    const seenByAlice = waitFor(alice.socket, 'files:changed', (list) => list.some((f) => f.id === publicId));
    const seenByBob = waitFor(bob.socket, 'files:changed', (list) => list.some((f) => f.id === publicId));
    const ack = await emitAck(owner.socket, 'files:add', { id: publicId, name: 'photo.jpg', size: 1234, mime: 'image/jpeg' });
    assert.equal(ack.ok, true);
    const [list] = await Promise.all([seenByAlice, seenByBob]);
    const entry = list.find((f) => f.id === publicId);
    assert.equal(entry.owner, owner.state.you.id);
    assert.equal(entry.size, 1234);
  });

  await t.test('another court never sees it', async () => {
    await assert.rejects(waitFor(stranger.socket, 'files:changed', () => true, 300), /timed out/);
  });

  await t.test('a device joining later gets the list', async () => {
    const late = await joinAs(server.url, { ip });
    sockets.push(late.socket);
    assert.ok(late.state.files.some((f) => f.id === publicId));
  });

  await t.test('"send to one device" is only visible to that device (and the sender)', async () => {
    const aliceView = waitFor(alice.socket, 'files:changed', (list) => list.some((f) => f.id === privateId));
    const bobView = next(bob.socket, 'files:changed');
    await emitAck(owner.socket, 'files:add', { id: privateId, name: 'secret.pdf', size: 10, to: alice.state.you.id });
    await aliceView;
    assert.ok(!(await bobView).some((f) => f.id === privateId), 'bob must not see it');
  });

  await t.test('only the owner can remove a file', async () => {
    const ack = await emitAck(alice.socket, 'files:remove', { id: publicId });
    assert.equal(ack.error, 'bad-file');
  });

  await t.test('bad details are rejected', async () => {
    for (const bad of [
      { id: 'x', name: 'a', size: 1 },
      { id: fileId(), name: '', size: 1 },
      { id: fileId(), name: 'a', size: -1 },
      { id: fileId(), name: 'a', size: 1, to: 'nope' },
    ]) {
      assert.equal((await emitAck(owner.socket, 'files:add', bad)).error, 'bad-file');
    }
    const huge = await emitAck(owner.socket, 'files:add', { id: fileId(), name: 'a', size: 3 * 1024 ** 3 });
    assert.equal(huge.error, 'too-large');
  });

  await t.test("when the owner leaves, the owner's files leave with them", async () => {
    const gone = waitFor(alice.socket, 'files:changed', (list) => !list.some((f) => f.id === publicId));
    owner.socket.disconnect();
    await gone;
  });
});
