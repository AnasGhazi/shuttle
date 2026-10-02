// =============================================================================
//  transfer.js: sending files over WebRTC data channels
// =============================================================================
//
//  The conversation for one file (control = the JSON 'control' channel):
//
//      Sender                                   Receiver
//      ------                                   --------
//      control: file-offer {id,name,size,mime} ─►  shows Accept / Decline
//                                           ◄─ control: file-accept {id}
//      createDataChannel('file:<id>')  ════════►  ondatachannel (label file:<id>)
//      chunk, chunk, chunk ... (binary)  ══════►  collect chunks, count bytes
//                                                  all bytes in -> Blob -> link
//                                           ◄─ control: file-received {id}
//      "Returned!"
//
//  Either side can send file-cancel {id} at any time. A decline is
//  file-decline {id}.
//
//  Why a channel per file? Every message on 'file:<id>' belongs to that file,
//  so chunks need no headers, and several files can be in flight at once.
//  Data channels added to an already-connected RTCPeerConnection open without
//  another offer/answer round.
// =============================================================================

// 64 KB is the widely safe message size: every browser can send and receive
// it. Bigger messages can fail between different browsers.
const CHUNK_SIZE = 64 * 1024;

// Backpressure thresholds. channel.send() never blocks: it just appends to
// an in-memory queue (channel.bufferedAmount). We stop reading the file when
// the queue passes HIGH and resume when the browser says it drained to LOW.
const BUFFER_HIGH = 4 * 1024 * 1024;
const BUFFER_LOW = 1 * 1024 * 1024;

// The received file is held in memory until you download it.
export const MAX_FILE_BYTES = 2 * 1024 * 1024 * 1024; // 2 GiB

const PROGRESS_INTERVAL_MS = 100;

const randomId = () => Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(36)).join('').slice(0, 12);

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
 * @param peers     the peer manager from rtc.js
 * @param onUpdate  (transfer) -> void, whenever a transfer changes
 */
export function createTransfers({ peers, onUpdate }) {
  /**
   * id -> transfer:
   * {
   *   id, peerId, direction: 'out' | 'in',
   *   name, size, mime,
   *   state: 'offered'   (in: waiting for you to accept)
   *        | 'waiting'   (out: waiting for them to accept)
   *        | 'sending' | 'receiving'
   *        | 'confirming' (out: all sent, waiting for their "received")
   *        | 'done' | 'declined' | 'cancelled' | 'failed',
   *   bytes,      // progress so far
   *   startedAt,  // for the speed readout
   *   url,        // in: blob: URL to download, once done
   *   error,
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
        // stops listening and closes later as a fallback.
        channel.onmessage = null;
        setTimeout(() => channel.readyState !== 'closed' && channel.close(), 5000);
      }
    }
    update(t);
  }

  const isActive = (t) => ['offered', 'waiting', 'sending', 'receiving', 'confirming'].includes(t.state);

  // ---------------------------------------------------------------------------
  //  Sending
  // ---------------------------------------------------------------------------

  /** Offer a file to one device. The transfer starts when they accept. */
  async function sendFile(peerId, file) {
    const t = {
      id: randomId(),
      peerId,
      direction: 'out',
      name: file.name,
      size: file.size,
      mime: file.type,
      state: 'waiting',
      bytes: 0,
      startedAt: null,
    };
    transfers.set(t.id, t);
    files.set(t.id, file);
    update(t);
    try {
      await peers.send(peerId, { type: 'file-offer', id: t.id, name: t.name, size: t.size, mime: t.mime });
    } catch (err) {
      finish(t, 'failed', `couldn't reach them (${err.message})`);
    }
    return t;
  }

  async function startSending(t) {
    const file = files.get(t.id);
    if (!file) return;
    t.state = 'sending';
    t.startedAt = performance.now();
    update(t);

    try {
      const peer = await peers.connect(t.peerId);

      // A brand-new channel just for this file. 'ordered' (the default)
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
        // The receiver may have just cancelled and closed the channel; its
        // file-cancel message can still be on the way. Stop quietly: the
        // channel's 'close' handler marks the transfer as failed/cancelled.
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
  //  Receiving
  // ---------------------------------------------------------------------------

  function accept(id) {
    const t = transfers.get(id);
    if (!t || t.state !== 'offered') return;
    t.state = 'receiving';
    t.startedAt = performance.now();
    update(t);
    peers.send(t.peerId, { type: 'file-accept', id }).catch((err) => finish(t, 'failed', err.message));
  }

  function decline(id) {
    const t = transfers.get(id);
    if (!t || t.state !== 'offered') return;
    finish(t, 'declined');
    peers.send(t.peerId, { type: 'file-decline', id }).catch(() => {});
  }

  /** A data channel the other side opened: is it one of our accepted files? */
  function handleChannel(peerId, channel) {
    const id = channel.label.startsWith('file:') ? channel.label.slice(5) : null;
    const t = id && transfers.get(id);
    if (!t || t.direction !== 'in' || t.peerId !== peerId || t.state !== 'receiving') {
      channel.close(); // not something we agreed to
      return;
    }
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
    };

    channel.onmessage = ({ data }) => {
      if (t.state !== 'receiving') return;
      if (!(data instanceof ArrayBuffer)) return;
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
  //  Control messages from the other side
  // ---------------------------------------------------------------------------

  function handleMessage(peerId, msg) {
    const t = transfers.get(msg.id);

    switch (msg.type) {
      case 'file-offer': {
        if (transfers.has(msg.id) || typeof msg.id !== 'string' || msg.id.length > 32) return;
        const size = Number(msg.size);
        const incoming = {
          id: msg.id,
          peerId,
          direction: 'in',
          // Names come from another device: keep them short and path-free.
          name: String(msg.name || 'file').replace(/[\\/]/g, '_').slice(0, 200),
          size,
          mime: typeof msg.mime === 'string' ? msg.mime.slice(0, 100) : '',
          state: 'offered',
          bytes: 0,
          startedAt: null,
        };
        transfers.set(incoming.id, incoming);
        if (!Number.isSafeInteger(size) || size < 0) {
          finish(incoming, 'failed', 'invalid file size');
          return;
        }
        if (size > MAX_FILE_BYTES) {
          finish(incoming, 'declined', 'too large for a browser tab');
          peers.send(peerId, { type: 'file-decline', id: msg.id, reason: 'too-large' }).catch(() => {});
          return;
        }
        update(incoming);
        return;
      }

      // The rest only make sense for a transfer with this exact peer.
      case 'file-accept':
        if (t?.peerId === peerId && t.direction === 'out' && t.state === 'waiting') startSending(t);
        return;
      case 'file-decline':
        if (t?.peerId === peerId && t.direction === 'out' && t.state === 'waiting') {
          finish(t, 'declined', msg.reason === 'too-large' ? 'too large for their browser' : undefined);
        }
        return;
      case 'file-received':
        // Their receipt can beat our own "buffer drained" bookkeeping on a
        // small file, so it is the moment the bar reaches 100%.
        if (t?.peerId === peerId && t.direction === 'out') {
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

  /** A device left the court: anything still pending with it is over. */
  function peerGone(peerId) {
    for (const t of transfers.values()) {
      if (t.peerId === peerId && isActive(t)) finish(t, 'cancelled', 'they left the court');
    }
  }

  /** Remove a finished transfer from the list (and free its memory). */
  function dismiss(id) {
    const t = transfers.get(id);
    if (!t || isActive(t)) return;
    if (t.url) URL.revokeObjectURL(t.url);
    transfers.delete(id);
    lastEmit.delete(id);
    onUpdate?.(null);
  }

  return {
    sendFile,
    accept,
    decline,
    cancel,
    dismiss,
    peerGone,
    handleMessage,
    handleChannel,
    list: () => [...transfers.values()],
  };
}
