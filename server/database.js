/* ===========================================================
   QueueLess — database connection and schema
   ===========================================================
   SQLite, because it is a real relational database that needs no
   server process, no credentials and no internet — the whole
   database is one file. That matters for a demo laptop.

   Driver: node's built-in node:sqlite where available (nothing
   to install), otherwise better-sqlite3. Both expose the same
   prepare/run/all/get surface, so the thin wrapper below is all
   the difference that leaks out.
   =========================================================== */

"use strict";

const fs = require("fs");
const path = require("path");
const schema = require("../shared/schema");

const DATA_DIR = path.join(__dirname, "data");
const DB_FILE = process.env.QUEUELESS_DB || path.join(DATA_DIR, "queueless.db");

/* ---------------------------------------------------------
   DDL
   Constraints are declared here rather than trusted to the
   application: the unique index on (serviceID, queueNumber)
   makes it impossible for two people to hold the same ticket
   number, and the partial unique index makes it impossible for
   two people to be at the counter for one service at once.
--------------------------------------------------------- */

const DDL = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS organizations (
  organizationID TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  isDemo         INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS users (
  userID    TEXT PRIMARY KEY,
  name      TEXT NOT NULL,
  contact   TEXT,
  createdAt INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS services (
  serviceID         TEXT PRIMARY KEY,
  serviceName       TEXT NOT NULL,
  organizationID    TEXT NOT NULL REFERENCES organizations(organizationID),
  prefix            TEXT NOT NULL,
  avgServiceMinutes REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS queues (
  queueID       TEXT PRIMARY KEY,
  serviceID     TEXT NOT NULL UNIQUE REFERENCES services(serviceID),
  currentNumber INTEGER NOT NULL,
  nextNumber    INTEGER NOT NULL,
  status        TEXT NOT NULL DEFAULT 'open'
);

CREATE TABLE IF NOT EXISTS tickets (
  ticketID    TEXT PRIMARY KEY,
  userID      TEXT REFERENCES users(userID),
  queueID     TEXT NOT NULL REFERENCES queues(queueID),
  serviceID   TEXT NOT NULL REFERENCES services(serviceID),
  queueNumber INTEGER NOT NULL,
  queueLabel  TEXT NOT NULL,
  joinedAt    INTEGER NOT NULL,
  calledAt    INTEGER,
  closedAt    INTEGER,
  status      TEXT NOT NULL
    CHECK (status IN ('waiting','serving','served','skipped','left'))
);

-- No two people can ever hold the same number for one service.
CREATE UNIQUE INDEX IF NOT EXISTS idx_ticket_number_unique
  ON tickets(serviceID, queueNumber);

-- At most one person can be at the counter per service.
CREATE UNIQUE INDEX IF NOT EXISTS idx_one_serving_per_service
  ON tickets(serviceID) WHERE status = 'serving';

-- The queue read on every poll: who is waiting, in order.
CREATE INDEX IF NOT EXISTS idx_tickets_service_status
  ON tickets(serviceID, status, queueNumber);
`;

/* ---------------------------------------------------------
   DRIVER
--------------------------------------------------------- */

function openDriver(file) {
  try {
    const { DatabaseSync } = require("node:sqlite");
    return { db: new DatabaseSync(file), driver: "node:sqlite" };
  } catch (err) {
    try {
      const Database = require("better-sqlite3");
      return { db: new Database(file), driver: "better-sqlite3" };
    } catch (err2) {
      throw new Error(
        "No SQLite driver available. Use Node 22+ (built-in node:sqlite), " +
        "or run `npm install better-sqlite3`."
      );
    }
  }
}

/* node:sqlite returns null-prototype rows; normalising here means
   nothing downstream has to care which driver is in use. */
const plain = row => (row ? Object.assign({}, row) : null);
const plainAll = rows => rows.map(r => Object.assign({}, r));

let handle = null;

function connect() {
  if (handle) return handle;

  fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
  const { db, driver } = openDriver(DB_FILE);
  db.exec(DDL);

  handle = {
    driver,
    file: DB_FILE,
    raw: db,
    run: (sql, ...params) => db.prepare(sql).run(...params),
    get: (sql, ...params) => plain(db.prepare(sql).get(...params)),
    all: (sql, ...params) => plainAll(db.prepare(sql).all(...params)),
    exec: sql => db.exec(sql),
    /* SQLite is single-writer, and the server handles one request
       at a time, so a plain transaction is enough to keep a
       multi-step queue move atomic. */
    transaction(fn) {
      db.exec("BEGIN IMMEDIATE");
      try {
        const result = fn();
        db.exec("COMMIT");
        return result;
      } catch (err) {
        try { db.exec("ROLLBACK"); } catch (rollbackErr) { /* already unwound */ }
        throw err;
      }
    },
    close() {
      try { db.close(); } catch (err) { /* already closed */ }
      handle = null;
    }
  };

  if (isEmpty(handle)) seed(handle);
  return handle;
}

function isEmpty(h) {
  return h.get("SELECT COUNT(*) AS n FROM queues").n === 0;
}

/* ---------------------------------------------------------
   SEEDING
--------------------------------------------------------- */

function seed(h) {
  const rows = schema.buildSeedRows();

  h.transaction(() => {
    for (const org of rows.organizations) {
      h.run(
        "INSERT OR REPLACE INTO organizations (organizationID, name, isDemo) VALUES (?, ?, ?)",
        org.organizationID, org.name, org.isDemo ? 1 : 0
      );
    }
    for (const s of rows.services) {
      h.run(
        `INSERT OR REPLACE INTO services
           (serviceID, serviceName, organizationID, prefix, avgServiceMinutes)
         VALUES (?, ?, ?, ?, ?)`,
        s.serviceID, s.serviceName, s.organizationID, s.prefix, s.avgServiceMinutes
      );
    }
    for (const q of rows.queues) {
      h.run(
        `INSERT OR REPLACE INTO queues
           (queueID, serviceID, currentNumber, nextNumber, status)
         VALUES (?, ?, ?, ?, ?)`,
        q.queueID, q.serviceID, q.currentNumber, q.nextNumber, q.status
      );
    }
    for (const t of rows.tickets) {
      h.run(
        `INSERT OR REPLACE INTO tickets
           (ticketID, userID, queueID, serviceID, queueNumber, queueLabel,
            joinedAt, calledAt, closedAt, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        t.ticketID, t.userID, t.queueID, t.serviceID, t.queueNumber, t.queueLabel,
        t.joinedAt, t.calledAt, t.closedAt, t.status
      );
    }
  });
}

/* Wipes every row and reseeds — the rehearsal reset. */
function reset() {
  const h = connect();
  h.transaction(() => {
    h.exec("DELETE FROM tickets; DELETE FROM queues; DELETE FROM services; DELETE FROM users;");
  });
  seed(h);
  return h;
}

module.exports = { connect, reset, seed, DB_FILE, DDL };
