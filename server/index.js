/* ===========================================================
   QueueLess — server entry point

   Listens on 0.0.0.0 so a phone on the same wifi can reach it by
   the laptop's IP, which is what makes the QR-code demo work.
   =========================================================== */

"use strict";

const os = require("os");
const { createApp } = require("./app");
const store = require("./store");

const PORT = Number(process.env.PORT) || 3000;

function localAddresses() {
  const found = [];
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.family === "IPv4" && !entry.internal) found.push(entry.address);
    }
  }
  return found;
}

const server = createApp().listen(PORT, "0.0.0.0", () => {
  console.log("\n  QueueLess server running\n");
  console.log(`  On this machine:  http://localhost:${PORT}`);
  for (const address of localAddresses()) {
    console.log(`  On your network:  http://${address}:${PORT}   <- use this for the QR code`);
  }
  console.log(`\n  Data file: ${store.DATA_FILE}`);
  console.log("  Reset the demo: curl -X POST http://localhost:" + PORT + "/api/demo/reset\n");
});

// Make sure anything still queued reaches disk before we exit.
async function shutdown(signal) {
  console.log(`\n  ${signal} received, saving and shutting down.`);
  server.close();
  try {
    await store.settled();
  } catch (err) {
    console.error("  Failed to save on shutdown.", err.message);
  }
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
