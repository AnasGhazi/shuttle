'use strict';

/**
 * Fun, short device names so people can tell devices apart:
 * "Swift Racket", "Golden Smash", "Lucky Birdie"...
 */

const crypto = require('node:crypto');

const ADJECTIVES = [
  'Swift', 'Golden', 'Silver', 'Feather', 'Rapid', 'Lofty', 'Nimble', 'Mighty',
  'Clever', 'Brave', 'Sneaky', 'Turbo', 'Breezy', 'Lucky', 'Flying', 'Bold',
  'Smooth', 'Crisp', 'Sharp', 'Steady', 'Zippy', 'Spinning', 'Royal', 'Sunny',
];

const NOUNS = [
  'Racket', 'Smash', 'Shuttle', 'Drop Shot', 'Clear', 'Drive', 'Lob', 'Net Shot',
  'Rally', 'Serve', 'Birdie', 'Flick', 'Lift', 'Backhand', 'Forehand', 'Ace',
  'Baseline', 'Grip', 'Jump Smash', 'Kill Shot',
];

const pick = (list) => list[crypto.randomInt(list.length)];

/**
 * A random name, avoiding any in `taken` (a Set) when possible.
 * With 480 combinations a clash is rare; after a few tries we add a number.
 */
function randomName(taken = new Set()) {
  for (let i = 0; i < 20; i++) {
    const name = `${pick(ADJECTIVES)} ${pick(NOUNS)}`;
    if (!taken.has(name)) return name;
  }
  let name;
  do name = `${pick(ADJECTIVES)} ${pick(NOUNS)} ${crypto.randomInt(2, 100)}`;
  while (taken.has(name));
  return name;
}

module.exports = { randomName, ADJECTIVES, NOUNS };
