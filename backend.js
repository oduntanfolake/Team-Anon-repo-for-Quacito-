/* ===========================================================
   QueueLess — PERSON 2: BACKEND / DATABASE
   ===========================================================
   This file is the queue engine. It owns all data and all
   queue rules; nothing else in the app should mutate state.

   Schema follows the 5-Day Blueprint section 9:
     Users    userID, name, contact, createdAt
     Services serviceID, serviceName, organizationID
     Queues   queueID, serviceID, currentNumber, status
     Tickets  ticketID, userID, queueID, queueNumber,
              joinedAt, status

   The public API (QueueLess.api) is async on purpose. Every
   method returns a Promise and is shaped like the REST call it
   stands in for, so moving to Firebase/Supabase later means
   rewriting the Storage adapter below and nothing else.

   Ticket lifecycle:  waiting -> serving -> served
                      waiting -> serving -> skipped
                      waiting -> left          (user cancelled)
   =========================================================== */

(function (global) {
  "use strict";

  var DB_KEY = "queueless_db_v1";
  var STAFF_SESSION_KEY = "queueless_staff_session";

  /* Demo staff credentials. A real deployment would verify these
     server-side; the blueprint explicitly says not to spend the
     five days on authentication. */
  var STAFF_ACCOUNTS = [
    { email: "admin@queueless.com", password: "admin123", name: "Front Desk" }
  ];

  /* ---------------------------------------------------------
     STORAGE ADAPTER
     The only part that knows *where* data lives. Swap the body
     of these three methods for Firebase/Supabase calls and the
     rest of the backend is unchanged.
  --------------------------------------------------------- */

  var memoryStore = null; // fallback when localStorage is unavailable (Node, private mode)

  var Storage = {
    read: function () {
      try {
        if (!global.localStorage) return memoryStore;
        var raw = global.localStorage.getItem(DB_KEY);
        return raw ? JSON.parse(raw) : null;
      } catch (err) {
        console.warn("QueueLess backend: read failed, using memory.", err);
        return memoryStore;
      }
    },
    write: function (db) {
      memoryStore = db;
      try {
        if (!global.localStorage) return;
        global.localStorage.setItem(DB_KEY, JSON.stringify(db));
      } catch (err) {
        console.warn("QueueLess backend: write failed, memory only.", err);
      }
    },
    clear: function () {
      memoryStore = null;
      try {
        if (global.localStorage) global.localStorage.removeItem(DB_KEY);
      } catch (err) {
        console.warn("QueueLess backend: clear failed.", err);
      }
    }
  };

  /* ---------------------------------------------------------
     SEED DATA
     Numbers chosen to match the screens in the Master Blueprint
     so the demo opens on the documented values (Document
     Collection serving A037, 12 waiting, 84 served today).
  --------------------------------------------------------- */

  var ORGANIZATIONS = [
    { organizationID: "uni-admin",  name: "University Administration", isDemo: true },
    { organizationID: "uni-health", name: "University Health Centre",  isDemo: false },
    { organizationID: "banking",    name: "Banking Services",          isDemo: false },
    { organizationID: "govt",       name: "Government Service Centre", isDemo: false }
  ];

  var SERVICE_SEED = [
    { serviceID: "doc-collection", serviceName: "Document Collection",  organizationID: "uni-admin", prefix: "A", startNumber: 37, waiting: 12, avgServiceMinutes: 3 },
    { serviceID: "registration",   serviceName: "Student Registration", organizationID: "uni-admin", prefix: "B", startNumber: 18, waiting: 6,  avgServiceMinutes: 4 },
    { serviceID: "payments",       serviceName: "Payment / Fees",       organizationID: "uni-admin", prefix: "C", startNumber: 52, waiting: 9,  avgServiceMinutes: 2 },
    { serviceID: "transcripts",    serviceName: "Transcript Request",   organizationID: "uni-admin", prefix: "D", startNumber: 9,  waiting: 3,  avgServiceMinutes: 5 }
  ];

  var SEEDED_SERVED_TODAY = 84;

  /* ---------------------------------------------------------
     HELPERS
  --------------------------------------------------------- */

  function now() { return Date.now(); }

  function clone(value) { return JSON.parse(JSON.stringify(value)); }

  function label(prefix, n) {
    return prefix + String(n).padStart(3, "0");
  }

  var idCounter = 0;
  function makeId(kind) {
    idCounter += 1;
    return kind + "-" + now().toString(36) + "-" + idCounter;
  }

  function minutesBetween(a, b) {
    return Math.max(0, Math.round((b - a) / 60000));
  }

  function average(list) {
    if (!list.length) return null;
    var total = list.reduce(function (sum, n) { return sum + n; }, 0);
    return total / list.length;
  }

  /* ---------------------------------------------------------
     SEEDING
     Builds a believable day: a block of already-served tickets
     (so statistics are computed from real rows rather than
     hardcoded), plus the people currently waiting.
  --------------------------------------------------------- */

  function seed() {
    var db = {
      version: 1,
      users: [],
      services: [],
      queues: [],
      tickets: [],
      seededAt: now()
    };

    var startOfDay = new Date();
    startOfDay.setHours(9, 0, 0, 0);
    var dayStart = startOfDay.getTime();

    SERVICE_SEED.forEach(function (seedService) {
      db.services.push({
        serviceID: seedService.serviceID,
        serviceName: seedService.serviceName,
        organizationID: seedService.organizationID,
        prefix: seedService.prefix,
        avgServiceMinutes: seedService.avgServiceMinutes
      });

      var queueID = "q-" + seedService.serviceID;

      // Historical served tickets, spread backwards across the day.
      // Only Document Collection carries the full history so the
      // dashboard's "served today" matches the blueprint.
      var historyCount = seedService.serviceID === "doc-collection"
        ? SEEDED_SERVED_TODAY
        : Math.round(seedService.startNumber / 2);

      var firstHistoricNumber = seedService.startNumber - historyCount;
      for (var i = 0; i < historyCount; i++) {
        var joined = dayStart + i * 4 * 60000;
        // ~18 min average wait, gently varied so averages are not flat.
        var waited = (15 + (i % 7)) * 60000;
        var called = joined + waited;
        var serviceMs = seedService.avgServiceMinutes * 60000;
        db.tickets.push({
          ticketID: makeId("t"),
          userID: null,
          queueID: queueID,
          queueNumber: firstHistoricNumber + i,
          queueLabel: label(seedService.prefix, firstHistoricNumber + i),
          serviceID: seedService.serviceID,
          joinedAt: joined,
          calledAt: called,
          closedAt: called + serviceMs,
          status: "served"
        });
      }

      // The person currently at the counter.
      var servingJoined = now() - 20 * 60000;
      db.tickets.push({
        ticketID: makeId("t"),
        userID: null,
        queueID: queueID,
        queueNumber: seedService.startNumber,
        queueLabel: label(seedService.prefix, seedService.startNumber),
        serviceID: seedService.serviceID,
        joinedAt: servingJoined,
        calledAt: now() - 2 * 60000,
        closedAt: null,
        status: "serving"
      });

      // The people still waiting behind them.
      for (var w = 1; w <= seedService.waiting; w++) {
        db.tickets.push({
          ticketID: makeId("t"),
          userID: null,
          queueID: queueID,
          queueNumber: seedService.startNumber + w,
          queueLabel: label(seedService.prefix, seedService.startNumber + w),
          serviceID: seedService.serviceID,
          joinedAt: now() - (seedService.waiting - w) * 90000,
          calledAt: null,
          closedAt: null,
          status: "waiting"
        });
      }

      db.queues.push({
        queueID: queueID,
        serviceID: seedService.serviceID,
        currentNumber: seedService.startNumber,
        nextNumber: seedService.startNumber + seedService.waiting + 1,
        status: "open"
      });
    });

    return db;
  }

  /* ---------------------------------------------------------
     DB ACCESS
  --------------------------------------------------------- */

  function load() {
    var db = Storage.read();
    if (!db || !Array.isArray(db.queues) || !db.queues.length) {
      db = seed();
      Storage.write(db);
    }
    return db;
  }

  function save(db) {
    Storage.write(db);
    notify();
  }

  function queueForService(db, serviceID) {
    return db.queues.find(function (q) { return q.serviceID === serviceID; }) || null;
  }

  function serviceById(db, serviceID) {
    return db.services.find(function (s) { return s.serviceID === serviceID; }) || null;
  }

  function ticketsFor(db, serviceID) {
    return db.tickets.filter(function (t) { return t.serviceID === serviceID; });
  }

  function waitingTickets(db, serviceID) {
    return ticketsFor(db, serviceID)
      .filter(function (t) { return t.status === "waiting"; })
      .sort(function (a, b) { return a.queueNumber - b.queueNumber; });
  }

  function servingTicket(db, serviceID) {
    return ticketsFor(db, serviceID).find(function (t) { return t.status === "serving"; }) || null;
  }

  /* Effective service time per person: measured from real served
     rows when we have enough of them, otherwise the seed estimate.
     This is what makes the wait estimate improve as the day runs. */
  function effectiveServiceMinutes(db, serviceID) {
    var service = serviceById(db, serviceID);
    var fallback = service ? service.avgServiceMinutes : 5;
    var recent = ticketsFor(db, serviceID)
      .filter(function (t) { return t.status === "served" && t.calledAt && t.closedAt; })
      .slice(-20)
      .map(function (t) { return (t.closedAt - t.calledAt) / 60000; });
    if (recent.length < 3) return fallback;
    var measured = average(recent);
    return Math.max(1, Math.round(measured * 10) / 10);
  }

  /* ---------------------------------------------------------
     REAL-TIME
     Subscribers are notified after every mutation in this tab,
     and the storage event bridges other tabs (student phone view
     and staff dashboard open side by side during the demo).
  --------------------------------------------------------- */

  var subscribers = [];

  function notify() {
    subscribers.forEach(function (fn) {
      try { fn(); } catch (err) { console.warn("QueueLess backend: subscriber failed.", err); }
    });
  }

  if (global.addEventListener) {
    global.addEventListener("storage", function (event) {
      if (event.key === DB_KEY) notify();
    });
  }

  /* ---------------------------------------------------------
     PUBLIC API
     Async so the call sites already look like network calls.
  --------------------------------------------------------- */

  function respond(value) {
    return Promise.resolve(clone(value));
  }

  function fail(message) {
    return Promise.reject(new Error(message));
  }

  var api = {

    /* GET /organizations */
    getOrganizations: function () {
      return respond(ORGANIZATIONS);
    },

    /* GET /services?organizationID= */
    getServices: function (organizationID) {
      var db = load();
      var list = db.services.filter(function (s) {
        return !organizationID || s.organizationID === organizationID;
      });
      return respond(list.map(function (service) {
        var waiting = waitingTickets(db, service.serviceID);
        var queue = queueForService(db, service.serviceID);
        return {
          serviceID: service.serviceID,
          serviceName: service.serviceName,
          organizationID: service.organizationID,
          waiting: waiting.length,
          currentlyServingLabel: queue ? label(service.prefix, queue.currentNumber) : null
        };
      }));
    },

    /* GET /queues/:serviceID */
    getQueueSnapshot: function (serviceID) {
      var db = load();
      var service = serviceById(db, serviceID);
      var queue = queueForService(db, serviceID);
      if (!service || !queue) return fail("Unknown service: " + serviceID);

      var waiting = waitingTickets(db, serviceID);
      var perPerson = effectiveServiceMinutes(db, serviceID);
      var serving = servingTicket(db, serviceID);

      return respond({
        serviceID: service.serviceID,
        serviceName: service.serviceName,
        queueStatus: queue.status,
        currentlyServingLabel: serving ? serving.queueLabel : label(service.prefix, queue.currentNumber),
        peopleWaiting: waiting.length,
        estimatedWaitMinutes: Math.round(waiting.length * perPerson),
        avgServiceMinutes: perPerson
      });
    },

    /* POST /queues/:serviceID/tickets
       Generates the next sequential number for this service. */
    joinQueue: function (serviceID, userDetails) {
      var db = load();
      var service = serviceById(db, serviceID);
      var queue = queueForService(db, serviceID);
      if (!service || !queue) return fail("Unknown service: " + serviceID);
      if (queue.status !== "open") return fail("This queue is currently closed.");

      var user = null;
      if (userDetails && (userDetails.name || userDetails.contact)) {
        user = {
          userID: makeId("u"),
          name: userDetails.name || "Guest",
          contact: userDetails.contact || null,
          createdAt: now()
        };
        db.users.push(user);
      }

      var assigned = queue.nextNumber;
      queue.nextNumber = assigned + 1;

      var ticket = {
        ticketID: makeId("t"),
        userID: user ? user.userID : null,
        queueID: queue.queueID,
        queueNumber: assigned,
        queueLabel: label(service.prefix, assigned),
        serviceID: serviceID,
        joinedAt: now(),
        calledAt: null,
        closedAt: null,
        status: "waiting"
      };
      db.tickets.push(ticket);
      save(db);

      return api.getTicket(ticket.ticketID);
    },

    /* GET /tickets/:ticketID
       peopleAhead is counted from the live queue rather than
       derived from the number, so it stays correct after someone
       leaves or is skipped. */
    getTicket: function (ticketID) {
      var db = load();
      var ticket = db.tickets.find(function (t) { return t.ticketID === ticketID; });
      if (!ticket) return fail("Unknown ticket: " + ticketID);

      var service = serviceById(db, ticket.serviceID);
      var serving = servingTicket(db, ticket.serviceID);
      var perPerson = effectiveServiceMinutes(db, ticket.serviceID);

      var ahead = waitingTickets(db, ticket.serviceID).filter(function (t) {
        return t.queueNumber < ticket.queueNumber;
      }).length;

      return respond({
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
      });
    },

    /* DELETE /tickets/:ticketID */
    leaveQueue: function (ticketID) {
      var db = load();
      var ticket = db.tickets.find(function (t) { return t.ticketID === ticketID; });
      if (!ticket) return fail("Unknown ticket: " + ticketID);
      if (ticket.status !== "waiting") {
        return fail("Only a waiting ticket can be cancelled.");
      }
      ticket.status = "left";
      ticket.closedAt = now();
      save(db);
      return respond({ ticketID: ticketID, status: "left" });
    },

    /* POST /queues/:serviceID/call-next
       Closes out whoever is at the counter, then promotes the
       next waiting ticket. */
    callNext: function (serviceID) {
      var db = load();
      var queue = queueForService(db, serviceID);
      if (!queue) return fail("Unknown service: " + serviceID);

      var current = servingTicket(db, serviceID);
      if (current) {
        current.status = "served";
        current.closedAt = now();
      }

      var next = waitingTickets(db, serviceID)[0];
      if (!next) {
        save(db);
        return respond({ called: null, message: "No one is waiting." });
      }

      next.status = "serving";
      next.calledAt = now();
      queue.currentNumber = next.queueNumber;
      save(db);

      return respond({
        called: next.queueLabel,
        ticketID: next.ticketID,
        previousServed: current ? current.queueLabel : null
      });
    },

    /* POST /queues/:serviceID/serve
       Marks the person at the counter as finished. Does not
       promote anyone — staff press CALL NEXT for that. */
    markServed: function (serviceID) {
      var db = load();
      var current = servingTicket(db, serviceID);
      if (!current) return fail("Nobody is currently being served.");

      current.status = "served";
      current.closedAt = now();
      save(db);

      return respond({ served: current.queueLabel, ticketID: current.ticketID });
    },

    /* POST /queues/:serviceID/skip
       Moves past the current person (they did not show up) and
       promotes the next one. */
    skip: function (serviceID) {
      var db = load();
      var queue = queueForService(db, serviceID);
      if (!queue) return fail("Unknown service: " + serviceID);

      var target = servingTicket(db, serviceID) || waitingTickets(db, serviceID)[0];
      if (!target) return fail("There is nobody to skip.");

      target.status = "skipped";
      target.closedAt = now();

      var next = waitingTickets(db, serviceID)[0];
      if (next) {
        next.status = "serving";
        next.calledAt = now();
        queue.currentNumber = next.queueNumber;
      }
      save(db);

      return respond({
        skipped: target.queueLabel,
        called: next ? next.queueLabel : null
      });
    },

    /* GET /queues/:serviceID/tickets — the dashboard's waiting list */
    getWaitingList: function (serviceID) {
      var db = load();
      var serving = servingTicket(db, serviceID);
      var rows = waitingTickets(db, serviceID).map(function (ticket, index) {
        return {
          position: index + 1,
          ticketID: ticket.ticketID,
          number: ticket.queueLabel,
          serviceName: (serviceById(db, ticket.serviceID) || {}).serviceName || "",
          status: "Waiting",
          waitingMinutes: minutesBetween(ticket.joinedAt, now())
        };
      });
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
      return respond(rows);
    },

    /* GET /stats/:serviceID — everything computed from ticket rows */
    getStats: function (serviceID) {
      var db = load();
      var tickets = ticketsFor(db, serviceID);
      var served = tickets.filter(function (t) { return t.status === "served"; });
      var skipped = tickets.filter(function (t) { return t.status === "skipped"; });
      var waiting = waitingTickets(db, serviceID);
      var serving = servingTicket(db, serviceID);

      var waits = served
        .filter(function (t) { return t.calledAt; })
        .map(function (t) { return (t.calledAt - t.joinedAt) / 60000; });

      var serviceTimes = served
        .filter(function (t) { return t.calledAt && t.closedAt; })
        .map(function (t) { return (t.closedAt - t.calledAt) / 60000; });

      // Served per hour, for the optional bar chart in the blueprint.
      var byHour = {};
      served.forEach(function (t) {
        var hour = new Date(t.closedAt || t.calledAt || t.joinedAt).getHours();
        byHour[hour] = (byHour[hour] || 0) + 1;
      });

      var avgWait = average(waits);
      var avgService = average(serviceTimes);

      return respond({
        serviceID: serviceID,
        servedToday: served.length,
        skippedToday: skipped.length,
        currentlyWaiting: waiting.length,
        currentlyServingLabel: serving ? serving.queueLabel : null,
        avgWaitMinutes: avgWait === null ? null : Math.round(avgWait),
        avgServiceMinutes: avgService === null ? null : Math.round(avgService * 10) / 10,
        servedByHour: Object.keys(byHour).sort(function (a, b) { return a - b; }).map(function (h) {
          return { hour: Number(h), count: byHour[h] };
        })
      });
    },

    /* POST /auth/login — demo-grade, per the blueprint's guidance */
    staffLogin: function (email, password) {
      var account = STAFF_ACCOUNTS.find(function (a) {
        return a.email === String(email).trim().toLowerCase() && a.password === password;
      });
      if (!account) return fail("Invalid staff email or password.");
      try {
        if (global.sessionStorage) global.sessionStorage.setItem(STAFF_SESSION_KEY, "true");
      } catch (err) { /* session persistence is optional */ }
      return respond({ email: account.email, name: account.name });
    },

    staffLogout: function () {
      try {
        if (global.sessionStorage) global.sessionStorage.removeItem(STAFF_SESSION_KEY);
      } catch (err) { /* ignore */ }
      return respond({ ok: true });
    },

    isStaffLoggedIn: function () {
      try {
        return global.sessionStorage
          ? global.sessionStorage.getItem(STAFF_SESSION_KEY) === "true"
          : false;
      } catch (err) {
        return false;
      }
    },

    /* Rehearsal helper: puts the data back to its opening state
       so the demo can be run repeatedly without editing code. */
    resetDemo: function () {
      Storage.clear();
      var db = seed();
      Storage.write(db);
      notify();
      return respond({ ok: true });
    },

    /* Real-time subscription. Returns an unsubscribe function. */
    subscribe: function (fn) {
      if (typeof fn !== "function") return function () {};
      subscribers.push(fn);
      return function () {
        subscribers = subscribers.filter(function (s) { return s !== fn; });
      };
    }
  };

  /* ---------------------------------------------------------
     EXPORT
  --------------------------------------------------------- */

  var QueueLess = {
    api: api,
    DB_KEY: DB_KEY,
    _internal: { seed: seed, load: load, Storage: Storage }
  };

  global.QueueLess = QueueLess;

  if (typeof module !== "undefined" && module.exports) {
    module.exports = QueueLess;
  }

})(typeof window !== "undefined" ? window : globalThis);
