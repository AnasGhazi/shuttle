import { getDeviceToken, rotateDeviceToken } from './identity.js';

const $ = (sel) => document.querySelector(sel);

const state = {
  you: null, // { id }
  court: null, // { id, kind, label }
  devices: [], // [{ id, session }], including ourselves
};

// ---- Socket.IO connection ----------------------------------------------

// `io` is the global from /socket.io/socket.io.js.
// `auth` is a function so a reconnect always sends the *current* token.
const socket = io({
  auth: (cb) => cb({ deviceToken: getDeviceToken() }),
  // Tell the server right away when the tab closes, instead of it waiting
  // for a ping timeout. Peers then see us leave immediately.
  closeOnBeforeunload: true,
});

socket.on('connect', () => {
  setStatus('online', 'On court');
  // Ask to (re)join our court. Sent on every reconnect too, because the
  // server forgets which rooms a socket was in when it disconnects.
  socket.emit('court:join');
});

socket.on('disconnect', (reason) => {
  setStatus('offline', 'Reconnecting…');
  // "io server disconnect" means the server kicked us on purpose (see
  // session:replaced). Socket.IO won't auto-reconnect in that case.
  if (reason === 'io server disconnect') socket.connect();
});

socket.on('connect_error', (err) => {
  setStatus('offline', 'Offline');
  if (err.message === 'bad-token') rotateDeviceToken();
});

// Another tab connected with our identity (you duplicated this tab, which
// copies sessionStorage). Become a new device instead of fighting over it.
socket.on('session:replaced', () => rotateDeviceToken());

// Full snapshot after joining a court.
socket.on('court:state', ({ court, you, devices }) => {
  state.court = court;
  state.you = you;
  state.devices = devices;
  render();
});

// Someone arrived or left.
socket.on('court:devices', (devices) => {
  state.devices = devices;
  render();
});

// ---- Rendering ------------------------------------------------------------

function setStatus(kind, text) {
  const el = $('#conn-status');
  el.className = `status status--${kind}`;
  el.textContent = text;
}

function displayName(device) {
  return device.name || `Device ${device.id.slice(0, 4)}`;
}

function render() {
  $('#court-label').textContent = state.court ? state.court.label : 'The court';
  const me = state.devices.find((d) => d.id === state.you?.id);
  $('#you-name').textContent = me ? displayName(me) : '…';

  const others = state.devices.filter((d) => d.id !== state.you?.id);
  $('#device-count').textContent = String(state.devices.length);
  $('#devices-empty').hidden = others.length > 0;

  const list = $('#device-list');
  list.replaceChildren(
    ...others.map((d) => {
      const li = document.createElement('li');
      li.className = 'device';
      li.textContent = displayName(d); // textContent, never innerHTML, for anything from the network
      return li;
    }),
  );
}
