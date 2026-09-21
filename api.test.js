/* ===========================================================
   QueueLess — API integration tests
   Boots the real Express server on a spare port and exercises
   the endpoints over HTTP, including status codes and SSE.
   Run with:  node api.test.js
   =========================================================== */

"use strict";

const { createApp } = require("./server/app");

let passed = 0;
let failed = 0;

function check(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { passed++; console.log("  PASS  " + name); }
  else { failed++; console.log(`  FAIL  ${name}\n          expected ${e}\n          actual   ${a}`); }
}

(async () => {
  const server = createApp().listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  const call = async (method, path, body) => {
    const res = await fetch(base + path, {
      method,
      headers: body ? { "Content-Type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined
    });
    const payload = await res.json().catch(() => ({}));
    return { status: res.status, body: payload };
  };

  console.log("\nQueueLess API tests\n");

  console.log("Health and static");
  check("health responds", (await call("GET", "/api/health")).body.ok, true);
  const page = await fetch(base + "/");
  check("frontend is served from the same origin", page.status, 200);
  check("frontend is HTML", page.headers.get("content-type").includes("text/html"), true);
  const engineFile = await fetch(base + "/shared/engine.js");
  check("shared engine is reachable by the browser", engineFile.status, 200);

  await call("POST", "/api/demo/reset");

  console.log("\nReads");
  const services = await call("GET", "/api/services?organizationID=uni-admin");
  check("four services for the demo org", services.body.length, 4);
  const snap = await call("GET", "/api/queues/doc-collection");
  check("opens serving A037", snap.body.currentlyServingLabel, "A037");
  check("opens with 12 waiting", snap.body.peopleWaiting, 12);
  check("estimated wait is 36 min", snap.body.estimatedWaitMinutes, 36);

  console.log("\nJoining");
  const join = await call("POST", "/api/queues/doc-collection/tickets", { name: "Ada" });
  check("join returns 200", join.status, 200);
  check("first joiner gets A050", join.body.ticketLabel, "A050");
  const join2 = await call("POST", "/api/queues/doc-collection/tickets", { name: "Grace" });
  check("second joiner gets A051", join2.body.ticketLabel, "A051");
  check("second joiner is behind the first",
    join2.body.peopleAhead, join.body.peopleAhead + 1);

  console.log("\nStaff actions");
  const next = await call("POST", "/api/queues/doc-collection/call-next");
  check("call next serves A038", next.body.called, "A038");
  check("call next closes out A037", next.body.previousServed, "A037");

  const skipped = await call("POST", "/api/queues/doc-collection/skip");
  check("skip marks A038 as a no-show", skipped.body.skipped, "A038");
  check("skip promotes A039", skipped.body.called, "A039");

  const stats = await call("GET", "/api/stats/doc-collection");
  check("a skip is not counted as served", stats.body.skippedToday, 1);
  check("served today counts the one real service", stats.body.servedToday, 85);
  check("served-by-hour is populated for the chart",
    Array.isArray(stats.body.servedByHour) && stats.body.servedByHour.length > 0, true);

  console.log("\nError handling");
  check("unknown service is a 404", (await call("GET", "/api/queues/nope")).status, 404);
  check("unknown ticket is a 404", (await call("GET", "/api/tickets/nope")).status, 404);
  check("unknown endpoint is a 404", (await call("GET", "/api/not-a-route")).status, 404);
  check("bad staff password is a 401",
    (await call("POST", "/api/auth/login", { email: "admin@queueless.com", password: "nope" })).status, 401);
  check("good staff password is a 200",
    (await call("POST", "/api/auth/login", { email: "admin@queueless.com", password: "admin123" })).status, 200);

  const serving = (await call("GET", "/api/queues/doc-collection/tickets")).body
    .find(r => r.status === "Serving");
  check("cannot cancel a ticket already at the counter",
    (await call("DELETE", `/api/tickets/${serving.ticketID}`)).status, 409);

  await call("POST", "/api/demo/reset");
  let drained = 0;
  while (drained < 40) {
    const res = await call("POST", "/api/queues/transcripts/call-next");
    if (res.body.called === null) break;
    drained++;
  }
  check("serving an empty queue is not an error",
    (await call("POST", "/api/queues/transcripts/call-next")).status, 200);
  check("marking served with nobody at the counter is a 409",
    (await call("POST", "/api/queues/transcripts/serve")).status, 409);

  console.log("\nQR code");
  const qr = await fetch(base + "/api/qr?url=" + encodeURIComponent("http://192.168.1.50:3000/"));
  const qrBody = await qr.text();
  check("QR endpoint returns SVG", qr.headers.get("content-type").includes("image/svg+xml"), true);
  check("QR body is a real SVG", qrBody.trimStart().startsWith("<svg"), true);
  check("QR is not empty", qrBody.length > 500, true);

  console.log("\nLive updates (SSE)");
  const events = [];
  const controller = new AbortController();
  const streamDone = fetch(base + "/api/events", { signal: controller.signal })
    .then(async res => {
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const text = decoder.decode(value);
          if (text.includes("queue-changed")) events.push(text);
        }
      } catch (err) { /* aborted */ }
    })
    .catch(() => {});

  await new Promise(r => setTimeout(r, 150));
  await call("POST", "/api/queues/payments/tickets", { name: "Watcher" });
  await new Promise(r => setTimeout(r, 250));
  check("a join is broadcast to listeners", events.length >= 1, true);

  await call("POST", "/api/queues/payments/call-next");
  await new Promise(r => setTimeout(r, 250));
  check("call next is broadcast too", events.length >= 2, true);

  controller.abort();
  await streamDone;

  server.close();
  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
})().catch(err => {
  console.error("API test harness crashed:", err);
  process.exit(1);
});
