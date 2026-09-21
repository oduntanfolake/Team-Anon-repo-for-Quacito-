/* ===========================================================
   QueueLess — queue engine
   ===========================================================
   Pure queue logic. No HTTP, no file access, no browser APIs:
   every function takes a database object and returns a result,
   which keeps the rules testable on their own and keeps the
   Express layer thin.

   Schema follows section 9 of the 5-Day Blueprint:
     users    userID, name, contact, createdAt
     services serviceID, serviceName, organizationID
     queues   queueID, serviceID, currentNumber, status
     tickets  ticketID, userID, queueID, queueNumber,
              joinedAt, status

   Ticket lifecycle:  waiting -> serving -> served
                      waiting -> serving -> skipped
                      waiting -> left          (user cancelled)
   =========================================================== */

"use strict";

/* Thrown for anything the caller did wrong, so the HTTP layer can
   map it to a 4xx instead of a 500. */
class QueueError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = "QueueError";
    this.status = status;
  }
}

const ORGANIZATIONS = [
  { organizationID: "uni-admin",  name: "University Administration", isDemo: true },
  { organizationID: "uni-health", name: "University Health Centre",  isDemo: false },
  { organizationID: "banking",    name: "Banking Services",          isDemo: false },
  { organizationID: "govt",       name: "Government Service Centre", isDemo: false }
];

/* Opening numbers match the screens in the Master Blueprint so the
   demo starts on the documented values. */
const SERVICE_SEED = [
  { serviceID: "doc-collection", serviceName: "Document Collection",  organizationID: "uni-admin", prefix: "A", startNumber: 37, waiting: 12, avgServiceMinutes: 3 },
  { serviceID: "registration",   serviceName: "Student Registration", organizationID: "uni-admin", prefix: "B", startNumber: 18, waiting: 6,  avgServiceMinutes: 4 },
  { serviceID: "payments",       serviceName: "Payment / Fees",       organizationID: "uni-admin", prefix: "C", startNumber: 52, waiting: 9,  avgServiceMinutes: 2 },
  { serviceID: "transcripts",    serviceName: "Transcript Request",   organizationID: "uni-admin", prefix: "D", startNumber: 9,  waiting: 3,  avgServiceMinutes: 5 }
];

const SEEDED_SERVED_TODAY = 84;

/* Demo staff accounts. Real deployments would hash these and keep
   them in the database; the blueprint is explicit that the five
   days should not go on authentication. */
const STAFF_ACCOUNTS = [
  { email: "admin@queueless.com", password: "admin123", name: "Front Desk" }
];

/* ---------------------------------------------------------
   HELPERS
--------------------------------------------------------- */

const now = () => Date.now();

const label = (prefix, n) => prefix + String(n).padStart(3, "0");

let idCounter = 0;
function makeId(kind) {
  idCounter += 1;
  return `${kind}-${now().toString(36)}-${idCounter}`;
}

const minutesBetween = (a, b) => Math.max(0, Math.round((b - a) / 60000));

function average(list) {
  if (!list.length) return null;
  return list.reduce((sum, n) => sum + n, 0) / list.length;
}

/* ---------------------------------------------------------
   SEEDING
   Builds a believable day: a block of already-served tickets so
   statistics come from real rows rather than hardcoded numbers,
   plus the people currently waiting.
--------------------------------------------------------- */

function seed() {
  const db = { version: 1, users: [], services: [], queues: [], tickets: [], seededAt: now() };

  const startOfDay = new Date();
  startOfDay.setHours(9, 0, 0, 0);
  const dayStart = startOfDay.getTime();

  for (const s of SERVICE_SEED) {
    db.services.push({
      serviceID: s.serviceID,
      serviceName: s.serviceName,
      organizationID: s.organizationID,
      prefix: s.prefix,
      avgServiceMinutes: s.avgServiceMinutes
    });

    const queueID = `q-${s.serviceID}`;

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
      db.tickets.push({
        ticketID: makeId("t"),
        userID: null,
        queueID,
        queueNumber: firstHistoric + i,
        queueLabel: label(s.prefix, firstHistoric + i),
        serviceID: s.serviceID,
        joinedAt: joined,
        calledAt: called,
        closedAt: called + s.avgServiceMinutes * 60000,
        status: "served"
      });
    }

    // The person currently at the counter.
    db.tickets.push({
      ticketID: makeId("t"),
      userID: null,
      queueID,
      queueNumber: s.startNumber,
      queueLabel: label(s.prefix, s.startNumber),
      serviceID: s.serviceID,
      joinedAt: now() - 20 * 60000,
      calledAt: now() - 2 * 60000,
      closedAt: null,
      status: "serving"
    });

    // The people still waiting behind them.
    for (let w = 1; w <= s.waiting; w++) {
      db.tickets.push({
        ticketID: makeId("t"),
        userID: null,
        queueID,
        queueNumber: s.startNumber + w,
        queueLabel: label(s.prefix, s.startNumber + w),
        serviceID: s.serviceID,
        joinedAt: now() - (s.waiting - w) * 90000,
        calledAt: null,
        closedAt: null,
        status: "waiting"
      });
    }

    db.queues.push({
      queueID,
      serviceID: s.serviceID,
      currentNumber: s.startNumber,
      nextNumber: s.startNumber + s.waiting + 1,
      status: "open"
    });
  }

  return db;
}

/* ---------------------------------------------------------
   LOOKUPS
--------------------------------------------------------- */

const queueForService = (db, serviceID) =>
  db.queues.find(q => q.serviceID === serviceID) || null;

const serviceById = (db, serviceID) =>
  db.services.find(s => s.serviceID === serviceID) || null;

const ticketsFor = (db, serviceID) =>
  db.tickets.filter(t => t.serviceID === serviceID);

const waitingTickets = (db, serviceID) =>
  ticketsFor(db, serviceID)
    .filter(t => t.status === "waiting")
    .sort((a, b) => a.queueNumber - b.queueNumber);

const servingTicket = (db, serviceID) =>
  ticketsFor(db, serviceID).find(t => t.status === "serving") || null;

/* Effective service time per person: measured from real served
   rows when there are enough of them, otherwise the seed estimate.
   This is what makes the wait estimate sharpen as the day runs. */
function effectiveServiceMinutes(db, serviceID) {
  const service = serviceById(db, serviceID);
  const fallback = service ? service.avgServiceMinutes : 5;
  const recent = ticketsFor(db, serviceID)
    .filter(t => t.status === "served" && t.calledAt && t.closedAt)
    .slice(-20)
    .map(t => (t.closedAt - t.calledAt) / 60000);
  if (recent.length < 3) return fallback;
  return Math.max(1, Math.round(average(recent) * 10) / 10);
}

function requireService(db, serviceID) {
  const service = serviceById(db, serviceID);
  const queue = queueForService(db, serviceID);
  if (!service || !queue) throw new QueueError(`Unknown service: ${serviceID}`, 404);
  return { service, queue };
}

/* ---------------------------------------------------------
   READS
--------------------------------------------------------- */

function getOrganizations() {
  return ORGANIZATIONS;
}

function getServices(db, organizationID) {
  return db.services
    .filter(s => !organizationID || s.organizationID === organizationID)
    .map(service => {
      const serving = servingTicket(db, service.serviceID);
      const queue = queueForService(db, service.serviceID);
      return {
        serviceID: service.serviceID,
        serviceName: service.serviceName,
        organizationID: service.organizationID,
        waiting: waitingTickets(db, service.serviceID).length,
        currentlyServingLabel: serving
          ? serving.queueLabel
          : label(service.prefix, queue.currentNumber)
      };
    });
}

function getQueueSnapshot(db, serviceID) {
  const { service, queue } = requireService(db, serviceID);
  const waiting = waitingTickets(db, serviceID);
  const perPerson = effectiveServiceMinutes(db, serviceID);
  const serving = servingTicket(db, serviceID);

  return {
    serviceID: service.serviceID,
    serviceName: service.serviceName,
    queueStatus: queue.status,
    currentlyServingLabel: serving ? serving.queueLabel : label(service.prefix, queue.currentNumber),
    peopleWaiting: waiting.length,
    estimatedWaitMinutes: Math.round(waiting.length * perPerson),
    avgServiceMinutes: perPerson
  };
}

/* peopleAhead is counted from the live queue rather than derived
   from the ticket number, so it stays correct after someone leaves
   or is skipped. */
function getTicket(db, ticketID) {
  const ticket = db.tickets.find(t => t.ticketID === ticketID);
  if (!ticket) throw new QueueError(`Unknown ticket: ${ticketID}`, 404);

  const service = serviceById(db, ticket.serviceID);
  const serving = servingTicket(db, ticket.serviceID);
  const perPerson = effectiveServiceMinutes(db, ticket.serviceID);

  const ahead = waitingTickets(db, ticket.serviceID)
    .filter(t => t.queueNumber < ticket.queueNumber).length;

  return {
    ticketID: ticket.ticketID,
    ticketLabel: ticket.queueLabel,
    serviceID: ticket.serviceID,
    serviceName: service ? service.serviceName : "",
    status: ticket.status,
    isYourTurn: ticket.status === "serving",
    peopleAhead: ticket.status === "waiting" ? ahead : 0,
    estimatedWaitMinutes: ticket.status === "waiting" ? Math.round(ahead * perPerson) : 0,
    currentlyServingLabel: serving ? serving.queueLabel : null,
    counter: ticket.status === "serving" ? 2 : null,
    joinedAt: ticket.joinedAt
  };
}

function getWaitingList(db, serviceID) {
  requireService(db, serviceID);
  const serving = servingTicket(db, serviceID);
  const rows = waitingTickets(db, serviceID).map((ticket, index) => ({
    position: index + 1,
    ticketID: ticket.ticketID,
    number: ticket.queueLabel,
    serviceName: (serviceById(db, ticket.serviceID) || {}).serviceName || "",
    status: "Waiting",
    waitingMinutes: minutesBetween(ticket.joinedAt, now())
  }));

  if (serving) {
    rows.unshift({
      position: 0,
      ticketID: serving.ticketID,
      number: serving.queueLabel,
      serviceName: (serviceById(db, serving.serviceID) || {}).serviceName || "",
      status: "Serving",
      waitingMinutes: minutesBetween(serving.joinedAt, serving.calledAt || now())
    });
  }
  return rows;
}

/* Everything here is computed from ticket rows — nothing hardcoded. */
function getStats(db, serviceID) {
  requireService(db, serviceID);
  const tickets = ticketsFor(db, serviceID);
  const served = tickets.filter(t => t.status === "served");
  const skipped = tickets.filter(t => t.status === "skipped");
  const serving = servingTicket(db, serviceID);

  const waits = served.filter(t => t.calledAt).map(t => (t.calledAt - t.joinedAt) / 60000);
  const serviceTimes = served
    .filter(t => t.calledAt && t.closedAt)
    .map(t => (t.closedAt - t.calledAt) / 60000);

  // Served per hour, ready for the optional bar chart in the blueprint.
  const byHour = {};
  for (const t of served) {
    const hour = new Date(t.closedAt || t.calledAt || t.joinedAt).getHours();
    byHour[hour] = (byHour[hour] || 0) + 1;
  }

  const avgWait = average(waits);
  const avgService = average(serviceTimes);

  return {
    serviceID,
    servedToday: served.length,
    skippedToday: skipped.length,
    currentlyWaiting: waitingTickets(db, serviceID).length,
    currentlyServingLabel: serving ? serving.queueLabel : null,
    avgWaitMinutes: avgWait === null ? null : Math.round(avgWait),
    avgServiceMinutes: avgService === null ? null : Math.round(avgService * 10) / 10,
    servedByHour: Object.keys(byHour)
      .sort((a, b) => a - b)
      .map(h => ({ hour: Number(h), count: byHour[h] }))
  };
}

/* ---------------------------------------------------------
   WRITES
   Each returns { result, changed } so the caller knows whether
   to persist and broadcast.
--------------------------------------------------------- */

function joinQueue(db, serviceID, userDetails) {
  const { service, queue } = requireService(db, serviceID);
  if (queue.status !== "open") throw new QueueError("This queue is currently closed.");

  let user = null;
  if (userDetails && (userDetails.name || userDetails.contact)) {
    user = {
      userID: makeId("u"),
      name: userDetails.name || "Guest",
      contact: userDetails.contact || null,
      createdAt: now()
    };
    db.users.push(user);
  }

  const assigned = queue.nextNumber;
  queue.nextNumber = assigned + 1;

  const ticket = {
    ticketID: makeId("t"),
    userID: user ? user.userID : null,
    queueID: queue.queueID,
    queueNumber: assigned,
    queueLabel: label(service.prefix, assigned),
    serviceID,
    joinedAt: now(),
    calledAt: null,
    closedAt: null,
    status: "waiting"
  };
  db.tickets.push(ticket);

  return { result: getTicket(db, ticket.ticketID), changed: true };
}

function leaveQueue(db, ticketID) {
  const ticket = db.tickets.find(t => t.ticketID === ticketID);
  if (!ticket) throw new QueueError(`Unknown ticket: ${ticketID}`, 404);
  if (ticket.status !== "waiting") {
    throw new QueueError("Only a waiting ticket can be cancelled.", 409);
  }
  ticket.status = "left";
  ticket.closedAt = now();
  return { result: { ticketID, status: "left" }, changed: true };
}

/* CALL NEXT — closes out whoever is at the counter, then promotes
   the next waiting ticket. */
function callNext(db, serviceID) {
  const { queue } = requireService(db, serviceID);

  const current = servingTicket(db, serviceID);
  if (current) {
    current.status = "served";
    current.closedAt = now();
  }

  const next = waitingTickets(db, serviceID)[0];
  if (!next) {
    return {
      result: { called: null, previousServed: current ? current.queueLabel : null, message: "No one is waiting." },
      changed: Boolean(current)
    };
  }

  next.status = "serving";
  next.calledAt = now();
  queue.currentNumber = next.queueNumber;

  return {
    result: {
      called: next.queueLabel,
      ticketID: next.ticketID,
      previousServed: current ? current.queueLabel : null
    },
    changed: true
  };
}

/* MARK SERVED — closes out the person at the counter and stops
   there. Nobody is promoted; staff press CALL NEXT for that. */
function markServed(db, serviceID) {
  requireService(db, serviceID);
  const current = servingTicket(db, serviceID);
  if (!current) throw new QueueError("Nobody is currently being served.", 409);

  current.status = "served";
  current.closedAt = now();
  return { result: { served: current.queueLabel, ticketID: current.ticketID }, changed: true };
}

/* SKIP — the current person did not show up. Records a no-show
   (not a service) and promotes the next person. */
function skip(db, serviceID) {
  const { queue } = requireService(db, serviceID);

  const target = servingTicket(db, serviceID) || waitingTickets(db, serviceID)[0];
  if (!target) throw new QueueError("There is nobody to skip.", 409);

  target.status = "skipped";
  target.closedAt = now();

  const next = waitingTickets(db, serviceID)[0];
  if (next) {
    next.status = "serving";
    next.calledAt = now();
    queue.currentNumber = next.queueNumber;
  }

  return {
    result: { skipped: target.queueLabel, called: next ? next.queueLabel : null },
    changed: true
  };
}

function staffLogin(email, password) {
  const account = STAFF_ACCOUNTS.find(
    a => a.email === String(email || "").trim().toLowerCase() && a.password === password
  );
  if (!account) throw new QueueError("Invalid staff email or password.", 401);
  return { email: account.email, name: account.name };
}

module.exports = {
  QueueError,
  seed,
  getOrganizations,
  getServices,
  getQueueSnapshot,
  getTicket,
  getWaitingList,
  getStats,
  joinQueue,
  leaveQueue,
  callNext,
  markServed,
  skip,
  staffLogin
};
