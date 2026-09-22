/* ===========================================================
   QueueLess — reference data and seed values
   ===========================================================
   Shared by the SQLite seeder on the server and the in-memory
   seeder in the browser, so both start from identical data.
   =========================================================== */

(function () {
"use strict";

const ORGANIZATIONS = [
  { organizationID: "uni-admin",  name: "University Administration", isDemo: 1 },
  { organizationID: "uni-health", name: "University Health Centre",  isDemo: 0 },
  { organizationID: "banking",    name: "Banking Services",          isDemo: 0 },
  { organizationID: "govt",       name: "Government Service Centre", isDemo: 0 }
];

/* Opening numbers match the screens in the Master Blueprint, so
   the demo starts on the documented values. */
const SERVICE_SEED = [
  { serviceID: "doc-collection", serviceName: "Document Collection",  organizationID: "uni-admin", prefix: "A", startNumber: 37, waiting: 12, avgServiceMinutes: 3 },
  { serviceID: "registration",   serviceName: "Student Registration", organizationID: "uni-admin", prefix: "B", startNumber: 18, waiting: 6,  avgServiceMinutes: 4 },
  { serviceID: "payments",       serviceName: "Payment / Fees",       organizationID: "uni-admin", prefix: "C", startNumber: 52, waiting: 9,  avgServiceMinutes: 2 },
  { serviceID: "transcripts",    serviceName: "Transcript Request",   organizationID: "uni-admin", prefix: "D", startNumber: 9,  waiting: 3,  avgServiceMinutes: 5 }
];

const SEEDED_SERVED_TODAY = 84;

/* Demo staff accounts. A real deployment would store hashed
   passwords in the database; the blueprint is explicit that the
   five days should not go on authentication. */
const STAFF_ACCOUNTS = [
  { email: "admin@queueless.com", password: "admin123", name: "Front Desk" }
];

const TICKET_STATUSES = ["waiting", "serving", "served", "skipped", "left"];

/* Builds the full opening day as plain rows: a block of already
   served tickets so statistics come from real data, the person
   at the counter, and the people still waiting. Both the SQLite
   seeder and the in-memory one consume this. */
function buildSeedRows(nowMs) {
  const now = typeof nowMs === "number" ? nowMs : Date.now();

  const startOfDay = new Date(now);
  startOfDay.setHours(9, 0, 0, 0);
  const dayStart = startOfDay.getTime();

  const services = [];
  const queues = [];
  const tickets = [];
  let seq = 0;
  const nextId = () => `t-seed-${++seq}`;

  for (const s of SERVICE_SEED) {
    services.push({
      serviceID: s.serviceID,
      serviceName: s.serviceName,
      organizationID: s.organizationID,
      prefix: s.prefix,
      avgServiceMinutes: s.avgServiceMinutes
    });

    const queueID = `q-${s.serviceID}`;
    const label = n => s.prefix + String(n).padStart(3, "0");

    // Only Document Collection carries the full history, so the
    // dashboard's "served today" matches the blueprint.
    const historyCount = s.serviceID === "doc-collection"
      ? SEEDED_SERVED_TODAY
      : Math.round(s.startNumber / 2);

    const firstHistoric = s.startNumber - historyCount;
    for (let i = 0; i < historyCount; i++) {
      const joined = dayStart + i * 4 * 60000;
      // ~18 min average wait, gently varied so averages are not flat.
      const called = joined + (15 + (i % 7)) * 60000;
      tickets.push({
        ticketID: nextId(),
        userID: null,
        queueID,
        serviceID: s.serviceID,
        queueNumber: firstHistoric + i,
        queueLabel: label(firstHistoric + i),
        joinedAt: joined,
        calledAt: called,
        closedAt: called + s.avgServiceMinutes * 60000,
        status: "served"
      });
    }

    // The person currently at the counter.
    tickets.push({
      ticketID: nextId(),
      userID: null,
      queueID,
      serviceID: s.serviceID,
      queueNumber: s.startNumber,
      queueLabel: label(s.startNumber),
      joinedAt: now - 20 * 60000,
      calledAt: now - 2 * 60000,
      closedAt: null,
      status: "serving"
    });

    // The people still waiting behind them.
    for (let w = 1; w <= s.waiting; w++) {
      tickets.push({
        ticketID: nextId(),
        userID: null,
        queueID,
        serviceID: s.serviceID,
        queueNumber: s.startNumber + w,
        queueLabel: label(s.startNumber + w),
        joinedAt: now - (s.waiting - w) * 90000,
        calledAt: null,
        closedAt: null,
        status: "waiting"
      });
    }

    queues.push({
      queueID,
      serviceID: s.serviceID,
      currentNumber: s.startNumber,
      nextNumber: s.startNumber + s.waiting + 1,
      status: "open"
    });
  }

  return { organizations: ORGANIZATIONS, services, queues, tickets };
}

const SCHEMA = {
  ORGANIZATIONS,
  SERVICE_SEED,
  SEEDED_SERVED_TODAY,
  STAFF_ACCOUNTS,
  TICKET_STATUSES,
  buildSeedRows
};

if (typeof module !== "undefined" && module.exports) module.exports = SCHEMA;
if (typeof window !== "undefined") window.QueueLessSchema = SCHEMA;

})();
