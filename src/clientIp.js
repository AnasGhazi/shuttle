'use strict';

/**
 * Work out the real client IP of an HTTP request (including the request that
 * opens a Socket.IO connection).
 *
 * Without a proxy, the TCP socket address *is* the client. Behind a proxy
 * (nginx, a load balancer, a PaaS router) the socket address is the proxy, and
 * the real client is in the X-Forwarded-For header:
 *
 *   X-Forwarded-For: <client>, <proxy1>, <proxy2>
 *
 * Anyone can send that header, so we must only believe the entries added by
 * proxies we trust. `proxy-addr` (the same library Express uses for
 * `req.ip`) walks the list from the right and stops at the first address that
 * isn't trusted. That stopping point is the client.
 */

const proxyaddr = require('proxy-addr');

/**
 * @param trust  false | true | number of hops | array of addresses/subnets
 *               (the parsed TRUST_PROXY setting, see config.js)
 * @returns a function (req) -> ip string
 */
function createClientIpResolver(trust) {
  let trustFn;
  if (trust === false) trustFn = () => false;
  else if (trust === true) trustFn = () => true;
  else if (typeof trust === 'number') {
    // Trust the first `n` hops counting back from our own socket.
    // proxy-addr calls this with (address, index); index 0 is the socket peer.
    trustFn = (_addr, i) => i < trust;
  } else trustFn = proxyaddr.compile(trust);

  return function clientIp(req) {
    return proxyaddr(req, trustFn);
  };
}

module.exports = { createClientIpResolver };
