// =============================================================================
//  app.js: wires the page together
// =============================================================================
//
//   Socket.IO (to our server)     court membership, device list, shared text,
//                                 court codes, and WebRTC signaling
//   rtc.js (peer to peer)         direct links between devices
//   transfer.js (peer to peer)    files over those links
//   textSync.js                   conflict-free shared text box
//   shuttle.js                    the shuttlecock flight animation
// =============================================================================

import { getDeviceToken, rotateDeviceToken } from './identity.js';
import { createTextSync } from './textSync.js';
import { createPeerManager } from './rtc.js';
import { createTransfers } from './transfer.js';
import { flyShuttle } from './shuttle.js';

const $ = (sel) => document.querySelector(sel);

const state = {
  you: null, // { id, name }
  court: null, // { id, kind: 'network' | 'lan' | 'solo' | 'code', label, code? }
  devices: [], // [{ id, name, session }], including ourselves
  text: null, // { by, updatedAt, expiresAt } of the latest save
  links: new Map(), // peerId -> { state, route, rtt } for the WebRTC link
};

// Connect to everyone eagerly on small courts so the first file is instant.
// On a big court (a whole office behind one IP) connect only when needed.
const EAGER_LINK_LIMIT = 6;

// Animate a "serve" for text only when it starts a new rally, not on every
// debounced keystroke save.
const TEXT_RALLY_GAP_MS = 4000;

// STUN/TURN servers come from the backend (see src/config.js). Fetched
// before the socket exists so no signal can arrive before we're ready.
const { iceServers } = await fetch('/api/rtc-config')
  .then((r) => r.json())
  .catch(() => ({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] }));

// =============================================================================
//  Court codes: remembering which court to (re)join
// =============================================================================
//
// A private court is remembered per tab (sessionStorage), so a reload or a
// Wi-Fi blip puts you back on the same court. A share link (?code=1234)
// takes priority on first load.

const COURT_KEY = 'shuttle.court';

function savedCourt() {
  try {
    return JSON.parse(sessionStorage.getItem(COURT_KEY)) ?? null;
  } catch {
    return null;
  }
}
function saveCourt(court) {
  if (court?.kind === 'code') sessionStorage.setItem(COURT_KEY, JSON.stringify({ code: court.code, courtId: court.id }));
  else sessionStorage.removeItem(COURT_KEY);
}

// Read ?code=1234 once, then tidy the URL so a reload doesn't re-use it.
const params = new URLSearchParams(location.search);
const linkCode = params.get('code');
if (linkCode) {
  params.delete('code');
  history.replaceState(null, '', location.pathname + (params.size ? `?${params}` : ''));
}

const CODE_ERRORS = {
  'bad-code': 'Court codes are 4 digits.',
  'code-not-found': 'No court with that code. Check the digits?',
  'code-expired': 'That court code has expired. Make a new one?',
  'rate-limited': 'Too many wrong codes from this network. Wait a minute and try again.',
  timeout: 'The server took too long to answer. Try again.',
  'server-error': 'Something went wrong on our side. Try again.',
};

function showCodeError(code) {
  const el = $('#code-error');
  el.textContent = code ? CODE_ERRORS[code] ?? 'Something went wrong.' : '';
  el.hidden = !code;
}

/** Emit with an acknowledgement, as a promise (rejects on timeout). */
function request(event, payload) {
  return new Promise((resolve) => {
    socket.timeout(8000).emit(event, payload, (err, ack) => resolve(err ? { error: 'timeout' } : ack));
  });
}

/**
 * Join a court by code (or the network court when `code` is null).
 * `fallback`: if the code doesn't work, join the network court instead.
 * Used on (re)connect, when the server has us on no court at all; when you
 * type a wrong code by hand you simply stay where you are.
 */
async function joinCourt(code, { expectedCourtId, fallback = false } = {}) {
  const ack = await request('court:join', code ? { code, courtId: expectedCourtId } : {});
  if (ack?.error && code) {
    showCodeError(ack.error);
    if (fallback) {
      sessionStorage.removeItem(COURT_KEY);
      await request('court:join', {});
    }
  } else {
    showCodeError(null);
  }
  return ack;
}

// =============================================================================
//  Socket.IO connection
// =============================================================================

// `io` is the global from /socket.io/socket.io.js.
// `auth` is a function so a reconnect always sends the *current* token.
const socket = io({
  auth: (cb) => cb({ deviceToken: getDeviceToken() }),
  // Tell the server right away when the tab closes, instead of it waiting
  // for a ping timeout. Peers then see us leave immediately.
  closeOnBeforeunload: true,
});

let firstConnect = true;
socket.on('connect', () => {
  setStatus('online', 'On court');
  // (Re)join our court. Sent on every reconnect too: the server forgets
  // which rooms a socket was in when it disconnects.
  const saved = savedCourt();
  if (firstConnect && linkCode) joinCourt(linkCode, { fallback: true });
  else if (saved) joinCourt(saved.code, { expectedCourtId: saved.courtId, fallback: true });
  else joinCourt(null);
  firstConnect = false;
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
socket.on('court:state', ({ court, you, devices, text }) => {
  if (state.court && state.court.id !== court.id) {
    peers.closeAll(); // moved courts: links to the old court's devices go
    state.links.clear();
  }
  state.court = court;
  state.you = you;
  state.devices = devices;
  state.text = text;
  saveCourt(court);
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

// =============================================================================
//  Shared text
// =============================================================================

const textarea = $('#court-text');
let lastLocalSave = 0;
let lastRemoteText = 0;

const textSync = createTextSync({
  socket,
  textarea,
  onRemoteText: (update) => {
    state.text = update;
    const now = Date.now();
    if (update.text && now - lastRemoteText > TEXT_RALLY_GAP_MS) flyShuttle('return');
    lastRemoteText = now;
    renderCourt();
  },
  onSaved: (saved) => {
    state.text = { ...saved, by: state.you?.id, updatedAt: Date.now() };
    const now = Date.now();
    if (saved.text && now - lastLocalSave > TEXT_RALLY_GAP_MS) flyShuttle('serve');
    lastLocalSave = now;
    renderCourt();
  },
  onError: (code) => {
    $('#text-meta').textContent = code === 'text-too-long' ? 'Too long to serve.' : 'Not saved yet, will retry as you type.';
  },
});

textarea.addEventListener('input', renderEmptyState);

$('#clear-text').addEventListener('click', () => {
  textSync.set('');
  renderCourt();
});
$('#copy-text').addEventListener('click', async () => {
  if (!textarea.value) return;
  await copyText(textarea.value);
  flash($('#copy-text'), 'Copied!');
});

// Refresh "clears in N min" now and then.
setInterval(renderCourt, 30_000);

// =============================================================================
//  Peer-to-peer links and file transfers
// =============================================================================

// Open Shuttle with ?relay=1 to force every link through your TURN server.
const relayOnly = new URLSearchParams(location.search).has('relay');
if (relayOnly) rtcLog('relay-only mode: links will use TURN or fail');

const peers = createPeerManager({
  socket,
  iceServers,
  relayOnly,
  getMyId: () => state.you?.id,
  onState: (peerId, { state: linkState, route }) => {
    const prev = state.links.get(peerId) ?? {};
    state.links.set(peerId, { ...prev, state: linkState, route });
    renderPlayers();
  },
  onMessage: (peerId, msg) => handlePeerMessage(peerId, msg),
  onChannel: (peerId, channel) => transfers.handleChannel(peerId, channel),
  log: rtcLog,
});

const transfers = createTransfers({ peers, onUpdate: () => renderRallies() });

function handlePeerMessage(peerId, msg) {
  if (typeof msg.type === 'string' && msg.type.startsWith('file-')) {
    if (msg.type === 'file-offer') {
      toast(`${deviceName(peerId)} is serving you a file`);
      flyShuttle('return');
    }
    transfers.handleMessage(peerId, msg);
    return;
  }
  switch (msg.type) {
    // The data channel test: answer a ping straight back with a pong.
    case 'ping':
      flyShuttle('return');
      toast(`🏸 ${deviceName(peerId)} sent a test rally over WebRTC`);
      peers.send(peerId, { type: 'pong', sentAt: msg.sentAt }).catch(() => {});
      break;
    case 'pong': {
      const link = state.links.get(peerId) ?? {};
      state.links.set(peerId, { ...link, rtt: Math.round(performance.now() - msg.sentAt) });
      renderPlayers();
      break;
    }
  }
}

async function testRally(peerId) {
  flyShuttle('serve');
  try {
    await peers.send(peerId, { type: 'ping', sentAt: performance.now() });
  } catch (err) {
    toast(`Couldn't reach ${deviceName(peerId)} (${err.message})`);
  }
}

function syncPeers() {
  const others = otherDevices();
  peers.syncDevices(state.devices, { eager: others.length <= EAGER_LINK_LIMIT });
  for (const t of transfers.list()) {
    if (!others.some((d) => d.id === t.peerId)) transfers.peerGone(t.peerId);
  }
}

// One hidden <input type=file> for every "serve" button; we remember who
// the files are for (one device id, or null for everyone).
let serveTarget = null;
const fileInput = $('#file-input');

function pickFiles(target) {
  serveTarget = target;
  fileInput.value = ''; // so picking the same file twice still fires 'change'
  fileInput.click();
}

function serveFiles(files, target) {
  const targets = target ? [target] : otherDevices().map((d) => d.id);
  if (files.length === 0) return;
  if (targets.length === 0) return toast('No one else is on the court yet.');
  flyShuttle('serve');
  // "Everyone" is simply one transfer per device, each accepted separately.
  for (const file of files) for (const peerId of targets) transfers.sendFile(peerId, file);
}

fileInput.addEventListener('change', () => serveFiles([...fileInput.files], serveTarget));
$('#serve-all').addEventListener('click', () => pickFiles(null));

// Drag and drop anywhere on the page serves to everyone.
document.addEventListener('dragover', (e) => {
  if (e.dataTransfer?.types.includes('Files')) e.preventDefault();
});
document.addEventListener('drop', (e) => {
  if (!e.dataTransfer?.files.length) return;
  e.preventDefault();
  serveFiles([...e.dataTransfer.files], null);
});

// =============================================================================
//  Private court controls
// =============================================================================

$('#create-code').addEventListener('click', async () => {
  const createBtn = $('#create-code');
  createBtn.disabled = true;
  const ack = await request('court:create', {});
  createBtn.disabled = false;
  if (ack?.error) return showCodeError(ack.error);
  showCodeError(null);
  toast(`Private court ${ack.code} is ready. Share the code!`);
});

const codeInput = $('#code-input');
codeInput.addEventListener('input', () => {
  codeInput.value = codeInput.value.replace(/\D/g, '').slice(0, 4);
});
$('#join-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const ack = await joinCourt(codeInput.value);
  if (!ack?.error) codeInput.value = '';
});

$('#leave-code').addEventListener('click', () => {
  sessionStorage.removeItem(COURT_KEY);
  joinCourt(null);
});

$('#share-code').addEventListener('click', async () => {
  const { code } = state.court ?? {};
  if (!code) return;
  const url = `${location.origin}/?code=${code}`;
  // The native share sheet on phones; otherwise copy the link.
  if (navigator.share) {
    try {
      await navigator.share({ title: 'Join my Shuttle court', text: `Court code ${code}`, url });
      return;
    } catch (err) {
      if (err.name === 'AbortError') return; // user closed the share sheet
    }
  }
  await copyText(url);
  flash($('#share-code'), 'Link copied!');
});

// =============================================================================
//  Rendering
// =============================================================================

function otherDevices() {
  return state.devices.filter((d) => d.id !== state.you?.id);
}

function displayName(device) {
  return device?.name || `Device ${device?.id.slice(0, 4) ?? ''}`;
}

function deviceName(id) {
  return displayName(state.devices.find((d) => d.id === id)) || 'someone';
}

function initials(name) {
  return name.split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();
}

function setStatus(kind, text) {
  $('#conn-status').className = `status status--${kind}`;
  $('#conn-status .status__text').textContent = text;
}

function render() {
  renderHeader();
  renderCourt();
  renderPlayers();
  renderCodeCard();
  renderRallies();
}

function renderHeader() {
  $('#court-label').textContent = state.court?.label ?? 'Finding your court…';
  $('#you-name').textContent = state.you?.name ?? '…';
  const n = state.devices.length;
  $('#player-summary').textContent = n <= 1 ? 'Just you on court' : `${n} players on court`;
}

function renderEmptyState() {
  $('#empty-state').hidden = Boolean(textarea.value) || transfers.list().length > 0;
}

function renderCourt() {
  renderEmptyState();
  const t = state.text;
  const meta = $('#text-meta');
  if (!t?.expiresAt || !textarea.value) {
    meta.textContent = '';
    return;
  }
  const mins = Math.max(1, Math.round((t.expiresAt - Date.now()) / 60_000));
  const who = t.by === state.you?.id ? 'you' : deviceName(t.by);
  meta.textContent = `Served by ${who} · clears in ${mins} min`;
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
      return ['Linking…', ''];
    case 'reconnecting':
      return ['Link interrupted, retrying…', ''];
    case 'connected': {
      const rtt = link.rtt != null ? ` · ${link.rtt} ms return` : '';
      return [`Linked, ${ROUTE_LABELS[link.route] ?? 'peer-to-peer'}${rtt}`, 'ok'];
    }
    case 'failed':
      return ["Couldn't link directly (this network may need TURN)", 'bad'];
    default:
      return ['Ready to rally', ''];
  }
}

function renderPlayers() {
  const others = otherDevices();
  $('#device-count').textContent = String(state.devices.length);
  $('#devices-empty').hidden = others.length > 0;

  $('#device-list').replaceChildren(
    ...others.map((d) => {
      const name = displayName(d);
      const li = el('li', { className: 'player' });
      // textContent (never innerHTML) for anything that came over the network.
      const avatar = el('span', { className: 'player__avatar', textContent: initials(name) });
      const [label, tone] = linkLabel(state.links.get(d.id));
      const info = el('div', { className: 'player__info' });
      info.append(
        el('span', { className: 'player__name', textContent: name }),
        el('span', { className: `player__link${tone ? ` player__link--${tone}` : ''}`, textContent: label }),
      );

      const actions = el('div', { className: 'player__actions' });
      actions.append(
        button('Serve file', () => pickFiles(d.id), 'btn btn--primary btn--small'),
        button('Test rally', () => testRally(d.id), 'btn btn--quiet btn--small'),
      );

      li.append(avatar, info, actions);
      return li;
    }),
  );
}

function renderCodeCard() {
  const isPrivate = state.court?.kind === 'code';
  $('#code-network').hidden = isPrivate;
  $('#code-private').hidden = !isPrivate;
  if (isPrivate) {
    $('#code-digits').replaceChildren(...[...state.court.code].map((digit) => el('span', { textContent: digit })));
  }
}

function transferStatus(t) {
  const pct = t.size ? Math.floor((t.bytes / t.size) * 100) : 100;
  const seconds = t.startedAt ? (performance.now() - t.startedAt) / 1000 : 0;
  const speed = seconds > 0.5 && t.bytes ? ` · ${formatBytes(t.bytes / seconds)}/s` : '';
  const why = t.error ? ` (${t.error})` : '';
  switch (t.state) {
    case 'offered':
      return 'is serving you this file. Return it?';
    case 'waiting':
      return 'Waiting for them to accept…';
    case 'sending':
      return `Serving… ${pct}%${speed}`;
    case 'receiving':
      return t.bytes ? `Receiving… ${pct}%${speed}` : 'Accepted, here it comes…';
    case 'confirming':
      return 'Sent, waiting for the return…';
    case 'done':
      return t.direction === 'out' ? 'Returned ✓ They have it.' : 'Received ✓';
    case 'declined':
      return `Declined${why}`;
    case 'cancelled':
      return `Cancelled${why}`;
    default:
      return `Failed${why}`;
  }
}

function renderRallies() {
  const items = transfers.list().reverse(); // newest first
  $('#rallies').hidden = items.length === 0;
  renderEmptyState();

  $('#transfer-list').replaceChildren(
    ...items.map((t) => {
      const li = el('li', { className: `transfer transfer--${t.state}` });
      const who = deviceName(t.peerId);
      const title = el('div', { className: 'transfer__title' });
      title.append(
        el('span', { className: 'transfer__dir', textContent: t.direction === 'out' ? '↗' : '↙' }),
        el('strong', { textContent: t.name }),
        el('span', { className: 'meta', textContent: `${formatBytes(t.size)} · ${t.direction === 'out' ? `to ${who}` : `from ${who}`}` }),
      );

      // Progress bar: an outer track and an inner fill whose width we set.
      const bar = el('div', { className: 'bar', role: 'progressbar' });
      const pct = t.size ? (t.bytes / t.size) * 100 : t.state === 'done' ? 100 : 0;
      bar.setAttribute('aria-valuenow', String(Math.round(pct)));
      const fill = el('div', { className: 'bar__fill' });
      fill.style.width = `${pct}%`;
      bar.append(fill);

      const status = el('div', { className: 'transfer__status', textContent: transferStatus(t) });
      const actions = el('div', { className: 'row' });

      if (t.state === 'offered') {
        actions.append(
          button('Accept', () => transfers.accept(t.id), 'btn btn--primary btn--small'),
          button('Decline', () => transfers.decline(t.id), 'btn btn--small'),
        );
      } else if (['waiting', 'sending', 'receiving', 'confirming'].includes(t.state)) {
        actions.append(button('Cancel', () => transfers.cancel(t.id), 'btn btn--small'));
      } else {
        if (t.direction === 'in' && t.state === 'done') {
          // A blob: URL plus the `download` attribute saves it under its name.
          actions.append(el('a', { href: t.url, download: t.name, className: 'btn btn--primary btn--small', textContent: 'Save file' }));
        }
        actions.append(button('Dismiss', () => transfers.dismiss(t.id), 'btn btn--quiet btn--small'));
      }

      // No bar until bytes can move: before acceptance it would just be noise.
      if (t.state === 'offered' || t.state === 'waiting') li.append(title, status, actions);
      else li.append(title, bar, status, actions);
      if (t.direction === 'in' && t.state === 'done' && t.mime.startsWith('image/')) {
        li.append(el('img', { src: t.url, alt: t.name, className: 'transfer__preview' }));
      }
      return li;
    }),
  );
}

// =============================================================================
//  Small helpers
// =============================================================================

function el(tag, props = {}) {
  return Object.assign(document.createElement(tag), props);
}

function button(label, onClick, className) {
  const b = el('button', { type: 'button', textContent: label, className });
  b.addEventListener('click', onClick);
  return b;
}

function flash(btn, text) {
  const original = btn.textContent;
  btn.textContent = text;
  setTimeout(() => (btn.textContent = original), 1400);
}

function toast(text) {
  const t = el('div', { className: 'toast', textContent: text });
  $('#toasts').append(t);
  setTimeout(() => t.remove(), 4000);
}

async function copyText(text) {
  // The modern Clipboard API only exists on https:// (or localhost). On a
  // plain http://192.168.x.x page we fall back to the old select-and-copy.
  if (navigator.clipboard && window.isSecureContext) {
    return navigator.clipboard.writeText(text);
  }
  const scratch = el('textarea', { value: text });
  scratch.setAttribute('readonly', '');
  scratch.className = 'visually-hidden';
  document.body.append(scratch);
  scratch.select();
  document.execCommand('copy');
  scratch.remove();
}

function formatBytes(n) {
  if (n < 1024) return `${Math.round(n)} B`;
  const units = ['KB', 'MB', 'GB'];
  let i = -1;
  do {
    n /= 1024;
    i += 1;
  } while (n >= 1024 && i < units.length - 1);
  return `${n.toFixed(n < 10 ? 1 : 0)} ${units[i]}`;
}

function rtcLog(text) {
  const time = new Date().toLocaleTimeString([], { hour12: false });
  const list = $('#rtc-log');
  list.append(el('li', { textContent: `${time}  ${text}` }));
  while (list.children.length > 200) list.firstChild.remove();
}
