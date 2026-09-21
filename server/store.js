/* ===========================================================
   QueueLess — persistence
   ===========================================================
   Keeps the database in memory and mirrors it to a JSON file so
   the queue survives a server restart during the demo.

   Writes are debounced and serialised through a single promise
   chain: Node handles one request at a time, so the in-memory
   object is always consistent, and this only makes sure two
   flushes never interleave on disk.

   To move to Postgres/Supabase later, reimplement load() and
   persist() — nothing else in the server reads the filesystem.
   =========================================================== */

"use strict";

const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const engine = require("../shared/engine");

const DATA_DIR = path.join(__dirname, "data");
const DATA_FILE = path.join(DATA_DIR, "queue.json");

let db = null;
let writeChain = Promise.resolve();
let pendingFlush = null;

function loadSync() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
      if (parsed && Array.isArray(parsed.queues) && parsed.queues.length) {
        return parsed;
      }
      console.warn("QueueLess: saved data looked empty, reseeding.");
    }
  } catch (err) {
    console.warn("QueueLess: could not read saved data, reseeding.", err.message);
  }
  return engine.seed();
}

function getDb() {
  if (!db) {
    db = loadSync();
    flush();
  }
  return db;
}

/* Write via a temp file and rename, so a crash mid-write cannot
   leave a half-written file behind. */
async function writeNow() {
  const snapshot = JSON.stringify(db);
  await fsp.mkdir(DATA_DIR, { recursive: true });
  const tmp = `${DATA_FILE}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, snapshot, "utf8");
  await fsp.rename(tmp, DATA_FILE);
}

/* Coalesces bursts of changes into one disk write. */
function flush() {
  if (pendingFlush) return pendingFlush;
  pendingFlush = new Promise(resolve => {
    setTimeout(() => {
      pendingFlush = null;
      writeChain = writeChain
        .then(writeNow)
        .catch(err => console.error("QueueLess: failed to save data.", err.message))
        .then(resolve);
    }, 25);
  });
  return pendingFlush;
}

/* Waits for every queued write to reach disk. Used by the tests
   and by graceful shutdown. */
async function settled() {
  if (pendingFlush) await pendingFlush;
  await writeChain;
}

function reset() {
  db = engine.seed();
  flush();
  return db;
}

module.exports = { getDb, flush, settled, reset, DATA_FILE };
