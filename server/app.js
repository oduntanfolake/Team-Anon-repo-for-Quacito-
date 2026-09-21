/* ===========================================================
   QueueLess — HTTP API
   ===========================================================
   Thin Express layer over server/engine.js. Routes validate the
   request, call the engine, persist, and broadcast the change to
   every connected client.

   Live updates use Server-Sent Events on GET /api/events. SSE is
   one-way server-to-client, which is all a queue display needs,
   and it reconnects by itself if the phone drops off wifi during
   the demo.
   =========================================================== */

"use strict";

const path = require("path");
const express = require("express");
const engine = require("./engine");
const store = require("./store");

function createApp() {
  const app = express();
  app.use(express.json());

  /* ------------------------------------------------------- */
  /* Live updates                                             */
  /* ------------------------------------------------------- */

  let clients = [];
  let clientId = 0;

  function broadcast(reason) {
    const payload = `event: queue-changed\ndata: ${JSON.stringify({ reason, at: Date.now() })}\n\n`;
    for (const client of clients) {
      try {
        client.res.write(payload);
      } catch (err) {
        // The client has gone; the close handler will remove it.
      }
    }
  }

  app.get("/api/events", (req, res) => {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no"
    });
    res.write("retry: 2000\n\n");
    res.write(`event: connected\ndata: ${JSON.stringify({ at: Date.now() })}\n\n`);

    const id = ++clientId;
    clients.push({ id, res });

    // Comment frames keep proxies from closing an idle connection.
    const heartbeat = setInterval(() => {
      try { res.write(": ping\n\n"); } catch (err) { /* closing */ }
    }, 20000);

    req.on("close", () => {
      clearInterval(heartbeat);
      clients = clients.filter(c => c.id !== id);
    });
  });

  /* ------------------------------------------------------- */
  /* Helpers                                                  */
  /* ------------------------------------------------------- */

  // Wraps a read so engine errors become proper status codes.
  const read = handler => (req, res, next) => {
    try {
      res.json(handler(store.getDb(), req));
    } catch (err) {
      next(err);
    }
  };

  // Wraps a write: run it, persist and broadcast only if it
  // actually changed something.
  const write = (reason, handler) => (req, res, next) => {
    try {
      const { result, changed } = handler(store.getDb(), req);
      if (changed) {
        store.flush();
        broadcast(reason);
      }
      res.json(result);
    } catch (err) {
      next(err);
    }
  };

  /* ------------------------------------------------------- */
  /* Routes                                                   */
  /* ------------------------------------------------------- */

  app.get("/api/health", (req, res) => {
    res.json({ ok: true, uptimeSeconds: Math.round(process.uptime()) });
  });

  app.get("/api/organizations", read(() => engine.getOrganizations()));

  app.get("/api/services", read((db, req) =>
    engine.getServices(db, req.query.organizationID)));

  app.get("/api/queues/:serviceID", read((db, req) =>
    engine.getQueueSnapshot(db, req.params.serviceID)));

  app.get("/api/queues/:serviceID/tickets", read((db, req) =>
    engine.getWaitingList(db, req.params.serviceID)));

  app.get("/api/stats/:serviceID", read((db, req) =>
    engine.getStats(db, req.params.serviceID)));

  app.get("/api/tickets/:ticketID", read((db, req) =>
    engine.getTicket(db, req.params.ticketID)));

  app.post("/api/queues/:serviceID/tickets", write("join", (db, req) =>
    engine.joinQueue(db, req.params.serviceID, req.body || {})));

  app.delete("/api/tickets/:ticketID", write("leave", (db, req) =>
    engine.leaveQueue(db, req.params.ticketID)));

  app.post("/api/queues/:serviceID/call-next", write("call-next", (db, req) =>
    engine.callNext(db, req.params.serviceID)));

  app.post("/api/queues/:serviceID/serve", write("mark-served", (db, req) =>
    engine.markServed(db, req.params.serviceID)));

  app.post("/api/queues/:serviceID/skip", write("skip", (db, req) =>
    engine.skip(db, req.params.serviceID)));

  app.post("/api/auth/login", (req, res, next) => {
    try {
      const { email, password } = req.body || {};
      res.json(engine.staffLogin(email, password));
    } catch (err) {
      next(err);
    }
  });

  /* Rehearsal helper so the demo can be rerun without touching
     code or the data file. */
  app.post("/api/demo/reset", (req, res) => {
    store.reset();
    broadcast("reset");
    res.json({ ok: true });
  });

  /* ------------------------------------------------------- */
  /* Static frontend                                          */
  /* ------------------------------------------------------- */

  // Served from the same origin as the API, so there is no CORS
  // to configure and the phone only needs one URL.
  app.use(express.static(path.join(__dirname, ".."), {
    index: "index.html",
    extensions: ["html"]
  }));

  /* ------------------------------------------------------- */
  /* Errors                                                   */
  /* ------------------------------------------------------- */

  app.use("/api", (req, res) => {
    res.status(404).json({ error: `No such endpoint: ${req.method} ${req.originalUrl}` });
  });

  app.use((err, req, res, next) => {
    const status = err instanceof engine.QueueError ? err.status : 500;
    if (status === 500) console.error("QueueLess: unexpected error.", err);
    res.status(status).json({ error: err.message || "Server error" });
  });

  return app;
}

module.exports = { createApp };
