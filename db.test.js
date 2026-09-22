/* ===========================================================
   QueueLess — database tests
   Proves the schema enforces its own integrity and that data
   genuinely survives the process, rather than trusting the
   application to behave.
   Run with:  node db.test.js
   =========================================================== */

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

// Use a scratch database so a test run never touches the demo data.
const TMP_DB = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "queueless-test-")), "test.db");
process.env.QUEUELESS_DB = TMP_DB;

const database = require("./server/database");
const { createSqliteRepo } = require("./server/sqlite-repo");
const engine = require("./shared/engine");

let passed = 0;
let failed = 0;

function check(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { passed++; console.log("  PASS  " + name); }
  else { failed++; console.log(`  FAIL  ${name}\n          expected ${e}\n          actual   ${a}`); }
}

function rejects(name, fn) {
  try {
    fn();
    failed++;
    console.log(`  FAIL  ${name}\n          expected the database to reject this, but it was accepted`);
  } catch (err) {
    passed++;
    console.log("  PASS  " + name);
  }
}

console.log("\nQueueLess database tests\n");

const h = database.connect();

console.log("Schema");
const tables = h.all("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").map(r => r.name);
check("all four blueprint tables exist plus organizations",
  tables.filter(t => !t.startsWith("sqlite_")),
  ["organizations", "queues", "services", "tickets", "users"]);
check("foreign keys are on", h.get("PRAGMA foreign_keys").foreign_keys, 1);
check("write-ahead logging is on",
  String(h.get("PRAGMA journal_mode").journal_mode).toLowerCase(), "wal");

console.log("\nSeed data");
check("four services seeded", h.get("SELECT COUNT(*) AS n FROM services").n, 4);
check("four queues seeded", h.get("SELECT COUNT(*) AS n FROM queues").n, 4);
check("one person at the counter per service",
  h.get("SELECT COUNT(*) AS n FROM tickets WHERE status='serving'").n, 4);
check("Document Collection has 84 served",
  h.get("SELECT COUNT(*) AS n FROM tickets WHERE serviceID='doc-collection' AND status='served'").n, 84);

console.log("\nIntegrity enforced by the database, not the app");
rejects("two people cannot hold the same number", () =>
  h.run(`INSERT INTO tickets (ticketID,queueID,serviceID,queueNumber,queueLabel,joinedAt,status)
         VALUES ('dup','q-doc-collection','doc-collection',37,'A037',1,'waiting')`));

rejects("two people cannot be at the counter at once", () =>
  h.run(`INSERT INTO tickets (ticketID,queueID,serviceID,queueNumber,queueLabel,joinedAt,status)
         VALUES ('two-serving','q-doc-collection','doc-collection',9001,'A901',1,'serving')`));

rejects("a ticket cannot have an invented status", () =>
  h.run(`INSERT INTO tickets (ticketID,queueID,serviceID,queueNumber,queueLabel,joinedAt,status)
         VALUES ('bad-status','q-doc-collection','doc-collection',9002,'A902',1,'banana')`));

rejects("a ticket cannot belong to a service that does not exist", () =>
  h.run(`INSERT INTO tickets (ticketID,queueID,serviceID,queueNumber,queueLabel,joinedAt,status)
         VALUES ('orphan','q-ghost','ghost',9003,'Z903',1,'waiting')`));

console.log("\nQueue numbers");
const repo = createSqliteRepo(h);
const first = repo.takeNextNumber("doc-collection");
const second = repo.takeNextNumber("doc-collection");
check("numbers are handed out in sequence", second, first + 1);
check("the counter is stored, not derived",
  h.get("SELECT nextNumber FROM queues WHERE serviceID='doc-collection'").nextNumber, second + 1);

console.log("\nTransactions");
const waitingBefore = repo.countWaiting("doc-collection");
try {
  h.transaction(() => {
    h.run("UPDATE tickets SET status='left' WHERE serviceID='doc-collection' AND status='waiting'");
    throw new Error("simulated failure midway");
  });
} catch (err) { /* expected */ }
check("a failed transaction leaves the queue untouched",
  repo.countWaiting("doc-collection"), waitingBefore);

console.log("\nPersistence");
const ticket = engine.joinQueue(repo, "doc-collection", { name: "Persisted" }).result;
engine.callNext(repo, "doc-collection");
const statsBefore = engine.getStats(repo, "doc-collection");

// Close the connection entirely and reopen from the file on disk.
h.close();
const reopened = database.connect();
const repo2 = createSqliteRepo(reopened);

check("the ticket is still there after reopening",
  repo2.getTicket(ticket.ticketID).queueLabel, ticket.ticketLabel);
check("statistics survive a reconnect",
  engine.getStats(repo2, "doc-collection").servedToday, statsBefore.servedToday);
check("the database file exists on disk", fs.existsSync(TMP_DB), true);
check("the file has real content", fs.statSync(TMP_DB).size > 4096, true);

console.log("\nReset");
database.reset();
const repo3 = createSqliteRepo(database.connect());
check("reset returns to the opening state", repo3.countWaiting("doc-collection"), 12);
check("reset restores the serving ticket", repo3.getServing("doc-collection").queueLabel, "A037");
check("reset clears tickets added during the demo",
  repo3.getTicket(ticket.ticketID), null);

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
