/* ===========================================================
   QueueLess — SQLite repository
   ===========================================================
   The storage half of the backend. Every read is a query and
   every write is a statement; the queue rules live in
   shared/engine.js and never see SQL.

   Ordering, filtering and counting are pushed into SQL rather
   than pulled into JavaScript, so the indexes declared in
   server/database.js actually get used.
   =========================================================== */

"use strict";

const database = require("./database");

function createSqliteRepo(handle) {
  const h = handle || database.connect();

  return {
    kind: "sqlite",

    /* ----- reference data ----- */

    listOrganizations() {
      return h.all("SELECT organizationID, name, isDemo FROM organizations")
        .map(o => ({ ...o, isDemo: Boolean(o.isDemo) }));
    },

    listServices(organizationID) {
      return organizationID
        ? h.all("SELECT * FROM services WHERE organizationID = ? ORDER BY rowid", organizationID)
        : h.all("SELECT * FROM services ORDER BY rowid");
    },

    getService(serviceID) {
      return h.get("SELECT * FROM services WHERE serviceID = ?", serviceID);
    },

    /* ----- queues ----- */

    getQueue(serviceID) {
      return h.get("SELECT * FROM queues WHERE serviceID = ?", serviceID);
    },

    /* Hands out the next number and advances the counter in one
       statement, so two people joining at the same moment cannot
       be handed the same ticket. */
    takeNextNumber(serviceID) {
      const row = h.get(
        `UPDATE queues SET nextNumber = nextNumber + 1
         WHERE serviceID = ?
         RETURNING nextNumber - 1 AS assigned`,
        serviceID
      );
      return row ? row.assigned : null;
    },

    setCurrentNumber(serviceID, currentNumber) {
      h.run("UPDATE queues SET currentNumber = ? WHERE serviceID = ?", currentNumber, serviceID);
    },

    /* ----- tickets ----- */

    listTickets(serviceID) {
      return h.all("SELECT * FROM tickets WHERE serviceID = ? ORDER BY queueNumber", serviceID);
    },

    listWaiting(serviceID) {
      return h.all(
        "SELECT * FROM tickets WHERE serviceID = ? AND status = 'waiting' ORDER BY queueNumber",
        serviceID
      );
    },

    countWaiting(serviceID) {
      return h.get(
        "SELECT COUNT(*) AS n FROM tickets WHERE serviceID = ? AND status = 'waiting'",
        serviceID
      ).n;
    },

    countAhead(serviceID, queueNumber) {
      return h.get(
        `SELECT COUNT(*) AS n FROM tickets
         WHERE serviceID = ? AND status = 'waiting' AND queueNumber < ?`,
        serviceID, queueNumber
      ).n;
    },

    getServing(serviceID) {
      return h.get("SELECT * FROM tickets WHERE serviceID = ? AND status = 'serving'", serviceID);
    },

    getTicket(ticketID) {
      return h.get("SELECT * FROM tickets WHERE ticketID = ?", ticketID);
    },

    insertTicket(ticket) {
      h.run(
        `INSERT INTO tickets
           (ticketID, userID, queueID, serviceID, queueNumber, queueLabel,
            joinedAt, calledAt, closedAt, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ticket.ticketID, ticket.userID, ticket.queueID, ticket.serviceID,
        ticket.queueNumber, ticket.queueLabel, ticket.joinedAt,
        ticket.calledAt, ticket.closedAt, ticket.status
      );
      return ticket;
    },

    updateTicket(ticketID, fields) {
      const columns = Object.keys(fields);
      if (!columns.length) return;
      h.run(
        `UPDATE tickets SET ${columns.map(c => `${c} = ?`).join(", ")} WHERE ticketID = ?`,
        ...columns.map(c => fields[c]), ticketID
      );
    },

    /* The most recent closed services, newest last — used to
       measure how long a turn actually takes. */
    listRecentServed(serviceID, limit) {
      return h.all(
        `SELECT * FROM (
           SELECT * FROM tickets
           WHERE serviceID = ? AND status = 'served'
             AND calledAt IS NOT NULL AND closedAt IS NOT NULL
           ORDER BY closedAt DESC LIMIT ?
         ) ORDER BY closedAt ASC`,
        serviceID, limit
      );
    },

    /* ----- users ----- */

    insertUser(user) {
      h.run(
        "INSERT INTO users (userID, name, contact, createdAt) VALUES (?, ?, ?, ?)",
        user.userID, user.name, user.contact, user.createdAt
      );
      return user;
    },

    /* ----- statistics -----
       Aggregated in SQL so the dashboard stays cheap no matter
       how many tickets the day has accumulated. */

    getStatsRow(serviceID) {
      return h.get(
        `SELECT
           SUM(status = 'served')  AS servedToday,
           SUM(status = 'skipped') AS skippedToday,
           SUM(status = 'waiting') AS currentlyWaiting,
           AVG(CASE WHEN status = 'served' AND calledAt IS NOT NULL
                    THEN (calledAt - joinedAt) / 60000.0 END) AS avgWaitMinutes,
           AVG(CASE WHEN status = 'served' AND calledAt IS NOT NULL AND closedAt IS NOT NULL
                    THEN (closedAt - calledAt) / 60000.0 END) AS avgServiceMinutes
         FROM tickets WHERE serviceID = ?`,
        serviceID
      );
    },

    getServedByHour(serviceID) {
      return h.all(
        `SELECT CAST(strftime('%H', COALESCE(closedAt, calledAt, joinedAt) / 1000, 'unixepoch', 'localtime') AS INTEGER) AS hour,
                COUNT(*) AS count
         FROM tickets
         WHERE serviceID = ? AND status = 'served'
         GROUP BY hour ORDER BY hour`,
        serviceID
      );
    },

    /* ----- transactions ----- */

    transaction(fn) {
      return h.transaction(fn);
    }
  };
}

module.exports = { createSqliteRepo };
