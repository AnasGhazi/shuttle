# Build log: phase by phase

Each phase is its own git commit, so you can check out any phase and run it:

```bash
git log --oneline            # find the phase
git checkout <commit>        # run that phase
git checkout main            # back to the latest
```

**Two-device setup used in every checklist.** Run the server on your laptop.
Open `http://localhost:3000` on the laptop and the "other devices" URL the
server prints (e.g. `http://192.168.1.20:3000`) on your phone, on the same
Wi-Fi. Both devices have private LAN addresses, so they land on the shared
`lan` court. If the phone can't load the page, your laptop firewall is
probably blocking port 3000 for Node.

---

## Phase 1: setup, court IDs, presence

**What:** Express + Socket.IO server; `src/courtId.js` turns an IP into a
court ID; devices join a Socket.IO room per court; presence lives in Redis.

**Why this way:**
- `courtId.js` is pure (no I/O), so it's easy to test thoroughly. It decides
  who can see whose data, so it deserves the tests.
- Presence is a Redis **sorted set** scored by last-seen time, with a 20 s
  heartbeat, so a crashed server instance can't leave ghost devices behind.
- Device identity is a random token in `sessionStorage`. The server uses
  `sha256(token)` as the public ID, so peers can't impersonate each other.
  If two sockets share a token (a reload or a duplicated tab), the newest
  wins and the old tab picks a new identity.
- The client IP comes from `proxy-addr` with an explicit trust setting, the
  same logic as Express's `req.ip`. `X-Forwarded-For` is only believed from
  proxies you list.

**Run it:**
```bash
npm install
docker compose up -d redis      # or: brew install redis && redis-server
npm test                        # unit tests + integration tests (if Redis is up)
npm run dev                     # restarts on file changes
```

**Two-device checklist:**
- [ ] Laptop at `http://localhost:3000` shows "Local network", 1 player.
- [ ] Phone at `http://<laptop-ip>:3000` joins: both show 2 players.
- [ ] Close the phone tab: the laptop drops to 1 within a second or two.
- [ ] Reload the phone: it comes back with the **same** device ID.
- [ ] Stop Redis and restart the server: it exits with "Is Redis running?".

---

## Phase 2: shared text and the Redis adapter

**What:** live text syncing stored in `shuttle:court:{id}:text` (30-min TTL,
reset on every edit), plus `@socket.io/redis-adapter` so several server
instances behave like one.

**Why this way:**
- **Versioned writes.** A tiny Lua script (`store.js`) saves the text and
  bumps a version number in one atomic step. Clients ignore anything older
  than what they have, and hold remote updates while you're typing
  (`public/js/textSync.js`). Without this, two people typing at once end up
  each looking at the *other* person's text.
- **Acks with timeouts.** The sender learns its version through a Socket.IO
  acknowledgement. `socket.timeout(5000)` makes sure the callback runs even if
  the connection drops.
- **Adapter.** Every `io.to(room).emit()` is also published on Redis, so a
  phone on instance A and a laptop on instance B still see each other. One
  gotcha this surfaced: adapter operations like `disconnectSockets()` are
  async across the cluster, which is why the handshake uses
  `.except(socket.id)`.

**Run it:**
```bash
npm test                               # includes a two-instance test
npm run dev
# Optional: watch Redis while you type
docker compose exec redis redis-cli monitor
docker compose exec redis redis-cli --scan --pattern 'shuttle:*'
```

**Two-device checklist:**
- [ ] Type on the phone: the laptop updates within half a second.
- [ ] Type on both at once, then stop: both show the same final text.
- [ ] Reload either device: the text is still there.
- [ ] "Served by … · clears in 30 min" shows under the box.
- [ ] `redis-cli ttl "shuttle:court:{lan}:text"` shows about 1800 and
      resets when you type.
- [ ] Multi-instance: `PORT=3001 npm start` in a second terminal, open
      `:3000` on one device and `:3001` on the other. They still share text.

---

## Phase 3: WebRTC signaling and a peer-to-peer link

**What:** the server relays `rtc:signal` messages (offer, answer, ICE
candidates) between devices **on the same court only**. In the browser,
`public/js/rtc.js` sets up an `RTCPeerConnection` with a `control` data
channel. A "Test rally" button sends a ping over it and shows the round trip.

**Why this way:**
- **No glare.** The device with the smaller ID always sends the offer. The
  other side sends a `connect-request` when it wants a link.
- **Generations.** Every attempt has a random `pcId`. Late candidates from an
  abandoned attempt are ignored instead of breaking the new one.
- **Candidate parking.** ICE candidates can arrive before the offer/answer is
  applied, and `addIceCandidate()` would throw. They wait in a queue.
- **ICE servers from the backend** (`GET /api/rtc-config`), so adding TURN is
  a config change, not a code change.
- **Eager on small courts.** With 6 or fewer peers, links form as soon as
  someone joins, so the first file starts instantly. On big courts they form
  on demand.

**Run it:**
```bash
npm test
npm run dev
```

**Two-device checklist:**
- [ ] Within a few seconds each device shows the other as
      "Linked · direct on your network".
- [ ] Tap **Test rally** on the phone: the laptop shows a toast, and the
      phone shows "· N ms return" (single-digit to tens of ms on Wi-Fi).
- [ ] Open **Under the net** to watch the offer → candidates → answer →
      connected sequence.
- [ ] Reload one device: the link drops, then comes back on its own.
- [ ] Stop the server (Ctrl+C) *after* linking, then press **Test rally**: it
      still works. The data channel doesn't go through the server.
- [ ] On a phone using mobile data (not Wi-Fi), with a court code from Phase 5,
      you may see "direct via STUN" or a failure; the failure is the case TURN
      solves (Phase 6).

Verified here in real browsers: Chromium↔Chromium, Chromium↔WebKit (Safari's
engine) and WebKit↔WebKit, including reconnecting after a reload.

---

## Phase 4: chunked file transfer

**What:** `public/js/transfer.js`. Offer → accept/decline → a dedicated
`file:<id>` data channel → 64 KB chunks → Blob → download link → receipt.
Serve to one device (its **Serve file** button) or everyone (**Serve a file
to everyone**, or drop files on the page).

**Why this way:**
- **Accept before anything moves.** The offer is a few bytes of JSON on the
  control channel. The file isn't read until the receiver accepts.
- **A data channel per file.** Chunks need no headers, and transfers can run
  in parallel. Opening extra channels on a live connection needs no
  renegotiation.
- **Backpressure.** `send()` only queues. We pause above 4 MB queued and resume
  on `bufferedamountlow` (threshold 1 MB). Verified: a 300 MB send peaked at
  4.06 MB queued.
- **The sender closes file channels.** The close and the `file-received` /
  `file-cancel` message travel on different channels, so a receiver-side close
  could overtake them. WebKit then throws on the next `send()`. The receiver
  just stops listening.
- **Received files live in memory** until saved, so incoming files are capped
  at 2 GiB (`MAX_FILE_BYTES`). Streaming to disk is a possible upgrade (see
  the README).

**Run it:**
```bash
npm run dev
```

**Two-device checklist:**
- [ ] Phone: **Serve file** next to the laptop, pick a photo. The laptop shows
      "wants to serve you this file" with Accept / Decline.
- [ ] Accept: both progress bars move, then the phone shows "Returned ✓" and the
      laptop shows **Save file** plus an image preview.
- [ ] Saved file opens correctly (try a large video, 500 MB or more, for
      backpressure).
- [ ] Decline: the sender shows "Declined".
- [ ] Cancel halfway from either side: both sides show "Cancelled", and
      **Test rally** still works afterwards.
- [ ] Three devices: **Serve a file to everyone**. Each receiver
      accepts or declines separately.
- [ ] Close the receiver's tab mid-transfer: the sender shows Failed/Cancelled
      instead of hanging.

Verified here: 50 MB byte-identical (SHA-256) Chromium↔Chromium,
Chromium→WebKit and WebKit→Chromium; decline, empty file, cancel mid-transfer,
serve to everyone with 3 devices.

---

## Phase 5: court codes, device names, and the badminton theme

**What:**
- **Names** like "Swift Racket" (`src/names.js`), kept per device in Redis
  and unique within a court.
- **Private courts.** **Make a private court** creates `code:<random id>` and a
  4-digit code (`shuttle:code:<1234>`). Anyone who enters the code, or opens
  the share link `/?code=1234`, joins from any network.
- **Theme.** Court-green header with white court lines, rounded cards, a
  shuttlecock that flies along an arc on every serve and return, dark mode,
  and two columns on wide screens.

**Why this way:**
- **Codes are `SET NX EX`.** A code can't be handed to two courts at once.
  Heartbeats refresh its TTL, so it stays valid while anyone is on the
  court and expires 30 minutes after the last player leaves.
- **Brute-force guard.** Only 10,000 codes exist, so wrong guesses are capped
  at 10 per minute per *network* (per device would be useless: tokens are free).
- **Rejoin safety.** A tab remembers `{code, courtId}`. If the code has since
  been reused by someone else, the IDs won't match and you get "expired"
  instead of silently joining strangers.
- **The arc** is a sampled parabola fed to the Web Animations API, rotated
  along its tangent so the cork leads (`public/js/shuttle.js`). It's skipped
  when the OS asks for reduced motion.

**Run it:**
```bash
npm test
npm run dev
```

**Two-device checklist:**
- [ ] Each device shows a badminton name in the header, and the other device
      lists it under **Players**.
- [ ] Fresh court: "Nothing on the court yet. Serve something!"
- [ ] Laptop: **Make a private court** shows 4 big digits. Phone: type them
      under **Have a code?** Both now show "Private court 1234".
- [ ] Turn the phone's Wi-Fi off (mobile data) and repeat: the code still
      brings them together (the dual-stack / different-network fix).
- [ ] **Share link** opens the share sheet on the phone, or copies the link on a laptop.
      Opening the link joins directly.
- [ ] A wrong code says so; 10+ wrong codes in a minute shows the rate limit.
- [ ] Reload while on a private court: you stay on it.
- [ ] Serve text or a file: the shuttle arcs away from you and toward the
      other device.
- [ ] Turn on "Reduce motion" (iOS: Settings → Accessibility → Motion): no
      arc.
