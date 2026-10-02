import { getDeviceToken, rotateDeviceToken } from './identity.js';
import { createTextSync } from './textSync.js';
import { createPeerManager } from './rtc.js';

const $ = (sel) => document.querySelector(sel);

const state = {
  you: null, // { id }
  court: null, // { id, kind, label }
  devices: [], // [{ id, session }], including ourselves
  text: null, // { by, updatedAt, expiresAt } of the latest save
  links: new Map(), // peerId -> { state, route, rtt } for the WebRTC link
};

// Connect to everyone eagerly on small courts so the first file is instant.
// On a big court (a whole office behind one IP) connect only when needed.
const EAGER_LINK_LIMIT = 6;

// STUN/TURN servers come from the backend (see src/config.js). Fetched
// before the socket exists so no signal can arrive before we're ready.
const { iceServers } = await fetch('/api/rtc-config')
  .then((r) => r.json())
  .catch(() => ({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] }));

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

// ---- Peer-to-peer links -----------------------------------------------------

const peers = createPeerManager({
  socket,
  iceServers,
  getMyId: () => state.you?.id,
  onState: (peerId, { state: linkState, route }) => {
    const prev = state.links.get(peerId) ?? {};
    state.links.set(peerId, { ...prev, state: linkState, route });
    renderDevices();
  },
  onMessage: (peerId, msg) => handlePeerMessage(peerId, msg),
  log: rtcLog,
});

function handlePeerMessage(peerId, msg) {
  switch (msg.type) {
    // The data channel test: answer a ping straight back with a pong.
    case 'ping':
      toast(`🏸 ${deviceName(peerId)} sent a test rally over WebRTC`);
      peers.send(peerId, { type: 'pong', sentAt: msg.sentAt });
      break;
    case 'pong': {
      const link = state.links.get(peerId) ?? {};
      state.links.set(peerId, { ...link, rtt: Math.round(performance.now() - msg.sentAt) });
      renderDevices();
      break;
    }
  }
}

async function testRally(peerId) {
  try {
    await peers.send(peerId, { type: 'ping', sentAt: performance.now() });
  } catch (err) {
    toast(`Couldn't reach ${deviceName(peerId)} (${err.message})`);
  }
}

function syncPeers() {
  const others = state.devices.filter((d) => d.id !== state.you?.id);
  peers.syncDevices(state.devices, { eager: others.length <= EAGER_LINK_LIMIT });
}

// Full snapshot after joining a court.
socket.on('court:state', ({ court, you, devices, text }) => {
  if (state.court && state.court.id !== court.id) peers.closeAll(); // moved courts
  state.court = court;
  state.you = you;
  state.devices = devices;
  state.text = text;
  textSync.reset(text);
  syncPeers();
  render();
});

// Someone arrived or left.
socket.on('court:devices', (devices) => {
  state.devices = devices;
  syncPeers();
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

  renderDevices();
  renderTextMeta();
}

const ROUTE_LABELS = {
  host: 'direct on your network',
  srflx: 'direct via STUN',
  prflx: 'direct via STUN',
  relay: 'relayed through TURN',
};

function linkLabel(link) {
  switch (link?.state) {
    case 'connecting':
      return 'Linking…';
    case 'reconnecting':
      return 'Link interrupted, retrying…';
    case 'connected':
      return `Linked · ${ROUTE_LABELS[link.route] ?? 'peer-to-peer'}${link.rtt != null ? ` · ${link.rtt} ms return` : ''}`;
    case 'failed':
      return "Couldn't link directly (this network may need a TURN server)";
    default:
      return 'Not linked yet';
  }
}

function renderDevices() {
  const others = state.devices.filter((d) => d.id !== state.you?.id);
  $('#device-count').textContent = String(state.devices.length);
  $('#devices-empty').hidden = others.length > 0;

  $('#device-list').replaceChildren(
    ...others.map((d) => {
      const li = el('li', { className: 'device' });
      // textContent (never innerHTML) for anything that came over the network.
      const info = el('div', { className: 'device__info' });
      info.append(el('strong', { textContent: displayName(d) }));
      info.append(el('span', { className: 'muted device__link', textContent: linkLabel(state.links.get(d.id)) }));

      const ping = el('button', { type: 'button', textContent: 'Test rally' });
      ping.addEventListener('click', () => testRally(d.id));

      li.append(info, ping);
      return li;
    }),
  );
}

// ---- Small DOM helpers ------------------------------------------------------

function el(tag, props = {}) {
  return Object.assign(document.createElement(tag), props);
}

function toast(text) {
  const t = el('div', { className: 'toast', textContent: text });
  $('#toasts').append(t);
  setTimeout(() => t.remove(), 4000);
}

function rtcLog(text) {
  const time = new Date().toLocaleTimeString([], { hour12: false });
  const list = $('#rtc-log');
  list.append(el('li', { textContent: `${time}  ${text}` }));
  while (list.children.length > 200) list.firstChild.remove();
}
