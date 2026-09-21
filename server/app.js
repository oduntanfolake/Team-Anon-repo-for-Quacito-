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
const QRCode = require("qrcode");
const engine = require("../shared/engine");
const database = require("./database");
const { createSqliteRepo } = require("./sqlite-repo");

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

  const repo = createSqliteRepo();

  // Wraps a read so engine errors become proper status codes.
  const read = handler => (req, res, next) => {
    try {
      res.json(handler(repo, req));
    } catch (err) {
      next(err);
    }
  };

  // Wraps a write. The repository has already committed by the
  // time this returns, so all that is left is telling everyone.
  const write = (reason, handler) => (req, res, next) => {
    try {
      const { result, changed } = handler(repo, req);
      if (changed) broadcast(reason);
      res.json(result);
    } catch (err) {
      next(err);
    }
  };

  /* ------------------------------------------------------- */
  /* Routes                                                   */
  /* ------------------------------------------------------- */

  app.get("/api/health", (req, res) => {
    res.json({
      ok: true,
      uptimeSeconds: Math.round(process.uptime()),
      database: { driver: database.connect().driver, file: database.DB_FILE }
    });
  });

  app.get("/api/organizations", read(repoArg => engine.getOrganizations(repoArg)));

  app.get("/api/services", read((repo, req) =>
    engine.getServices(repo, req.query.organizationID)));

  app.get("/api/queues/:serviceID", read((repo, req) =>
    engine.getQueueSnapshot(repo, req.params.serviceID)));

  app.get("/api/queues/:serviceID/tickets", read((repo, req) =>
    engine.getWaitingList(repo, req.params.serviceID)));

  app.get("/api/stats/:serviceID", read((repo, req) =>
    engine.getStats(repo, req.params.serviceID)));

  app.get("/api/tickets/:ticketID", read((repo, req) =>
    engine.getTicket(repo, req.params.ticketID)));

  app.post("/api/queues/:serviceID/tickets", write("join", (repo, req) =>
    engine.joinQueue(repo, req.params.serviceID, req.body || {})));

  app.delete("/api/tickets/:ticketID", write("leave", (repo, req) =>
    engine.leaveQueue(repo, req.params.ticketID)));

  app.post("/api/queues/:serviceID/call-next", write("call-next", (repo, req) =>
    engine.callNext(repo, req.params.serviceID)));

  app.post("/api/queues/:serviceID/serve", write("mark-served", (repo, req) =>
    engine.markServed(repo, req.params.serviceID)));

  app.post("/api/queues/:serviceID/skip", write("skip", (repo, req) =>
    engine.skip(repo, req.params.serviceID)));

  app.post("/api/auth/login", (req, res, next) => {
    try {
      const { email, password } = req.body || {};
      res.json(engine.staffLogin(email, password));
    } catch (err) {
      next(err);
    }
  });

  /* ------------------------------------------------------- */
  /* QR code                                                  */
  /* ------------------------------------------------------- */

  /* Rendered server-side so the page needs no QR library and
     still works with no internet at the venue. Defaults to the
     address the request already came in on, which is the one
     that will actually work for a phone on the same wifi. */
  app.get("/api/qr", async (req, res, next) => {
    try {
      const target = req.query.url || `${req.protocol}://${req.get("host")}/`;
      const svg = await QRCode.toString(String(target), {
        type: "svg",
        margin: 1,
        width: 240,
        errorCorrectionLevel: "M"
      });
      res.type("image/svg+xml").set("Cache-Control", "no-cache").send(svg);
    } catch (err) {
      next(err);
    }
  });

  /* Rehearsal helper so the demo can be rerun without touching
     code or the data file. */
  app.post("/api/demo/reset", (req, res) => {
    database.reset();
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
