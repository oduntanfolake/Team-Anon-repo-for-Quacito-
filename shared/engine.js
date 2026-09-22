/* ===========================================================
   QueueLess — queue rules
   ===========================================================
   The queue logic, and nothing else. No SQL, no HTTP, no disk,
   no browser APIs: every function takes a repository and asks it
   for rows.

   Two repositories satisfy that contract — SQLite on the server
   (server/sqlite-repo.js) and arrays in the browser
   (shared/memory-repo.js) — so these rules run identically
   whether or not the server is reachable, and they can be tested
   without a database file.

   Ticket lifecycle:  waiting -> serving -> served
                      waiting -> serving -> skipped
                      waiting -> left          (user cancelled)
   =========================================================== */

(function () {
"use strict";

const SCHEMA = (typeof require !== "undefined")
  ? require("./schema")
  : (typeof window !== "undefined" ? window.QueueLessSchema : null);

/* Thrown for anything the caller got wrong, so the HTTP layer can
   map it to a 4xx instead of a 500. */
class QueueError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = "QueueError";
    this.status = status;
  }
}

/* ---------------------------------------------------------
   HELPERS
--------------------------------------------------------- */

const now = () => Date.now();

const label = (prefix, n) => prefix + String(n).padStart(3, "0");

let idCounter = 0;
function makeId(kind) {
  idCounter += 1;
  return `${kind}-${now().toString(36)}-${idCounter}-${Math.floor(Math.random() * 1e6)}`;
}

const minutesBetween = (a, b) => Math.max(0, Math.round((b - a) / 60000));

const round1 = n => Math.round(n * 10) / 10;

function requireService(repo, serviceID) {
  const service = repo.getService(serviceID);
  const queue = repo.getQueue(serviceID);
  if (!service || !queue) throw new QueueError(`Unknown service: ${serviceID}`, 404);
  return { service, queue };
}

/* How long a turn actually takes: measured from genuinely served
   tickets once there are enough of them, otherwise the service's
   configured estimate. This is what sharpens the wait estimate as
   the day goes on. */
function effectiveServiceMinutes(repo, serviceID) {
  const service = repo.getService(serviceID);
  const fallback = service ? service.avgServiceMinutes : 5;
  const recent = repo.listRecentServed(serviceID, 20);
  if (recent.length < 3) return fallback;
  const measured = recent.reduce((sum, t) => sum + (t.closedAt - t.calledAt) / 60000, 0) / recent.length;
  return Math.max(1, round1(measured));
}

/* ---------------------------------------------------------
   READS
--------------------------------------------------------- */

function getOrganizations(repo) {
  return repo.listOrganizations();
}

function getServices(repo, organizationID) {
  return repo.listServices(organizationID).map(service => {
    const serving = repo.getServing(service.serviceID);
    const queue = repo.getQueue(service.serviceID);
    return {
      serviceID: service.serviceID,
      serviceName: service.serviceName,
      organizationID: service.organizationID,
      waiting: repo.countWaiting(service.serviceID),
      currentlyServingLabel: serving
        ? serving.queueLabel
        : label(service.prefix, queue ? queue.currentNumber : 0)
    };
  });
}

function getQueueSnapshot(repo, serviceID) {
  const { service, queue } = requireService(repo, serviceID);
  const waiting = repo.countWaiting(serviceID);
  const perPerson = effectiveServiceMinutes(repo, serviceID);
  const serving = repo.getServing(serviceID);

  return {
    serviceID: service.serviceID,
    serviceName: service.serviceName,
    queueStatus: queue.status,
    currentlyServingLabel: serving ? serving.queueLabel : label(service.prefix, queue.currentNumber),
    peopleWaiting: waiting,
    estimatedWaitMinutes: Math.round(waiting * perPerson),
    avgServiceMinutes: perPerson
  };
}

/* peopleAhead is counted from the live queue rather than derived
   from the ticket number, so it stays correct after someone
   leaves or is skipped. */
function getTicket(repo, ticketID) {
  const ticket = repo.getTicket(ticketID);
  if (!ticket) throw new QueueError(`Unknown ticket: ${ticketID}`, 404);

  const service = repo.getService(ticket.serviceID);
  const serving = repo.getServing(ticket.serviceID);
  const perPerson = effectiveServiceMinutes(repo, ticket.serviceID);
  const ahead = ticket.status === "waiting"
    ? repo.countAhead(ticket.serviceID, ticket.queueNumber)
    : 0;

  return {
    ticketID: ticket.ticketID,
    ticketLabel: ticket.queueLabel,
    serviceID: ticket.serviceID,
    serviceName: service ? service.serviceName : "",
    status: ticket.status,
    isYourTurn: ticket.status === "serving",
    peopleAhead: ahead,
    estimatedWaitMinutes: ticket.status === "waiting" ? Math.round(ahead * perPerson) : 0,
    currentlyServingLabel: serving ? serving.queueLabel : null,
    counter: ticket.status === "serving" ? 2 : null,
    joinedAt: ticket.joinedAt
  };
}

function getWaitingList(repo, serviceID) {
  requireService(repo, serviceID);
  const serving = repo.getServing(serviceID);
  const service = repo.getService(serviceID);

  const rows = repo.listWaiting(serviceID).map((ticket, index) => ({
    position: index + 1,
    ticketID: ticket.ticketID,
    number: ticket.queueLabel,
    serviceName: service ? service.serviceName : "",
    status: "Waiting",
    waitingMinutes: minutesBetween(ticket.joinedAt, now())
  }));

  if (serving) {
    rows.unshift({
      position: 0,
      ticketID: serving.ticketID,
      number: serving.queueLabel,
      serviceName: service ? service.serviceName : "",
      status: "Serving",
      waitingMinutes: minutesBetween(serving.joinedAt, serving.calledAt || now())
    });
  }
  return rows;
}

/* Every figure here comes from ticket rows — nothing hardcoded. */
function getStats(repo, serviceID) {
  requireService(repo, serviceID);
  const row = repo.getStatsRow(serviceID) || {};
  const serving = repo.getServing(serviceID);

  return {
    serviceID,
    servedToday: row.servedToday || 0,
    skippedToday: row.skippedToday || 0,
    currentlyWaiting: row.currentlyWaiting || 0,
    currentlyServingLabel: serving ? serving.queueLabel : null,
    avgWaitMinutes: row.avgWaitMinutes === null || row.avgWaitMinutes === undefined
      ? null : Math.round(row.avgWaitMinutes),
    avgServiceMinutes: row.avgServiceMinutes === null || row.avgServiceMinutes === undefined
      ? null : round1(row.avgServiceMinutes),
    servedByHour: repo.getServedByHour(serviceID)
  };
}

/* ---------------------------------------------------------
   WRITES
   Each returns { result, changed } so the caller knows whether
   to persist and broadcast. Multi-step moves run in a
   transaction, so the queue is never observed half-advanced.
--------------------------------------------------------- */

function joinQueue(repo, serviceID, userDetails) {
  const { service, queue } = requireService(repo, serviceID);
  if (queue.status !== "open") throw new QueueError("This queue is currently closed.");

  const ticket = repo.transaction(() => {
    let userID = null;
    if (userDetails && (userDetails.name || userDetails.contact)) {
      const user = {
        userID: makeId("u"),
        name: userDetails.name || "Guest",
        contact: userDetails.contact || null,
        createdAt: now()
      };
      repo.insertUser(user);
      userID = user.userID;
    }

    const assigned = repo.takeNextNumber(serviceID);
    if (assigned === null) throw new QueueError(`Unknown service: ${serviceID}`, 404);

    const row = {
      ticketID: makeId("t"),
      userID,
      queueID: queue.queueID,
      serviceID,
      queueNumber: assigned,
      queueLabel: label(service.prefix, assigned),
      joinedAt: now(),
      calledAt: null,
      closedAt: null,
      status: "waiting"
    };
    repo.insertTicket(row);
    return row;
  });

  return { result: getTicket(repo, ticket.ticketID), changed: true };
}

function leaveQueue(repo, ticketID) {
  const ticket = repo.getTicket(ticketID);
  if (!ticket) throw new QueueError(`Unknown ticket: ${ticketID}`, 404);
  if (ticket.status !== "waiting") {
    throw new QueueError("Only a waiting ticket can be cancelled.", 409);
  }
  repo.updateTicket(ticketID, { status: "left", closedAt: now() });
  return { result: { ticketID, status: "left" }, changed: true };
}

/* CALL NEXT — closes out whoever is at the counter, then
   promotes the next waiting ticket. */
function callNext(repo, serviceID) {
  requireService(repo, serviceID);

  return repo.transaction(() => {
    const current = repo.getServing(serviceID);
    if (current) {
      repo.updateTicket(current.ticketID, { status: "served", closedAt: now() });
    }

    const next = repo.listWaiting(serviceID)[0];
    if (!next) {
      return {
        result: {
          called: null,
          previousServed: current ? current.queueLabel : null,
          message: "No one is waiting."
        },
        changed: Boolean(current)
      };
    }

    repo.updateTicket(next.ticketID, { status: "serving", calledAt: now() });
    repo.setCurrentNumber(serviceID, next.queueNumber);

    return {
      result: {
        called: next.queueLabel,
        ticketID: next.ticketID,
        previousServed: current ? current.queueLabel : null
      },
      changed: true
    };
  });
}

/* MARK SERVED — closes out the person at the counter and stops
   there. Nobody is promoted; staff press CALL NEXT for that. */
function markServed(repo, serviceID) {
  requireService(repo, serviceID);
  const current = repo.getServing(serviceID);
  if (!current) throw new QueueError("Nobody is currently being served.", 409);

  repo.updateTicket(current.ticketID, { status: "served", closedAt: now() });
  return { result: { served: current.queueLabel, ticketID: current.ticketID }, changed: true };
}

/* SKIP — the person did not show up. Records a no-show rather
   than a service, and promotes the next person. */
function skip(repo, serviceID) {
  requireService(repo, serviceID);

  return repo.transaction(() => {
    const target = repo.getServing(serviceID) || repo.listWaiting(serviceID)[0];
    if (!target) throw new QueueError("There is nobody to skip.", 409);

    repo.updateTicket(target.ticketID, { status: "skipped", closedAt: now() });

    const next = repo.listWaiting(serviceID)[0];
    if (next) {
      repo.updateTicket(next.ticketID, { status: "serving", calledAt: now() });
      repo.setCurrentNumber(serviceID, next.queueNumber);
    }

    return {
      result: { skipped: target.queueLabel, called: next ? next.queueLabel : null },
      changed: true
    };
  });
}

function staffLogin(email, password) {
  const accounts = SCHEMA ? SCHEMA.STAFF_ACCOUNTS : [];
  const account = accounts.find(
    a => a.email === String(email || "").trim().toLowerCase() && a.password === password
  );
  if (!account) throw new QueueError("Invalid staff email or password.", 401);
  return { email: account.email, name: account.name };
}

/* ---------------------------------------------------------
   EXPORT
--------------------------------------------------------- */

const ENGINE = {
  QueueError,
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

if (typeof module !== "undefined" && module.exports) module.exports = ENGINE;
if (typeof window !== "undefined") window.QueueLessEngine = ENGINE;

})();
