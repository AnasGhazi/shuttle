# 🏸 Shuttle

Serve text and files between devices on the same Wi-Fi. No login, no
install: open the site on two devices and they're on the same **court**.

- **Text** is synced live through the server and kept in Redis for 30
  minutes after the last edit.
- **Files** are served *to the court*: everyone on it sees the file and can
  download it, straight from the device that served it, over WebRTC. The
  server only lists the file's name and size; it never sees the file. A file
  stays downloadable while its owner keeps Shuttle open.
- **Court codes** (4 digits) join devices that aren't grouped
  automatically: different networks, or IPv4 vs IPv6 on the same Wi-Fi.

Sharing is a **serve**, the room is **the court**, receiving is a **return**.

## Quick start

```bash
npm install
npm run redis                  # terminal 1: local Redis (needs redis-server on your PATH)
npm run dev                    # terminal 2: http://localhost:3000
npm test                       # unit + integration tests (integration needs Redis)
```

No Redis yet? `brew install redis` works on most Macs. On a macOS version
too new for Homebrew's prebuilt packages, build it from source in a minute:
`curl -LO https://download.redis.io/redis-stable.tar.gz && tar xzf redis-stable.tar.gz && make -C redis-stable -j8`
and copy `redis-stable/src/redis-server` and `redis-cli` onto your PATH.
If you already use Docker: `docker compose up -d redis`.

The server prints a LAN address such as `http://192.168.1.20:3000`. Open it
on your phone (same Wi-Fi) and both devices appear on the "Local network
court". Every device on your LAN shares that court in development.

Requirements: Node.js 22+, Redis 7+.

## How it works

```
 Phone                         Server (Node + Socket.IO)              Laptop
   │  socket.io: join ───────────►  IP ──► court ID  ◄────── join  │
   │                               presence, text ⇄ Redis           │
   │  text:update ───────────────►  store + broadcast ──► text:changed
   │  rtc:signal (offer) ────────►  relay (same court only) ──────► │
   │  ◄────────────────────────────  relay ◄──── rtc:signal (answer)│
   │                                                                │
   │◄═══════════ WebRTC data channel: file chunks, direct ═════════►│
```

### Courts from IP addresses (`src/courtId.js`)

Devices on one Wi-Fi share their router's public IP, so the server uses it
as the court ID:

| Client address | Court |
|---|---|
| `203.0.113.7` | `ip4:203.0.113.7` |
| `2001:db8:abcd:12:a:b:c:d` | `ip6:2001:db8:abcd:12::/64` (each IPv6 device has its own address, but a network shares the /64 prefix) |
| `::ffff:203.0.113.7` (IPv4-mapped) | `ip4:203.0.113.7` |
| private / loopback / link-local | `lan` (the server is on your own network) |
| malformed | a court of its own; use a code |

The client IP comes from the socket address, or from `X-Forwarded-For`
**only when it was added by a trusted proxy** (`TRUST_PROXY`, see
[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)).

### Redis keys (`src/store.js`)

| Key | Type | TTL | Holds |
|---|---|---|---|
| `shuttle:court:{<courtId>}:devices` | sorted set, score = last seen | 2 min, refreshed | presence |
| `shuttle:court:{<courtId>}:text` | hash `{text, by, updatedAt, version}` | 30 min after last edit | shared text |
| `shuttle:court:{<courtId>}:files` | hash fileId → JSON `{name, size, mime, owner, to}` | 6 h (entries leave with their owner) | files on the court (details only) |
| `shuttle:device:<deviceId>` | hash `{name, session}` | 24 h | device name (random, or one you chose) |
| `shuttle:code:<1234>` | string → courtId | 30 min after the last player leaves | court codes |
| `shuttle:ratelimit:code:<networkCourtId>` | counter | 60 s | wrong-code guesses |

`{braces}` are a Redis Cluster hash tag that keeps one court's keys
together. Presence is scored by time so a crashed instance can't leave ghost
devices behind. Text writes go through a Lua script that hands out
increasing versions, so simultaneous edits converge.

### WebRTC (`public/js/rtc.js`, `public/js/transfer.js`)

- The device with the smaller ID always sends the offer (no "glare").
- Each connection attempt has an ID, so late ICE candidates from an old
  attempt are ignored. Candidates that arrive early are queued.
- A `control` data channel carries JSON (pings, file requests). Each
  download gets its own `file:<id>` channel.
- Serving lists a file's details on the court (`files:add`, stored in
  `shuttle:court:{id}:files`). Pressing **Download** sends the owner a
  `file-request`; the owner streams it back. Nothing moves until someone asks.
- Files go in 64 KB chunks. The sender pauses when more than 4 MB is
  queued (`bufferedAmount`) and resumes on `bufferedamountlow`, so large
  files don't exhaust memory. Chunks are reassembled into a `Blob` and saved.

Open **Under the net** on the page to watch the signaling happen live.

## The dual-stack problem, and options for it

On a dual-stack network one device may reach the server over IPv4 (court
`ip4:…`) and another over IPv6 (court `ip6:…/64`). Same Wi-Fi, different
courts. Shared-IP mobile networks (carrier-grade NAT) cause the opposite
problem: strangers share a court.

1. **Court codes** *(built)*. Make a private court and type its 4-digit code
   (or open its share link) on the other device. Works for every case,
   including different networks entirely.
2. **Serve Shuttle over IPv4 only** *(simplest automatic fix)*. Publish only an
   `A` DNS record (no `AAAA`), and every browser connects over IPv4, so
   dual-stack devices land on the same court. You give up IPv6, which costs
   very little for this app. (IPv6-only mobile networks still reach you
   through their carrier's NAT64, but they wouldn't share a court with home
   Wi-Fi anyway.)
3. **Link the two addresses** *(most automatic, most work)*. Serve two extra
   hostnames, `v4.example.com` (A record only) and `v6.example.com` (AAAA
   only). The page fetches a tiny signed "this is your address" token from
   each, then presents both tokens when joining. The server stores a
   short-lived Redis mapping `ip6 prefix ↔ ip4 address` and treats the pair as
   one court. Costs: CORS, TLS certificates for the extra names, and care
   with prefixes that change.
4. **Not worth it:** grouping by a shorter IPv6 prefix (/56 or /48) doesn't
   fix dual-stack and merges neighbours. WebRTC's local addresses are
   hidden behind mDNS names now, and web pages can't read the Wi-Fi network
   name.

A QR code of the share link would be a nice addition to (1) for
phone-to-laptop use.

## Privacy and limits

- Everyone behind the same public IP shares a court: a café, an office, a
  university, or a mobile carrier's NAT. Text on a network court is visible
  to all of them (as with AirForShare). Files always need the receiver's
  approval. Use a private court for anything sensitive.
- Received files are held in memory until saved, so incoming files are
  capped at 2 GiB. Streaming straight to disk (File System Access API) would
  lift that.
- Court codes are only 4 digits. Wrong guesses are capped at 10 per minute
  per network, and codes expire 30 minutes after the court empties.

## Project layout

```
src/
  index.js          entry point: start, log LAN URLs, graceful shutdown
  createServer.js   Express + Socket.IO + Redis adapter, HTTP routes
  realtime.js       socket events: identity, courts, text, codes, signaling
  courtId.js        IP -> court ID (pure, unit tested)
  clientIp.js       client IP behind trusted proxies
  store.js          every Redis key and command
  names.js          "Swift Racket"-style device names
  ice.js            STUN/TURN list, time-limited TURN credentials
  config.js         environment variables
public/
  index.html, css/style.css, favicon.svg
  js/app.js         UI wiring
  js/rtc.js         RTCPeerConnection management (heavily commented)
  js/transfer.js    chunked file transfer with backpressure
  js/textSync.js    versioned live text
  js/shuttle.js     the shuttlecock arc animation
  js/identity.js    per-tab device token
test/               node:test unit + integration tests
docs/PHASES.md      the build, phase by phase, with test checklists
docs/DEPLOYMENT.md  env vars, proxies, hosted Redis, scaling, TURN
```

## Deploying

Quickest: push to GitHub, then in Render choose **New → Blueprint** and
pick the repo. [render.yaml](render.yaml) creates the web service and its
Redis together. No Docker needed on your machine.

Full guide: [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md). In short: set `REDIS_URL`, set
`TRUST_PROXY` for your host and check it at `/api/whoami`, serve over
HTTPS, enable sticky sessions if you run several instances, and add TURN
if devices on different networks can't connect.
