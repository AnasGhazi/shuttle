// =============================================================================
//  transfer.js: downloading files from other devices over WebRTC
// =============================================================================
//
//  Files on the court are listed by the server (just their details). The
//  bytes stay in the owner's browser until someone asks for them:
//
//      Downloader                               Owner (has the File)
//      ----------                               --------------------
//      control: file-request {id, fileId}  ───►  looks up fileId
//                                          ◄───  control: file-unavailable {id}
//                                                (if it's gone, or not for you)
//                                                otherwise:
//      ondatachannel (label file:<id>) ◄════════ createDataChannel('file:<id>')
//      collect chunks, count bytes     ◄════════ chunk, chunk, chunk ... (binary)
//      all bytes in -> Blob -> save
//      control: file-received {id}         ───►  "delivered"
//
//  Either side can send file-cancel {id} at any time.
//
//  Why a channel per download? Every message on 'file:<id>' belongs to that
//  download, so chunks need no headers, and several downloads (from several
//  people at once, even of the same file) can run in parallel. Data channels
//  added to an already-connected RTCPeerConnection open without another
//  offer/answer round.
// =============================================================================

// 64 KB is the widely safe message size: every browser can send and receive
// it. Bigger messages can fail between different browsers.
const CHUNK_SIZE = 64 * 1024;

// Backpressure thresholds. channel.send() never blocks: it just appends to
// an in-memory queue (channel.bufferedAmount). We stop reading the file when
// the queue passes HIGH and resume when the browser says it drained to LOW.
const BUFFER_HIGH = 4 * 1024 * 1024;
const BUFFER_LOW = 1 * 1024 * 1024;

// A download is held in memory until you save it.
export const MAX_FILE_BYTES = 2 * 1024 * 1024 * 1024; // 2 GiB

// How long to wait for the owner to start sending before giving up.
const REQUEST_TIMEOUT_MS = 20_000;
const PROGRESS_INTERVAL_MS = 100;
const ID_RE = /^[a-z0-9]{8,32}$/;

export const randomId = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => (b % 36).toString(36)).join('');

/** Wait for a one-off DOM event, failing if `failEvent` fires first. */
function once(target, event, failEvent) {
  return new Promise((resolve, reject) => {
    const ok = () => {
      cleanup();
      resolve();
    };
    const bad = () => {
      cleanup();
      reject(new Error(`channel ${failEvent}`));
    };
    const cleanup = () => {
      target.removeEventListener(event, ok);
      if (failEvent) target.removeEventListener(failEvent, bad);
    };
    target.addEventListener(event, ok);
    if (failEvent) target.addEventListener(failEvent, bad);
  });
}

/**
 * @param peers       the peer manager from rtc.js
 * @param getUpload   (fileId, peerId) -> File | null: a file we're serving,
 *                    if that peer is allowed to have it
 * @param onUpdate    (transfer) -> void, whenever a transfer changes
 * @param onComplete  (transfer) -> void, when a download has fully arrived
 */
export function createTransfers({ peers, getUpload, onUpdate, onComplete }) {
  /**
   * id -> transfer:
   * {
   *   id, fileId, peerId, direction: 'in' | 'out',
   *   name, size, mime,
   *   state: 'requested'  (in: asked the owner, waiting for it to start)
   *        | 'receiving' | 'sending'
   *        | 'confirming' (out: all sent, waiting for their "received")
   *        | 'done' | 'cancelled' | 'failed',
   *   bytes, startedAt, url (in, once done), error,
   * }
   */
  const transfers = new Map();
  const files = new Map(); // id -> File, for outgoing transfers
  const channels = new Map(); // id -> RTCDataChannel while active
  const lastEmit = new Map(); // id -> time of last progress update

  function update(t, { progressOnly = false } = {}) {
    // Progress can change thousands of times a second; the UI only needs ~10.
    if (progressOnly) {
      const now = performance.now();
      if (now - (lastEmit.get(t.id) ?? 0) < PROGRESS_INTERVAL_MS) return;
      lastEmit.set(t.id, now);
    }
    onUpdate?.(t);
  }

  const isActive = (t) => ['requested', 'receiving', 'sending', 'confirming'].includes(t.state);

  function finish(t, state, error) {
    t.state = state;
    if (error) t.error = error;
    files.delete(t.id);
    const channel = channels.get(t.id);
    channels.delete(t.id);
    if (channel && channel.readyState !== 'closed') {
      if (t.direction === 'out') {
        channel.close();
      } else {
        // The *sender* closes file channels. If the receiver closed it, the
        // close could overtake its file-received / file-cancel message (they
        // travel on different channels) and the sender would either report a
        // failure or try to send into a closed stream. So the receiver only
        // stops listening, and closes later as a fallback.
        channel.onmessage = null;
        setTimeout(() => channel.readyState !== 'closed' && channel.close(), 5000);
      }
    }
    update(t);
  }

  // ---------------------------------------------------------------------------
  //  Downloading (the side that pressed Download)
  // ---------------------------------------------------------------------------

  /** Ask `peerId` for one of the files it serves. `entry` is from the court list. */
  function download(peerId, entry) {
    const t = {
      id: randomId(),
      fileId: entry.id,
      peerId,
      direction: 'in',
      name: entry.name,
      size: entry.size,
      mime: entry.mime || '',
      state: 'requested',
      bytes: 0,
      startedAt: performance.now(),
    };
    transfers.set(t.id, t);
    update(t);

    if (t.size > MAX_FILE_BYTES) {
      finish(t, 'failed', 'too large for a browser tab');
      return t;
    }
    peers.send(peerId, { type: 'file-request', id: t.id, fileId: entry.id }).catch((err) => {
      if (isActive(t)) finish(t, 'failed', `couldn't reach them (${err.message})`);
    });
    setTimeout(() => {
      if (t.state === 'requested') finish(t, 'failed', 'no answer');
    }, REQUEST_TIMEOUT_MS);
    return t;
  }

  /** A data channel the other side opened: is it one of our downloads? */
  function handleChannel(peerId, channel) {
    const id = channel.label.startsWith('file:') ? channel.label.slice(5) : null;
    const t = id && transfers.get(id);
    if (!t || t.direction !== 'in' || t.peerId !== peerId || t.state !== 'requested') {
      channel.close(); // not something we asked for
      return;
    }
    t.state = 'receiving';
    t.startedAt = performance.now();
    update(t);
    channels.set(id, channel);
    channel.binaryType = 'arraybuffer';

    const chunks = [];
    let received = 0;

    const complete = () => {
      // Glue the chunks back together. A Blob can be made from many pieces
      // without copying them into one big buffer first.
      const blob = new Blob(chunks, { type: t.mime || 'application/octet-stream' });
      chunks.length = 0;
      t.url = URL.createObjectURL(blob);
      t.bytes = t.size;
      finish(t, 'done');
      peers.send(peerId, { type: 'file-received', id }).catch(() => {});
      onComplete?.(t);
    };

    channel.onmessage = ({ data }) => {
      if (t.state !== 'receiving' || !(data instanceof ArrayBuffer)) return;
      chunks.push(data);
      received += data.byteLength;
      if (received > t.size) {
        finish(t, 'failed', 'received more data than announced');
        peers.send(peerId, { type: 'file-cancel', id }).catch(() => {});
        return;
      }
      t.bytes = received;
      update(t, { progressOnly: true });
      if (received === t.size) complete();
    };
    channel.onclose = () => {
      if (t.state === 'receiving') finish(t, 'failed', 'connection closed');
    };
    // An empty file has no chunks: it's complete as soon as the channel opens.
    if (t.size === 0) {
      if (channel.readyState === 'open') complete();
      else channel.onopen = complete;
    }
  }

  // ---------------------------------------------------------------------------
  //  Sending (the owner, answering a request)
  // ---------------------------------------------------------------------------

  async function startSending(t) {
    const file = files.get(t.id);
    if (!file) return;

    try {
      const peer = await peers.connect(t.peerId);

      // A brand-new channel just for this download. 'ordered' (the default)
      // means chunks arrive in the order we sent them, so the receiver can
      // simply append them.
      const channel = peer.pc.createDataChannel(`file:${t.id}`, { ordered: true });
      channel.binaryType = 'arraybuffer';
      channels.set(t.id, channel);
      channel.addEventListener('close', () => {
        if (t.state === 'sending' || t.state === 'confirming') finish(t, 'failed', 'connection closed');
      });
      if (channel.readyState !== 'open') await once(channel, 'open', 'close');

      // The connection's SCTP transport tells us the largest message the
      // other side accepts. Use it if it's smaller than our default.
      const max = peer.pc.sctp?.maxMessageSize;
      const chunkSize = max && max < CHUNK_SIZE ? max : CHUNK_SIZE;

      // Fire 'bufferedamountlow' when the queue drains to BUFFER_LOW.
      channel.bufferedAmountLowThreshold = BUFFER_LOW;

      let offset = 0;
      while (offset < file.size) {
        if (t.state !== 'sending') return; // cancelled or failed meanwhile

        // ---- Backpressure ----
        // Too much queued? Wait for the browser to push some out first.
        // Without this, a big file would be read into memory all at once.
        if (channel.bufferedAmount > BUFFER_HIGH) {
          await once(channel, 'bufferedamountlow', 'close');
          continue;
        }

        // Read only the next chunk from disk (File is a Blob; slice is lazy).
        const chunk = await file.slice(offset, offset + chunkSize).arrayBuffer();
        if (t.state !== 'sending') return;
        // The receiver may have just cancelled; its file-cancel message can
        // still be on the way. Stop quietly; the 'close' handler cleans up.
        if (channel.readyState !== 'open') return;
        channel.send(chunk);
        offset += chunk.byteLength;

        // "Sent" = handed to the network, not just queued locally.
        t.bytes = offset - channel.bufferedAmount;
        update(t, { progressOnly: true });
      }

      // Let the queue drain so the bar honestly reaches 100%.
      while (channel.bufferedAmount > 0 && t.state === 'sending') {
        t.bytes = file.size - channel.bufferedAmount;
        update(t, { progressOnly: true });
        await new Promise((r) => setTimeout(r, 50));
      }
      if (t.state !== 'sending') return;
      t.bytes = file.size;
      t.state = 'confirming'; // waiting for their file-received
      update(t);
    } catch (err) {
      if (isActive(t)) finish(t, 'failed', err.message);
    }
  }

  // ---------------------------------------------------------------------------
  //  Control messages from the other side
  // ---------------------------------------------------------------------------

  function handleMessage(peerId, msg) {
    if (typeof msg.id !== 'string' || !ID_RE.test(msg.id)) return;
    const t = transfers.get(msg.id);

    switch (msg.type) {
      case 'file-request': {
        if (t) return; // duplicate
        const file = typeof msg.fileId === 'string' ? getUpload(msg.fileId, peerId) : null;
        if (!file) {
          peers.send(peerId, { type: 'file-unavailable', id: msg.id }).catch(() => {});
          return;
        }
        const out = {
          id: msg.id,
          fileId: msg.fileId,
          peerId,
          direction: 'out',
          name: file.name,
          size: file.size,
          mime: file.type,
          state: 'sending',
          bytes: 0,
          startedAt: performance.now(),
        };
        transfers.set(out.id, out);
        files.set(out.id, file);
        update(out);
        startSending(out);
        return;
      }
      // The rest only make sense for a transfer with this exact peer.
      case 'file-unavailable':
        if (t?.peerId === peerId && t.state === 'requested') finish(t, 'failed', 'no longer available');
        return;
      case 'file-received':
        if (t?.peerId === peerId && t.direction === 'out') {
          // Their receipt can beat our own "buffer drained" bookkeeping on a
          // small file, so it is the moment the bar reaches 100%.
          t.bytes = t.size;
          finish(t, 'done');
        }
        return;
      case 'file-cancel':
        if (t?.peerId === peerId && isActive(t)) finish(t, 'cancelled', 'they cancelled');
        return;
    }
  }

  /** Cancel a transfer from our side. */
  function cancel(id) {
    const t = transfers.get(id);
    if (!t || !isActive(t)) return;
    finish(t, 'cancelled');
    peers.send(t.peerId, { type: 'file-cancel', id }).catch(() => {});
  }

  /** Stop every outgoing transfer of a file we stopped serving. */
  function cancelUploads(fileId) {
    for (const t of transfers.values()) if (t.direction === 'out' && t.fileId === fileId) cancel(t.id);
  }

  /** A device left the court: anything still running with it is over. */
  function peerGone(peerId) {
    for (const t of transfers.values()) {
      if (t.peerId === peerId && isActive(t)) finish(t, 'cancelled', 'they left the court');
    }
  }

  /** Forget a finished download (and free its memory). */
  function dismiss(id) {
    const t = transfers.get(id);
    if (!t || isActive(t)) return;
    if (t.url) URL.revokeObjectURL(t.url);
    transfers.delete(id);
    lastEmit.delete(id);
    onUpdate?.(null);
  }

  /** The newest download of a court file, if any. */
  function downloadOf(fileId) {
    let latest = null;
    for (const t of transfers.values()) if (t.direction === 'in' && t.fileId === fileId) latest = t;
    return latest;
  }

  return {
    download,
    cancel,
    cancelUploads,
    dismiss,
    peerGone,
    handleMessage,
    handleChannel,
    downloadOf,
    list: () => [...transfers.values()],
  };
}
