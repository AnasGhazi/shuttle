# Deploying Shuttle

Shuttle is one Node.js process plus Redis. The server only relays small
messages (presence, text, WebRTC signaling); files go device to device. A
single small instance handles a lot of users.

## Fastest path: Render (free tier, no Docker needed)

1. Push this repo to GitHub.
2. In the Render dashboard: **New → Blueprint**, then pick the repo. The
   [render.yaml](../render.yaml) blueprint creates the `shuttle` web
   service and a `shuttle-redis` Key Value (Redis-compatible) instance in
   the same region, and wires `REDIS_URL` between them.
3. When it's live, open `https://<your-app>.onrender.com/api/whoami` on your
   phone. `ip` must be your real public IP (see "Trusted proxy" below). If it
   shows a Render/Cloudflare address instead, change `TRUST_PROXY` to `2` in
   the service's Environment settings.
4. Open the app on your phone and laptop on the same Wi-Fi. They should land
   on the same court.

Free plan notes: the web service sleeps after about 15 minutes without traffic,
so the first visit afterwards takes about a minute. The free Key Value is
small and not persisted, which suits Shuttle: everything expires anyway.
Every push to `main` redeploys.

Other good fits: Railway (one-click Redis, no free tier) and Fly.io (pair
with Upstash Redis). Both work with the settings below.

## Checklist

1. **Redis 7+** reachable through `REDIS_URL` (TLS: `rediss://`).
2. **`TRUST_PROXY`** set for your platform, then checked with `/api/whoami`.
3. **HTTPS.** Every platform below provides it. Without it, browsers turn off the
   Clipboard API and the share sheet (Shuttle falls back to older methods).
   WebRTC itself works either way.
4. **More than one instance?** Turn on sticky sessions (see below).
5. **Optional: TURN** for networks where devices can't connect directly.
6. Health check path: `/healthz` (returns 503 when Redis is unreachable).

## Environment variables

| Variable | Default | What it does |
|---|---|---|
| `PORT` | `3000` | HTTP port (most platforms set this for you) |
| `HOST` | `0.0.0.0` | Interface to listen on |
| `REDIS_URL` | `redis://localhost:6379` | Redis connection string |
| `TRUST_PROXY` | `false` | Which proxies may set `X-Forwarded-For` (below) |
| `TEXT_TTL_S` | `1800` | Shared text expires this long after the last edit |
| `CODE_TTL_S` | `1800` | Court codes expire this long after the last player leaves |
| `TEXT_MAX_LENGTH` | `50000` | Longest shared text, in characters |
| `PRESENCE_HEARTBEAT_MS` | `20000` | How often each device refreshes its presence |
| `PRESENCE_STALE_MS` | `60000` | Presence older than this is pruned (crash cleanup) |
| `STUN_URLS` | Google's two public STUN servers | Comma-separated STUN URLs |
| `TURN_URL` | unset | Comma-separated TURN URLs; unset = STUN only |
| `TURN_SECRET` | unset | Shared secret for time-limited TURN credentials (recommended) |
| `TURN_TTL_S` | `86400` | Lifetime of each issued TURN credential |
| `TURN_USERNAME` / `TURN_CREDENTIAL` | unset | Static TURN credentials (instead of a secret) |

## Trusted proxy: the setting that decides who shares a court

Courts are built from the client's IP. Behind a proxy or load balancer, the
TCP connection comes from the *proxy*. The real client is in
`X-Forwarded-For: <client>, <proxy1>, ...`. Anyone can send that header, so
Shuttle only believes entries added by proxies you trust (same logic as
Express's `req.ip`, via `proxy-addr`).

| Setup | `TRUST_PROXY` |
|---|---|
| Local dev, no proxy | `false` |
| Render, Railway, Heroku, Fly.io (one platform proxy) | `1` |
| nginx/Caddy on the same machine | `loopback` |
| Cloudflare in front of a platform proxy | `2` |
| Your own load balancers on a private subnet | e.g. `10.0.0.0/8` |
| Anything | **never `true`**: then anyone can pick any court |

**Verify it.** After deploying, open `https://your-app/api/whoami` on your
phone using mobile data and Wi-Fi:

- `ip` should be your real public IP (compare with any "what's my IP" site).
- If it shows a private address like `10.x.x.x` and `courtId: "lan"`, the
  setting is too low: **everyone on the internet would share one court**.
  The server also logs a warning the first time it sees `X-Forwarded-For`
  while `TRUST_PROXY=false`.
- If it changes when you send a fake `X-Forwarded-For` header
  (`curl -H 'X-Forwarded-For: 1.2.3.4' https://your-app/api/whoami`), the
  setting is too high.

## Hosted Redis

Any Redis 7+ works. Shuttle needs normal commands, Lua (`EVAL`), and pub/sub
(for the Socket.IO adapter). Every key has a TTL, so any eviction policy is
fine and memory stays small.

- **Upstash:** copy the `rediss://default:<password>@<host>:6379` URL. Note
  that it bills per command: each connected device costs a heartbeat
  (~2 commands every 20 s), and the adapter adds pub/sub traffic.
- **Redis Cloud, Railway, Render Key Value, Fly (Upstash), AWS ElastiCache:**
  use the provided URL. Use `rediss://` when TLS is on (ElastiCache with
  in-transit encryption, Redis Cloud with TLS).
- Keep Redis in the same region as the app. Each join is several round
  trips.

## Running more than one instance

The Redis adapter (`@socket.io/redis-adapter`) already makes rooms and
broadcasts work across instances. One more requirement: Socket.IO starts
each connection with HTTP long-polling and then upgrades to WebSocket, and
those polling requests must reach the **same instance**. Turn on sticky
sessions (session affinity) on your load balancer. Without them you'll see
connections failing with HTTP 400 "Session ID unknown". If your platform
can't do that, run a single instance; Shuttle's server workload is tiny.

Graceful shutdown is built in. On `SIGTERM` the server disconnects sockets,
removes them from their courts, and closes Redis. Clients reconnect to
another instance automatically.

## Docker (optional)

You don't need Docker to deploy: Render, Railway and Fly build on their own
servers. The Dockerfile is for hosts that want an image, or if you install
Docker yourself (on a Mac it always runs inside a small Linux VM, e.g.
Docker Desktop or Colima).

```bash
docker build -t shuttle .
docker run -p 3000:3000 \
  -e REDIS_URL=rediss://default:<password>@<host>:6379 \
  -e TRUST_PROXY=1 \
  shuttle

# or everything locally:
docker compose --profile app up --build
```

## Platform notes

- **Render / Railway / Heroku:** build `npm ci`, start `npm start`, set
  `REDIS_URL` and `TRUST_PROXY=1`, health check `/healthz`.
- **Fly.io:** `fly launch` (detects the Dockerfile), `fly secrets set
  REDIS_URL=... TRUST_PROXY=1`. Make sure `fly.toml` has an `[http_service]`
  on port 3000.
- **Your own VPS with nginx:** proxy WebSockets and pass the client IP:

  ```nginx
  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  }
  ```
  and run Shuttle with `TRUST_PROXY=loopback`.

## Adding a TURN server

**When do you need it?** Devices on the same Wi-Fi almost always connect
directly ("Linked, direct on your network"). TURN matters when they're on
*different* networks (joined via a court code) and at least one is behind a
strict NAT or firewall: many corporate networks, some mobile carriers, and
some guest Wi-Fi. Without TURN those pairs show "Couldn't link directly".

TURN relays the actual file bytes, so it costs bandwidth. That's why there's
no free public TURN.

### Option A: managed TURN

Cloudflare Realtime TURN, Twilio Network Traversal, Metered, Xirsys and
others sell TURN by the GB. Put their URLs in `TURN_URL` and either their
static credentials in `TURN_USERNAME`/`TURN_CREDENTIAL`, or a secret in
`TURN_SECRET` if they support the standard "TURN REST API" scheme. (Some
providers issue credentials through their own API instead. In that case,
change `buildIceServers()` in `src/ice.js` to call it.)

### Option B: run coturn

On a small VPS with a public IP and a DNS name such as `turn.example.com`:

```ini
# /etc/turnserver.conf
listening-port=3478
tls-listening-port=5349
realm=turn.example.com
fingerprint
use-auth-secret
static-auth-secret=<long random string; the same value goes in TURN_SECRET>
cert=/etc/letsencrypt/live/turn.example.com/fullchain.pem
pkey=/etc/letsencrypt/live/turn.example.com/privkey.pem
no-cli
no-tlsv1
no-tlsv1_1
# Don't let anyone use your relay to reach private networks:
denied-peer-ip=10.0.0.0-10.255.255.255
denied-peer-ip=172.16.0.0-172.31.255.255
denied-peer-ip=192.168.0.0-192.168.255.255
denied-peer-ip=127.0.0.0-127.255.255.255
```

Open firewall ports 3478 (UDP+TCP), 5349 (TCP) and the relay range
49152–65535 (UDP). Then set:

```bash
TURN_URL=turn:turn.example.com:3478,turns:turn.example.com:5349
TURN_SECRET=<the same long random string>
```

With `TURN_SECRET`, `/api/rtc-config` hands each browser a username like
`1791010475:shuttle` (an expiry timestamp) and an HMAC of it as the
password. coturn verifies the HMAC with the shared secret and rejects it
after expiry, so a leaked credential stops working within `TURN_TTL_S`.
`turns:` (TURN over TLS on 5349) gets through firewalls that only allow
HTTPS-looking traffic.

### Testing TURN

1. Open Shuttle on two devices with **`?relay=1`** added to the URL
   (court-code links work too: `/?code=1234&relay=1`). That forces every
   link through TURN.
2. The player row should say "Linked, relayed through TURN". If it says
   "Couldn't link directly", check credentials, ports and the coturn log.
   **Under the net** shows which candidates were gathered.
3. Alternatively paste your TURN URL and credentials (from
   `/api/rtc-config`) into Google's Trickle ICE sample page and look for
   `relay` candidates.
