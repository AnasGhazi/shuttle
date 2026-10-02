// Live text syncing for the court's shared text box.
//
// The rules that keep every device showing the same text:
//
//   1. Every save gets a version number from the server (always increasing).
//   2. We remember the highest version we've seen and ignore anything older.
//   3. While *we* have unsaved typing, remote updates are parked rather than
//      applied (so your words don't vanish under your cursor). When our own
//      save comes back, we compare versions: if someone saved after us, their
//      parked text wins. Otherwise ours does. Every device ends up on the
//      newest save: the same one that's in Redis.

const DEBOUNCE_MS = 300;

export function createTextSync({ socket, textarea, onRemoteText, onSaved, onError }) {
  let version = 0; // newest version this device has seen
  let timer = null; // pending debounced save
  let inFlight = 0; // saves sent but not yet acknowledged
  let parked = null; // newest remote update that arrived while we were typing

  const busy = () => timer !== null || inFlight > 0;

  function apply(update) {
    version = update.version;
    if (textarea.value !== update.text) {
      // Keep the caret roughly where it was if this box is focused.
      const focused = document.activeElement === textarea;
      const { selectionStart, selectionEnd } = textarea;
      textarea.value = update.text;
      if (focused) textarea.setSelectionRange(selectionStart, selectionEnd);
    }
    onRemoteText?.(update);
  }

  function save() {
    timer = null;
    const text = textarea.value;
    inFlight += 1;
    // The last argument is a Socket.IO "acknowledgement": the server calls it
    // with its reply, like a tiny request/response over the socket.
    // `.timeout()` guarantees the callback runs even if the connection drops
    // (then with an error); a plain ack would just never fire.
    socket.timeout(5000).emit('text:update', { text }, (err, ack) => {
      inFlight -= 1;
      if (err || ack?.error) {
        onError?.(err ? 'timeout' : ack.error);
      } else {
        version = Math.max(version, ack.version);
        onSaved?.({ text, version: ack.version, expiresAt: ack.expiresAt });
      }
      if (!busy() && parked) {
        if (parked.version > version) apply(parked);
        parked = null;
      }
    });
  }

  textarea.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(save, DEBOUNCE_MS);
  });

  socket.on('text:changed', (update) => {
    if (update.version <= version) return; // stale: we already have newer
    if (busy()) {
      if (!parked || update.version > parked.version) parked = update;
      return;
    }
    apply(update);
  });

  return {
    /** Snapshot from court:state (joining, or rejoining after a reconnect). */
    reset(text) {
      parked = null;
      if (timer !== null) {
        // We have unsent typing (e.g. we went offline mid-sentence): keep it
        // and let the pending save go out.
        version = text.version;
        return;
      }
      // A new court, or the text expired: take the server's word for it,
      // even if its version is lower than ours.
      version = -1;
      apply(text);
    },
    /** Replace the text locally and save immediately (e.g. the Clear button). */
    set(value) {
      textarea.value = value;
      clearTimeout(timer);
      save();
    },
  };
}
