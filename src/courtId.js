'use strict';

/**
 * Court IDs: which "room" does a visitor belong to?
 *
 * Devices on the same Wi-Fi usually reach the internet through one router, so
 * the server sees them all coming from the same public IP. We use that address
 * (or, for IPv6, the network part of it) as the court ID.
 *
 *   IPv4 203.0.113.7               -> "ip4:203.0.113.7"
 *   IPv6 2001:db8:abcd:12:a:b:c:d  -> "ip6:2001:db8:abcd:12::/64"
 *   ::ffff:203.0.113.7 (mapped)    -> "ip4:203.0.113.7"
 *   192.168.1.20, 10.x, ::1, fe80:: -> "lan"   (see LOCAL_COURT_ID below)
 *   garbage                        -> null
 *
 * This module is pure (no I/O) so it is easy to unit test.
 */

const ipaddr = require('ipaddr.js');

// IPv6 networks hand each device its own address, but all devices on one
// network share the first 64 bits (the "/64 prefix"). That prefix plays the
// same role as the shared public IPv4 address.
const IPV6_PREFIX_BITS = 64;

// When the server itself runs inside your home network (e.g. `npm run dev` on
// your laptop and you open http://192.168.1.20:3000 on your phone), there is no
// router in between: every device shows up with its own *private* address.
// Private, loopback and link-local addresses can only come from a network the
// server is directly attached to, so they all share one court.
const LOCAL_COURT_ID = 'lan';

const LOCAL_RANGES = {
  ipv4: new Set(['private', 'loopback', 'linkLocal']),
  ipv6: new Set(['loopback', 'linkLocal', 'uniqueLocal']),
};

// Addresses that can never be a real client.
const INVALID_RANGES = new Set(['unspecified', 'multicast', 'broadcast']);

/**
 * Turn a raw address string into an ipaddr.js object, or null if it isn't a
 * valid IP. Handles the shapes Node and proxies actually hand us:
 *   "203.0.113.7", "::ffff:203.0.113.7", "[2001:db8::1]", "fe80::1%en0"
 */
function normalizeIp(raw) {
  if (typeof raw !== 'string') return null;
  let s = raw.trim();
  if (s === '' || s.length > 64) return null;

  // "[2001:db8::1]" (bracketed IPv6, as in URLs) -> "2001:db8::1"
  if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1);

  let addr;
  if (s.includes(':')) {
    // Strip an IPv6 zone index ("fe80::1%en0"); it only names a local
    // interface and isn't part of the address.
    s = s.replace(/%[\w.-]+$/, '');
    if (!ipaddr.IPv6.isValid(s)) return null;
    addr = ipaddr.IPv6.parse(s);

    // A dual-stack Node socket reports IPv4 clients as "::ffff:a.b.c.d"
    // (an "IPv4-mapped IPv6 address"). Unwrap it so the same device always
    // gets the same court regardless of how the socket was opened.
    if (addr.isIPv4MappedAddress()) addr = addr.toIPv4Address();
  } else {
    // Only accept the normal dotted-quad form. ipaddr.js would also accept
    // legacy forms like "127.1" or "0x7f.0.0.1", which we never want to see.
    if (!ipaddr.IPv4.isValidFourPartDecimal(s)) return null;
    addr = ipaddr.IPv4.parse(s);
  }

  if (INVALID_RANGES.has(addr.range())) return null;
  return addr;
}

/** "2001:db8:abcd:12:a:b:c:d" -> "2001:db8:abcd:12::/64" */
function ipv6Prefix(addr, bits = IPV6_PREFIX_BITS) {
  // An IPv6 address is 8 groups ("parts") of 16 bits. Keep the groups that
  // fall inside the prefix and zero the rest (bits is a multiple of 16 here).
  const keep = bits / 16;
  const parts = addr.parts.map((p, i) => (i < keep ? p : 0));
  return `${new ipaddr.IPv6(parts).toString()}/${bits}`;
}

/**
 * The main entry point: raw client IP string -> court ID string (or null).
 */
function courtIdFromIp(raw) {
  const addr = normalizeIp(raw);
  if (!addr) return null;

  const kind = addr.kind(); // 'ipv4' | 'ipv6'
  if (LOCAL_RANGES[kind].has(addr.range())) return LOCAL_COURT_ID;

  if (kind === 'ipv4') return `ip4:${addr.toString()}`;
  return `ip6:${ipv6Prefix(addr)}`;
}

module.exports = { courtIdFromIp, normalizeIp, ipv6Prefix, LOCAL_COURT_ID, IPV6_PREFIX_BITS };
