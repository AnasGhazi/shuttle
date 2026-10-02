// Each browser tab gets a random secret "device token". The server turns it
// into a public device ID by hashing it (see src/realtime.js).
//
// sessionStorage (not localStorage) means: survives a reload, but every tab
// is its own device. Two tabs of one browser can then send files to each
// other, which is handy for testing.

const KEY = 'shuttle.deviceToken';

function randomHex(bytes) {
  // crypto.getRandomValues works on plain http:// pages too. crypto.randomUUID
  // only works in "secure contexts" (https or localhost), and you'll often
  // open Shuttle as http://192.168.x.x:3000 on your phone during development.
  const buf = crypto.getRandomValues(new Uint8Array(bytes));
  return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function getDeviceToken() {
  let token = sessionStorage.getItem(KEY);
  if (!token) {
    token = randomHex(16);
    sessionStorage.setItem(KEY, token);
  }
  return token;
}

/** Pick a brand-new identity (used when another tab took over ours). */
export function rotateDeviceToken() {
  sessionStorage.removeItem(KEY);
  return getDeviceToken();
}
