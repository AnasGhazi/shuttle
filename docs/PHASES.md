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
