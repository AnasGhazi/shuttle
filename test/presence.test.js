'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { redisAvailable, startServer, randomPublicIp, joinAs, waitFor, client, next } = require('./helpers');

test('courts and presence (needs Redis)', async (t) => {
  if (!(await redisAvailable())) return t.skip('Redis is not running');

  const server = await startServer();
  const sockets = [];
  t.after(async () => {
    sockets.forEach((s) => s.disconnect());
    await server.close();
  });

  const homeIp = randomPublicIp();

  await t.test('two devices behind one IP land on the same court', async () => {
    const a = await joinAs(server.url, { ip: homeIp });
    sockets.push(a.socket);
    const bJoined = waitFor(a.socket, 'court:devices', (list) => list.length === 2);
    const b = await joinAs(server.url, { ip: homeIp });
    sockets.push(b.socket);

    assert.equal(a.state.court.id, `ip4:${homeIp}`);
    assert.equal(b.state.court.id, a.state.court.id);
    assert.equal(b.state.devices.length, 2);
    await bJoined; // A was told about B
  });

  await t.test('a device on another network does not see them', async () => {
    const c = await joinAs(server.url, { ip: randomPublicIp() });
    sockets.push(c.socket);
    assert.equal(c.state.devices.length, 1);
    assert.equal(c.state.devices[0].id, c.state.you.id);
  });

  await t.test('leaving updates everyone else', async () => {
    const watcher = await joinAs(server.url, { ip: homeIp });
    sockets.push(watcher.socket);
    const leaver = await joinAs(server.url, { ip: homeIp });
    const gone = waitFor(watcher.socket, 'court:devices', (list) => !list.some((d) => d.id === leaver.state.you.id));
    leaver.socket.disconnect();
    await gone;
  });

  await t.test('a bad token is rejected', async () => {
    const bad = client(server.url, { ip: homeIp, token: 'nope' });
    const err = await next(bad, 'connect_error');
    assert.equal(err.message, 'bad-token');
    bad.close();
  });

  await t.test('reconnecting with the same token replaces the old session', async () => {
    const token = 'ab'.repeat(16);
    const first = await joinAs(server.url, { ip: homeIp, token });
    const replaced = next(first.socket, 'session:replaced');
    const second = await joinAs(server.url, { ip: homeIp, token });
    sockets.push(second.socket);
    await replaced;
    assert.equal(second.state.you.id, first.state.you.id);
    // Still listed exactly once.
    const listing = second.state.devices.filter((d) => d.id === second.state.you.id);
    assert.equal(listing.length, 1);
  });
});
