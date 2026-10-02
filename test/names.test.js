'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomName, ADJECTIVES, NOUNS } = require('../src/names');

test('names are "Adjective Noun"', () => {
  for (let i = 0; i < 200; i++) {
    const name = randomName();
    const adj = ADJECTIVES.find((a) => name.startsWith(`${a} `));
    assert.ok(adj, name);
    assert.ok(NOUNS.includes(name.slice(adj.length + 1)), name);
  }
});

test('avoids names already taken on the court', () => {
  const taken = new Set();
  for (let i = 0; i < 300; i++) {
    const name = randomName(taken);
    assert.ok(!taken.has(name), `duplicate ${name}`);
    taken.add(name);
  }
});

test('still returns a unique name when every combination is taken', () => {
  const taken = new Set();
  for (const a of ADJECTIVES) for (const n of NOUNS) taken.add(`${a} ${n}`);
  const name = randomName(taken);
  assert.ok(!taken.has(name));
  assert.match(name, / \d+$/);
});
