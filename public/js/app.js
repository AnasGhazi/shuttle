import { getDeviceToken, rotateDeviceToken } from './identity.js';
import { createTextSync } from './textSync.js';

const $ = (sel) => document.querySelector(sel);

const state = {
  you: null, // { id }
  court: null, // { id, kind, label }
  devices: [], // [{ id, session }], including ourselves
  text: null, // { by, updatedAt, expiresAt } of the latest save
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

// ---- Shared text ----------------------------------------------------------

const textarea = $('#court-text');
const textSync = createTextSync({
  socket,
  textarea,
  onRemoteText: (update) => {
    state.text = update;
    renderTextMeta();
  },
  onSaved: (saved) => {
    state.text = { ...saved, by: state.you?.id, updatedAt: Date.now() };
    renderTextMeta();
  },
  onError: (code) => {
    $('#text-meta').textContent = code === 'text-too-long' ? 'Too long to serve.' : 'Not saved, retrying when you type again.';
  },
});

$('#clear-text').addEventListener('click', () => textSync.set(''));
$('#copy-text').addEventListener('click', async () => {
  await copyToClipboard(textarea.value);
  $('#copy-text').textContent = 'Copied!';
  setTimeout(() => ($('#copy-text').textContent = 'Copy'), 1200);
});

async function copyToClipboard(text) {
  // The modern Clipboard API only exists on https:// (or localhost). On a
  // plain http://192.168.x.x page we fall back to the old select-and-copy.
  if (navigator.clipboard && window.isSecureContext) {
    return navigator.clipboard.writeText(text);
  }
  textarea.select();
  document.execCommand('copy');
}

// Refresh "clears in N min" now and then.
setInterval(renderTextMeta, 30_000);

// Full snapshot after joining a court.
socket.on('court:state', ({ court, you, devices, text }) => {
  state.court = court;
  state.you = you;
  state.devices = devices;
  state.text = text;
  textSync.reset(text);
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

function deviceName(id) {
  const d = state.devices.find((x) => x.id === id);
  return d ? displayName(d) : 'someone';
}

function renderTextMeta() {
  const t = state.text;
  const el = $('#text-meta');
  if (!t?.expiresAt || !textarea.value) {
    el.textContent = '';
    return;
  }
  const mins = Math.max(1, Math.round((t.expiresAt - Date.now()) / 60_000));
  const who = t.by === state.you?.id ? 'you' : deviceName(t.by);
  el.textContent = `Served by ${who} · clears in ${mins} min`;
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
  renderTextMeta();
}
