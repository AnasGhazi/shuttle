'use strict';

const os = require('node:os');
const { config } = require('./config');
const { createShuttleServer } = require('./createServer');

/** LAN addresses of this machine, so you know what to open on your phone. */
function lanUrls(port) {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal)
    .map((i) => `http://${i.address}:${port}`);
}

async function main() {
  const server = await createShuttleServer(config);

  server.httpServer.listen(config.port, config.host, () => {
    console.log(`🏸 Shuttle is on court at http://localhost:${config.port}`);
    for (const url of lanUrls(config.port)) console.log(`   other devices on this Wi-Fi: ${url}`);
  });

  // Graceful shutdown (Ctrl+C locally, SIGTERM from a hosting platform).
  let closing = false;
  const shutdown = async (signal) => {
    if (closing) return;
    closing = true;
    console.log(`\n${signal} received, closing...`);
    await server.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  // Connecting to "localhost" tries IPv4 and IPv6 and can fail with an
  // AggregateError whose own message is empty, so fall back to the inner ones.
  const detail = err.message || err.errors?.map((e) => e.message).join('; ') || err.code;
  console.error('Failed to start Shuttle:', detail);
  if (err.code === 'ECONNREFUSED') {
    console.error('Is Redis running? Try: docker compose up -d redis');
  }
  process.exit(1);
});
