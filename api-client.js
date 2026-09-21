/* ===========================================================
   QueueLess — browser API client
   ===========================================================
   Exposes window.QueueLess.api. Every method returns a Promise
   and matches an endpoint on the Express server.

   It runs in one of two modes, chosen automatically at startup:

     server  the normal mode. Calls the API over HTTP and gets
             live updates over Server-Sent Events, so phones and
             laptops all see the same queue.

     local   the safety net. If the server cannot be reached, the
             same queue engine runs in the browser against
             localStorage. The app stays fully usable; it just
             cannot sync across devices.

   The fallback exists so a demo can never be sunk by a laptop
   that will not boot the server or a venue wifi that blocks
   device-to-device traffic. Both modes run shared/engine.js, so
   the queue rules are identical either way.
   =========================================================== */

(function (global) {
  "use strict";

  var API_BASE = "/api";
  var LOCAL_DB_KEY = "queueless_local_db_v2";
  var STAFF_SESSION_KEY = "queueless_staff_session";

  var engine = global.QueueLessEngine;
  if (!engine) throw new Error("QueueLess: shared/engine.js must load before api-client.js");

  var mode = "connecting";
  var subscribers = [];

  function notify() {
    subscribers.forEach(function (fn) {
      try { fn(); } catch (err) { console.warn("QueueLess: subscriber failed.", err); }
    });
  }

  /* ---------------------------------------------------------
     LOCAL MODE
  --------------------------------------------------------- */

  var localDb = null;

  function getLocalDb() {
    if (localDb) return localDb;
    try {
      var raw = global.localStorage && global.localStorage.getItem(LOCAL_DB_KEY);
      var parsed = raw ? JSON.parse(raw) : null;
      if (parsed && Array.isArray(parsed.queues) && parsed.queues.length) {
        localDb = parsed;
        return localDb;
      }
    } catch (err) {
      console.warn("QueueLess: could not read local data, reseeding.", err);
    }
    localDb = engine.seed();
    saveLocalDb();
    return localDb;
  }

  function saveLocalDb() {
    try {
      if (global.localStorage) {
        global.localStorage.setItem(LOCAL_DB_KEY, JSON.stringify(localDb));
      }
    } catch (err) {
      console.warn("QueueLess: could not save local data.", err);
    }
  }

  // Another tab in this browser changed the data.
  if (global.addEventListener) {
    global.addEventListener("storage", function (event) {
      if (event.key === LOCAL_DB_KEY) {
        localDb = null;
        notify();
      }
    });
  }

  function localRead(fn) {
    return new Promise(function (resolve) { resolve(fn(getLocalDb())); });
  }

  function localWrite(fn) {
    return new Promise(function (resolve) {
      var outcome = fn(getLocalDb());
      if (outcome.changed) {
        saveLocalDb();
        notify();
      }
      resolve(outcome.result);
    });
  }

  /* ---------------------------------------------------------
     SERVER MODE
  --------------------------------------------------------- */

  function request(method, path, body) {
    var options = { method: method, headers: {} };
    if (body !== undefined) {
      options.headers["Content-Type"] = "application/json";
      options.body = JSON.stringify(body);
    }
    return fetch(API_BASE + path, options).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (payload) {
        if (!res.ok) throw new Error(payload.error || "Request failed (" + res.status + ")");
        return payload;
      });
    });
  }

  var eventSource = null;

  function openEventStream() {
    if (!global.EventSource || eventSource) return;
    eventSource = new EventSource(API_BASE + "/events");
    eventSource.addEventListener("queue-changed", notify);
    eventSource.onerror = function () {
      // EventSource reconnects on its own; nothing to do but let it.
    };
  }

  /* ---------------------------------------------------------
     MODE SELECTION
     Everything waits on this, so the first call cannot race the
     probe. The timeout keeps a hanging server from freezing the
     app — we drop to local mode instead.
  --------------------------------------------------------- */

  function probe() {
    return new Promise(function (resolve) {
      var settled = false;
      var timer = setTimeout(function () {
        if (!settled) { settled = true; resolve(false); }
      }, 2500);

      fetch(API_BASE + "/health", { cache: "no-store" })
        .then(function (res) { return res.ok; })
        .catch(function () { return false; })
        .then(function (ok) {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(ok);
        });
    });
  }

  var ready = probe().then(function (serverUp) {
    mode = serverUp ? "server" : "local";
    if (serverUp) {
      openEventStream();
    } else {
      console.warn(
        "QueueLess: no server reachable — running the queue in this browser.\n" +
        "Start it with `npm start` for live updates across devices."
      );
    }
    notify();
    return mode;
  });

  function call(serverFn, localFn) {
    return ready.then(function () {
      return mode === "server" ? serverFn() : localFn();
    });
  }

  /* ---------------------------------------------------------
     PUBLIC API
  --------------------------------------------------------- */

  var api = {

    getOrganizations: function () {
      return call(
        function () { return request("GET", "/organizations"); },
        function () { return localRead(function () { return engine.getOrganizations(); }); }
      );
    },

    getServices: function (organizationID) {
      var query = organizationID ? "?organizationID=" + encodeURIComponent(organizationID) : "";
      return call(
        function () { return request("GET", "/services" + query); },
        function () { return localRead(function (db) { return engine.getServices(db, organizationID); }); }
      );
    },

    getQueueSnapshot: function (serviceID) {
      return call(
        function () { return request("GET", "/queues/" + encodeURIComponent(serviceID)); },
        function () { return localRead(function (db) { return engine.getQueueSnapshot(db, serviceID); }); }
      );
    },

    joinQueue: function (serviceID, user) {
      return call(
        function () { return request("POST", "/queues/" + encodeURIComponent(serviceID) + "/tickets", user || {}); },
        function () { return localWrite(function (db) { return engine.joinQueue(db, serviceID, user || {}); }); }
      );
    },

    getTicket: function (ticketID) {
      return call(
        function () { return request("GET", "/tickets/" + encodeURIComponent(ticketID)); },
        function () { return localRead(function (db) { return engine.getTicket(db, ticketID); }); }
      );
    },

    leaveQueue: function (ticketID) {
      return call(
        function () { return request("DELETE", "/tickets/" + encodeURIComponent(ticketID)); },
        function () { return localWrite(function (db) { return engine.leaveQueue(db, ticketID); }); }
      );
    },

    callNext: function (serviceID) {
      return call(
        function () { return request("POST", "/queues/" + encodeURIComponent(serviceID) + "/call-next"); },
        function () { return localWrite(function (db) { return engine.callNext(db, serviceID); }); }
      );
    },

    markServed: function (serviceID) {
      return call(
        function () { return request("POST", "/queues/" + encodeURIComponent(serviceID) + "/serve"); },
        function () { return localWrite(function (db) { return engine.markServed(db, serviceID); }); }
      );
    },

    skip: function (serviceID) {
      return call(
        function () { return request("POST", "/queues/" + encodeURIComponent(serviceID) + "/skip"); },
        function () { return localWrite(function (db) { return engine.skip(db, serviceID); }); }
      );
    },

    getWaitingList: function (serviceID) {
      return call(
        function () { return request("GET", "/queues/" + encodeURIComponent(serviceID) + "/tickets"); },
        function () { return localRead(function (db) { return engine.getWaitingList(db, serviceID); }); }
      );
    },

    getStats: function (serviceID) {
      return call(
        function () { return request("GET", "/stats/" + encodeURIComponent(serviceID)); },
        function () { return localRead(function (db) { return engine.getStats(db, serviceID); }); }
      );
    },

    staffLogin: function (email, password) {
      return call(
        function () { return request("POST", "/auth/login", { email: email, password: password }); },
        function () { return localRead(function () { return engine.staffLogin(email, password); }); }
      ).then(function (account) {
        try {
          if (global.sessionStorage) global.sessionStorage.setItem(STAFF_SESSION_KEY, "true");
        } catch (err) { /* session persistence is optional */ }
        return account;
      });
    },

    staffLogout: function () {
      try {
        if (global.sessionStorage) global.sessionStorage.removeItem(STAFF_SESSION_KEY);
      } catch (err) { /* ignore */ }
      return Promise.resolve({ ok: true });
    },

    /* Synchronous on purpose — the frontend checks it during a
       click handler, before any await. */
    isStaffLoggedIn: function () {
      try {
        return global.sessionStorage
          ? global.sessionStorage.getItem(STAFF_SESSION_KEY) === "true"
          : false;
      } catch (err) {
        return false;
      }
    },

    resetDemo: function () {
      return call(
        function () { return request("POST", "/demo/reset"); },
        function () {
          localDb = engine.seed();
          saveLocalDb();
          notify();
          return Promise.resolve({ ok: true });
        }
      );
    },

    subscribe: function (fn) {
      if (typeof fn !== "function") return function () {};
      subscribers.push(fn);
      return function () {
        subscribers = subscribers.filter(function (s) { return s !== fn; });
      };
    },

    /* Lets the UI say which mode it is in, and where the QR code
       should point. */
    getMode: function () { return mode; },
    whenReady: function () { return ready; },
    getQrEndpoint: function () { return API_BASE + "/qr"; }
  };

  global.QueueLess = { api: api };

})(window);
