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
