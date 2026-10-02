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
import { createTransfers, randomId, MAX_FILE_BYTES } from './transfer.js';
import { flyShuttle } from './shuttle.js';

const $ = (sel) => document.querySelector(sel);

const state = {
  you: null, // { id, name }
  court: null, // { id, kind: 'network' | 'lan' | 'solo' | 'code', label, code? }
  devices: [], // [{ id, name, session }], including ourselves
  text: null, // { by, updatedAt, expiresAt } of the latest save
  links: new Map(), // peerId -> { state, route, rtt } for the WebRTC link
  files: [], // files on the court: [{ id, name, size, mime, owner, to, servedAt }]
};

// Names of everyone we've seen, so a downloaded file can still say who it
// came from after they leave.
const knownNames = new Map();

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
socket.on('court:state', ({ court, you, devices, text, files }) => {
  if (state.court && state.court.id !== court.id) {
    peers.closeAll(); // moved courts: links to the old court's devices go
    state.links.clear();
    stopServingAll(); // your files were offered to the old court only
  }
  state.court = court;
  state.you = you;
  rememberNames(devices);
  state.devices = devices;
  state.text = text;
  state.files = files ?? [];
  saveCourt(court);
  textSync.reset(text);
  syncPeers();
  reconcileUploads();
  applyPreferredName();
  render();
});

// Someone arrived, left, or renamed themselves.
socket.on('court:devices', (devices) => {
  rememberNames(devices);
  state.devices = devices;
  const me = devices.find((d) => d.id === state.you?.id);
  if (me?.name && state.you) state.you.name = me.name;
  syncPeers();
  render();
});

// The court's file list changed (someone served or removed a file, or left).
socket.on('files:changed', (files) => {
  const before = new Set(state.files.map((f) => f.id));
  state.files = files;
  for (const f of files) {
    if (!before.has(f.id) && f.owner !== state.you?.id) {
      toast(`${deviceName(f.owner)} served ${f.name}${f.to ? ' to you' : ''}`);
      flyShuttle('return');
    }
  }
  renderShelf();
  renderEmptyState();
});

function rememberNames(devices) {
  for (const d of devices) if (d.name) knownNames.set(d.id, d.name);
}

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

const transfers = createTransfers({
  peers,
  // Someone asked for a file: hand it over if we serve it and they may have it.
  getUpload: (fileId, peerId) => {
    const upload = uploads.get(fileId);
    if (!upload || (upload.to && upload.to !== peerId)) return null;
    return upload.file;
  },
  onUpdate: () => renderShelf(),
  onComplete: (t) => {
    flyShuttle('return');
    saveDownload(t);
  },
});

function handlePeerMessage(peerId, msg) {
  if (typeof msg.type === 'string' && msg.type.startsWith('file-')) {
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

// ---- Serving files ------------------------------------------------------------
//
// Files you drop (or browse to) wait in the drop zone ("staged") until you
// choose who gets them: Broadcast = everyone, Send to one device = pick one.
// Pressing either with nothing staged opens the file picker first.
//
// Serving puts the file "on the court": the server lists its name and size
// for everyone (or just the one device), and each of them can download it
// from this browser whenever they like. The file never goes to the server,
// so it's only downloadable while this tab stays open.

const uploads = new Map(); // fileId -> { file, to } for files this tab serves

const FILE_ERRORS = {
  'too-large': 'is too large to serve (2 GB max)',
  'court-full': "couldn't be served: the court already has 50 files",
  'not-on-court': "couldn't be served: that device left the court",
};

function publish(id) {
  const { file, to } = uploads.get(id);
  return request('files:add', { id, name: file.name, size: file.size, mime: file.type, to: to ?? undefined });
}

/** After (re)joining: re-list files this tab still has, drop ones it doesn't. */
function reconcileUploads() {
  const mine = new Set(state.files.filter((f) => f.owner === state.you?.id).map((f) => f.id));
  for (const id of uploads.keys()) {
    if (!mine.has(id)) {
      publish(id).then((ack) => {
        if (ack?.error) stopServing(id);
      });
    }
  }
  // Listed under our name but not in this tab (e.g. from before a reload).
  for (const id of mine) if (!uploads.has(id)) request('files:remove', { id });
}

function stopServing(id) {
  uploads.delete(id);
  transfers.cancelUploads(id);
  request('files:remove', { id });
}

function stopServingAll() {
  for (const id of [...uploads.keys()]) {
    uploads.delete(id);
    transfers.cancelUploads(id);
  }
}

/** Save a finished download to the device (the browser's normal download). */
function saveDownload(t) {
  const a = el('a', { href: t.url, download: t.name });
  document.body.append(a);
  a.click();
  a.remove();
}

let staged = []; // File objects waiting to be served
let afterPick = null; // after the file picker closes: null = just stage, 'all', or a device id
const fileInput = $('#file-input');

function openFilePicker(then) {
  afterPick = then;
  fileInput.value = ''; // so picking the same file twice still fires 'change'
  fileInput.click(); // must run inside the click handler, or iOS ignores it
}

fileInput.addEventListener('change', () => {
  const files = [...fileInput.files];
  if (files.length === 0) return;
  if (afterPick === null) stageFiles(files);
  else serveFiles(files, afterPick === 'all' ? null : afterPick);
  afterPick = null;
});

function stageFiles(files) {
  staged.push(...files);
  renderStaged();
}

function unstage(index) {
  staged.splice(index, 1);
  renderStaged();
}

async function serveFiles(files, target) {
  if (files.length === 0) return;
  flyShuttle('serve');
  for (const file of files) {
    if (file.size > MAX_FILE_BYTES) {
      toast(`${file.name} ${FILE_ERRORS['too-large']}`);
      continue;
    }
    const id = randomId();
    uploads.set(id, { file, to: target });
    const ack = await publish(id);
    if (ack?.error) {
      uploads.delete(id);
      toast(`${file.name} ${FILE_ERRORS[ack.error] ?? "couldn't be served"}`);
    }
  }
}

/**
 * Serve the staged files (or pick some first) to one device, or to the whole
 * court (target null). Court files wait for anyone who joins later, too.
 */
function serveTo(target) {
  closePicker();
  if (target && !otherDevices().some((d) => d.id === target)) return toast('That device left the court.');
  if (staged.length === 0) return openFilePicker(target ?? 'all');
  serveFiles(staged, target);
  staged = [];
  renderStaged();
}

$('#broadcast').addEventListener('click', () => serveTo(null));

$('#send-one').addEventListener('click', () => {
  const others = otherDevices();
  if (others.length === 0) return toast('No one else is on the court yet.');
  if (others.length === 1) return serveTo(others[0].id); // nobody to choose between
  $('#picker').hidden ? openPicker() : closePicker();
});

function openPicker() {
  $('#picker-list').replaceChildren(
    ...otherDevices().map((d) => button(displayName(d), () => serveTo(d.id), 'btn btn--outline btn--small')),
  );
  $('#picker').hidden = false;
  $('#send-one').setAttribute('aria-expanded', 'true');
}

function closePicker() {
  $('#picker').hidden = true;
  $('#send-one').setAttribute('aria-expanded', 'false');
}

// The drop zone: click anywhere in it (or the link) to browse, or drop files.
const dropzone = $('#dropzone');
dropzone.addEventListener('click', (e) => {
  if (e.target.closest('.staged__remove')) return;
  openFilePicker(null);
});
dropzone.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    openFilePicker(null);
  }
});

// Files dropped anywhere on the page are staged; the zone lights up while
// something is dragged over it.
document.addEventListener('dragover', (e) => {
  if (!e.dataTransfer?.types.includes('Files')) return;
  e.preventDefault();
  dropzone.classList.toggle('dropzone--over', dropzone.contains(e.target));
});
document.addEventListener('dragleave', (e) => {
  if (!e.relatedTarget) dropzone.classList.remove('dropzone--over');
});
document.addEventListener('drop', (e) => {
  dropzone.classList.remove('dropzone--over');
  if (!e.dataTransfer?.files.length) return;
  e.preventDefault();
  stageFiles([...e.dataTransfer.files]);
});

// ---- Naming yourself -------------------------------------------------------------
//
// Tap your name to change it. The choice is remembered in this browser
// (localStorage), so new tabs and later visits use it too.

const NAME_KEY = 'shuttle.name';
const NAME_ERRORS = {
  'name-taken': 'Someone on this court already has that name.',
  'bad-name': 'Names need 1 to 32 characters.',
};

function preferredName() {
  try {
    return localStorage.getItem(NAME_KEY);
  } catch {
    return null;
  }
}

function applyPreferredName() {
  const name = preferredName();
  if (!name || name === state.you?.name) return;
  request('device:rename', { name }).then((ack) => {
    if (ack?.ok && state.you) {
      state.you.name = ack.name;
      renderHeader();
    }
  });
}

const renameForm = $('#rename-form');
const renameInput = $('#rename-input');

function showRename(open) {
  renameForm.hidden = !open;
  $('#you-name').hidden = open;
  if (open) {
    renameInput.value = state.you?.name ?? '';
    renameInput.focus();
    renameInput.select();
  }
}

$('#you-name').addEventListener('click', () => showRename(true));
$('#rename-cancel').addEventListener('click', () => showRename(false));
renameInput.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') showRename(false);
});
renameForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const ack = await request('device:rename', { name: renameInput.value });
  if (ack?.error) return toast(NAME_ERRORS[ack.error] ?? "Couldn't change your name.");
  state.you.name = ack.name;
  try {
    localStorage.setItem(NAME_KEY, ack.name);
  } catch {
    // Private mode etc.: the name still applies to this session.
  }
  showRename(false);
  renderHeader();
});

// ---- Players pill ----------------------------------------------------------------

$('#players-toggle').addEventListener('click', () => {
  const panel = $('#players-panel');
  panel.hidden = !panel.hidden;
  $('#players-toggle').setAttribute('aria-expanded', String(!panel.hidden));
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
  const d = state.devices.find((x) => x.id === id);
  return d ? displayName(d) : knownNames.get(id) ?? 'someone';
}

function initials(name) {
  return name.split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();
}

// The players pill doubles as the connection indicator: a cork-yellow dot
// while connected, grey while (re)connecting.
let connection = { online: false, text: 'Connecting…' };
function setStatus(kind, text) {
  connection = { online: kind === 'online', text };
  renderStatusPill();
}

function renderStatusPill() {
  $('#players-toggle').className = `status-pill${connection.online ? '' : ' status-pill--offline'}`;
  $('#players-label').textContent = connection.online && state.court ? `Players · ${state.devices.length}` : connection.text;
}

function render() {
  renderHeader();
  renderCourt();
  renderPlayers();
  renderCodeCard();
  renderShelf();
}

function renderHeader() {
  $('#court-label').textContent = state.court?.label ?? 'Finding your court…';
  $('#you-name').textContent = state.you?.name ?? '…';
  $('#you-name').setAttribute('aria-label', `Your name: ${state.you?.name ?? ''}. Change it`);
  renderStatusPill();
}

// The line under the buttons: the empty-court invitation, or a reminder of
// how files travel once something is happening.
function renderEmptyState() {
  const empty = !textarea.value && state.files.length === 0 && transfers.list().length === 0 && staged.length === 0;
  $('#hint').textContent = empty
    ? 'Nothing on the court yet. Serve something!'
    : 'Files fly device to device and never touch the server.';
}

function renderStaged() {
  const list = $('#staged-list');
  list.hidden = staged.length === 0;
  $('#drop-title').textContent =
    staged.length === 0 ? 'Drop files to serve' : `${staged.length} file${staged.length > 1 ? 's' : ''} ready to serve`;
  list.replaceChildren(
    ...staged.map((file, i) => {
      const li = el('li', { className: 'staged__item' });
      const remove = button('×', () => unstage(i), 'staged__remove');
      remove.setAttribute('aria-label', `Remove ${file.name}`);
      li.append(
        el('span', { className: 'staged__name', textContent: file.name, title: file.name }),
        el('span', { className: 'staged__size', textContent: formatBytes(file.size) }),
        remove,
      );
      return li;
    }),
  );
  renderEmptyState();
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
  $('#devices-empty').hidden = others.length > 0;
  if (!$('#picker').hidden) openPicker(); // keep the device picker current

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
        button('Send file', () => serveTo(d.id), 'btn btn--primary btn--small'),
        button('Test rally', () => testRally(d.id), 'btn btn--outline btn--small'),
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

function progress(t) {
  const pct = t.size ? Math.floor((t.bytes / t.size) * 100) : 100;
  const seconds = (performance.now() - t.startedAt) / 1000;
  const speed = seconds > 0.5 && t.bytes ? ` · ${formatBytes(t.bytes / seconds)}/s` : '';
  return `${pct}%${speed}`;
}

function progressBar(t) {
  const bar = el('div', { className: 'bar', role: 'progressbar' });
  const pct = t.size ? (t.bytes / t.size) * 100 : 100;
  bar.setAttribute('aria-valuenow', String(Math.round(pct)));
  const fill = el('div', { className: 'bar__fill' });
  fill.style.width = `${pct}%`;
  bar.append(fill);
  return bar;
}

/**
 * The court's files. Everyone's served files are listed with a Download
 * button; your own show who's downloading them. Files you downloaded stay
 * listed (to save again) even after their owner leaves.
 */
function renderShelf() {
  const me = state.you?.id;
  const entries = [...state.files].reverse(); // newest first
  const listed = new Set(entries.map((f) => f.id));
  const kept = new Map();
  for (const t of transfers.list()) {
    if (t.direction === 'in' && t.state === 'done' && !listed.has(t.fileId)) {
      kept.set(t.fileId, { id: t.fileId, name: t.name, size: t.size, mime: t.mime, owner: t.peerId, gone: true });
    }
  }
  const all = [...entries, ...kept.values()];
  $('#shelf').hidden = all.length === 0;
  $('#file-list').replaceChildren(...all.map((f) => (f.owner === me ? renderOwnFile(f) : renderCourtFile(f))));
}

function fileTitle(f, who) {
  const title = el('div', { className: 'transfer__title' });
  title.append(
    el('span', { className: 'transfer__dir', textContent: f.owner === state.you?.id ? '↗' : '↙' }),
    el('span', { className: 'transfer__name', textContent: f.name }),
    el('span', { className: 'transfer__meta', textContent: `${formatBytes(f.size)} · ${who}` }),
  );
  return title;
}

/** A file someone else served: Download it, watch it arrive, save it. */
function renderCourtFile(f) {
  const owner = deviceName(f.owner);
  const who = f.gone ? `from ${owner}, who left the court` : f.to ? `from ${owner}, just for you` : `served by ${owner}`;
  const t = transfers.downloadOf(f.id);
  const li = el('li', { className: `transfer transfer--${t?.state ?? 'new'}` });
  const status = el('div', { className: 'transfer__status' });
  const actions = el('div', { className: 'transfer__actions' });
  li.append(fileTitle(f, who));

  if (!t) {
    actions.append(button('Download', () => transfers.download(f.owner, f), 'btn btn--primary btn--small'));
  } else if (t.state === 'requested') {
    status.textContent = `Asking ${owner} to send it…`;
    actions.append(button('Cancel', () => transfers.cancel(t.id), 'btn btn--outline btn--small'));
  } else if (t.state === 'receiving') {
    li.append(progressBar(t));
    status.textContent = `Downloading… ${progress(t)}`;
    actions.append(button('Cancel', () => transfers.cancel(t.id), 'btn btn--outline btn--small'));
  } else if (t.state === 'done') {
    status.textContent = 'Downloaded ✓';
    // A blob: URL plus the `download` attribute saves it under its name.
    actions.append(el('a', { href: t.url, download: t.name, className: 'btn btn--outline btn--small', textContent: 'Save again' }));
    if (f.gone) actions.append(button('Remove', () => transfers.dismiss(t.id), 'link-btn'));
  } else {
    status.textContent = `${t.state === 'cancelled' ? 'Cancelled' : 'Failed'}${t.error ? ` (${t.error})` : ''}`;
    if (!f.gone) actions.append(button('Try again', () => transfers.download(f.owner, f), 'btn btn--primary btn--small'));
  }

  if (status.textContent) li.append(status);
  li.append(actions);
  if (t?.state === 'done' && t.mime.startsWith('image/')) {
    li.append(el('img', { src: t.url, alt: t.name, className: 'transfer__preview' }));
  }
  return li;
}

/** A file you served: who's downloading it, and a way to take it back. */
function renderOwnFile(f) {
  const who = f.to ? `just for ${deviceName(f.to)}` : 'served by you';
  const li = el('li', { className: 'transfer' });
  li.append(fileTitle(f, who));

  const sends = transfers.list().filter((t) => t.direction === 'out' && t.fileId === f.id);
  const lines = el('div', { className: 'transfer__lines' });
  for (const t of sends.filter((x) => x.state === 'sending' || x.state === 'confirming')) {
    lines.append(
      progressBar(t),
      el('div', { className: 'transfer__status', textContent: `Sending to ${deviceName(t.peerId)}… ${progress(t)}` }),
    );
  }
  const delivered = new Set(sends.filter((t) => t.state === 'done').map((t) => t.peerId));
  const summary = delivered.size
    ? `Downloaded by ${[...delivered].map(deviceName).join(', ')}`
    : 'Waiting for someone to download it. Keep this tab open.';
  lines.append(el('div', { className: 'transfer__status', textContent: summary }));
  li.append(lines);

  const actions = el('div', { className: 'transfer__actions' });
  actions.append(button('Remove from court', () => stopServing(f.id), 'link-btn'));
  li.append(actions);
  return li;
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
