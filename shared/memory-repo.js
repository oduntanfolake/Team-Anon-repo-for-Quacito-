/* ===========================================================
   QueueLess — in-memory repository
   ===========================================================
   Same interface as server/sqlite-repo.js, backed by plain
   arrays. Two jobs:

     1. the browser's offline fallback, where SQLite cannot run
     2. the engine tests, which should not need a database file

   Because it satisfies the same contract, the queue rules in
   shared/engine.js run unchanged against either one.
   =========================================================== */

(function () {
"use strict";

function createMemoryRepo(seedRows) {
  const schema = (typeof require !== "undefined")
    ? require("./schema")
    : window.QueueLessSchema;

  const rows = seedRows || schema.buildSeedRows();

  const state = {
    organizations: rows.organizations.map(o => ({ ...o })),
    services: rows.services.map(s => ({ ...s })),
    queues: rows.queues.map(q => ({ ...q })),
    tickets: rows.tickets.map(t => ({ ...t })),
    users: []
  };

  const forService = serviceID => state.tickets.filter(t => t.serviceID === serviceID);
  const byNumber = (a, b) => a.queueNumber - b.queueNumber;
  const copy = row => (row ? { ...row } : null);
  const copyAll = list => list.map(r => ({ ...r }));

  return {
    kind: "memory",

    /* ----- reference data ----- */

    listOrganizations() {
      return copyAll(state.organizations).map(o => ({ ...o, isDemo: Boolean(o.isDemo) }));
    },

    listServices(organizationID) {
      return copyAll(
        state.services.filter(s => !organizationID || s.organizationID === organizationID)
      );
    },

    getService(serviceID) {
      return copy(state.services.find(s => s.serviceID === serviceID));
    },

    /* ----- queues ----- */

    getQueue(serviceID) {
      return copy(state.queues.find(q => q.serviceID === serviceID));
    },

    takeNextNumber(serviceID) {
      const queue = state.queues.find(q => q.serviceID === serviceID);
      if (!queue) return null;
      const assigned = queue.nextNumber;
      queue.nextNumber = assigned + 1;
      return assigned;
    },

    setCurrentNumber(serviceID, currentNumber) {
      const queue = state.queues.find(q => q.serviceID === serviceID);
      if (queue) queue.currentNumber = currentNumber;
    },

    /* ----- tickets ----- */

    listTickets(serviceID) {
      return copyAll(forService(serviceID).sort(byNumber));
    },

    listWaiting(serviceID) {
      return copyAll(forService(serviceID).filter(t => t.status === "waiting").sort(byNumber));
    },

    countWaiting(serviceID) {
      return forService(serviceID).filter(t => t.status === "waiting").length;
    },

    countAhead(serviceID, queueNumber) {
      return forService(serviceID)
        .filter(t => t.status === "waiting" && t.queueNumber < queueNumber).length;
    },

    getServing(serviceID) {
      return copy(forService(serviceID).find(t => t.status === "serving"));
    },

    getTicket(ticketID) {
      return copy(state.tickets.find(t => t.ticketID === ticketID));
    },

    insertTicket(ticket) {
      state.tickets.push({ ...ticket });
      return ticket;
    },

    updateTicket(ticketID, fields) {
      const ticket = state.tickets.find(t => t.ticketID === ticketID);
      if (ticket) Object.assign(ticket, fields);
    },

    listRecentServed(serviceID, limit) {
      return copyAll(
        forService(serviceID)
          .filter(t => t.status === "served" && t.calledAt && t.closedAt)
          .sort((a, b) => a.closedAt - b.closedAt)
          .slice(-limit)
      );
    },

    /* ----- users ----- */

    insertUser(user) {
      state.users.push({ ...user });
      return user;
    },

    /* ----- statistics ----- */

    getStatsRow(serviceID) {
      const tickets = forService(serviceID);
      const served = tickets.filter(t => t.status === "served");

      const waits = served
        .filter(t => t.calledAt !== null && t.calledAt !== undefined)
        .map(t => (t.calledAt - t.joinedAt) / 60000);
      const serviceTimes = served
        .filter(t => t.calledAt && t.closedAt)
        .map(t => (t.closedAt - t.calledAt) / 60000);

      const mean = list =>
        list.length ? list.reduce((sum, n) => sum + n, 0) / list.length : null;

      return {
        servedToday: served.length,
        skippedToday: tickets.filter(t => t.status === "skipped").length,
        currentlyWaiting: tickets.filter(t => t.status === "waiting").length,
        avgWaitMinutes: mean(waits),
        avgServiceMinutes: mean(serviceTimes)
      };
    },

    getServedByHour(serviceID) {
      const counts = {};
      forService(serviceID)
        .filter(t => t.status === "served")
        .forEach(t => {
          const hour = new Date(t.closedAt || t.calledAt || t.joinedAt).getHours();
          counts[hour] = (counts[hour] || 0) + 1;
        });
      return Object.keys(counts)
        .map(Number)
        .sort((a, b) => a - b)
        .map(hour => ({ hour, count: counts[hour] }));
    },

    /* No isolation to provide, but the contract has to match so
       the engine can call it either way. */
    transaction(fn) {
      return fn();
    },

    /* Used by the browser client to persist between page loads. */
    snapshot() {
      return JSON.parse(JSON.stringify(state));
    }
  };
}

if (typeof module !== "undefined" && module.exports) module.exports = { createMemoryRepo };
if (typeof window !== "undefined") window.QueueLessMemoryRepo = { createMemoryRepo };

})();
