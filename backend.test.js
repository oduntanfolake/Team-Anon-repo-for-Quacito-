/* ===========================================================
   QueueLess — backend test harness
   Run with:  node backend.test.js
   Covers the Day 3 integration checks from the blueprint plus
   the edge cases that break a naive queue implementation.
   =========================================================== */

var QueueLess = require("./backend.js");
var api = QueueLess.api;

var passed = 0;
var failed = 0;

function check(name, actual, expected) {
  var a = JSON.stringify(actual);
  var e = JSON.stringify(expected);
  if (a === e) {
    passed++;
    console.log("  PASS  " + name);
  } else {
    failed++;
    console.log("  FAIL  " + name + "\n          expected " + e + "\n          actual   " + a);
  }
}

async function run() {
  console.log("\nQueueLess backend tests\n");

  /* --- queue numbers are sequential ------------------------- */
  console.log("Queue number generation");
  await api.resetDemo();

  var snapshot = await api.getQueueSnapshot("doc-collection");
  check("opens on A037 currently serving", snapshot.currentlyServingLabel, "A037");
  check("opens with 12 waiting", snapshot.peopleWaiting, 12);
  check("estimated wait is 12 x 3 min", snapshot.estimatedWaitMinutes, 36);

  var first = await api.joinQueue("doc-collection", { name: "Student One" });
  var second = await api.joinQueue("doc-collection", { name: "Student Two" });
  check("first joiner gets the next free number", first.ticketLabel, "A050");
  check("second joiner gets the one after", second.ticketLabel, "A051");
  check("first joiner has 12 ahead", first.peopleAhead, 12);
  check("second joiner has 13 ahead", second.peopleAhead, 13);

  /* --- each service has its own numbering ------------------- */
  console.log("\nPer-service numbering");
  var reg = await api.joinQueue("registration", { name: "Student Three" });
  check("registration uses its own prefix and counter", reg.ticketLabel, "B025");

  /* --- call next advances the queue ------------------------- */
  console.log("\nCALL NEXT");
  await api.resetDemo();
  var joiner = await api.joinQueue("doc-collection", { name: "Tester" });
  var aheadBefore = joiner.peopleAhead;

  var called = await api.callNext("doc-collection");
  check("call next serves A038", called.called, "A038");
  check("call next closes out the previous person", called.previousServed, "A037");

  var afterOne = await api.getTicket(joiner.ticketID);
  check("people ahead drops by one", afterOne.peopleAhead, aheadBefore - 1);

  var snapAfter = await api.getQueueSnapshot("doc-collection");
  check("currently serving moved to A038", snapAfter.currentlyServingLabel, "A038");
  // 12 seeded + our joiner = 13 waiting, minus the one just promoted.
  check("waiting count drops by one", snapAfter.peopleWaiting, 12);

  /* --- mark served and skip are NOT the same as call next --- */
  console.log("\nMARK SERVED and SKIP are distinct");
  await api.resetDemo();

  var beforeServe = await api.getQueueSnapshot("doc-collection");
  var servedResult = await api.markServed("doc-collection");
  var afterServe = await api.getQueueSnapshot("doc-collection");
  check("mark served closes A037", servedResult.served, "A037");
  check("mark served does not promote anyone", afterServe.peopleWaiting, beforeServe.peopleWaiting);

  await api.resetDemo();
  var skipResult = await api.skip("doc-collection");
  check("skip moves past A037", skipResult.skipped, "A037");
  check("skip promotes A038", skipResult.called, "A038");

  var stats = await api.getStats("doc-collection");
  check("skipped ticket is recorded as skipped, not served", stats.skippedToday, 1);

  /* --- the case a naive implementation gets wrong ----------- */
  console.log("\nPosition stays correct after someone leaves");
  await api.resetDemo();
  var mine = await api.joinQueue("doc-collection", { name: "Me" });
  var aheadAtJoin = mine.peopleAhead;

  var list = await api.getWaitingList("doc-collection");
  var someoneAhead = list.find(function (row) {
    return row.status === "Waiting" && row.ticketID !== mine.ticketID;
  });
  await api.leaveQueue(someoneAhead.ticketID);

  var mineNow = await api.getTicket(mine.ticketID);
  check("leaving reduces my people-ahead", mineNow.peopleAhead, aheadAtJoin - 1);
  check("my ticket number is unchanged", mineNow.ticketLabel, mine.ticketLabel);

  /* --- your turn ------------------------------------------- */
  console.log("\nYour-turn detection");
  await api.resetDemo();
  var solo = await api.joinQueue("transcripts", { name: "Solo" });
  var guard = 0;
  var current = solo;
  while (!current.isYourTurn && guard < 30) {
    await api.callNext("transcripts");
    current = await api.getTicket(solo.ticketID);
    guard++;
  }
  check("ticket eventually reaches serving", current.isYourTurn, true);
  check("people ahead is zero on your turn", current.peopleAhead, 0);

  /* --- empty queue behaviour ------------------------------- */
  console.log("\nEmpty queue");
  await api.resetDemo();
  var drain = 0;
  while (drain < 40) {
    var res = await api.callNext("transcripts");
    if (res.called === null) break;
    drain++;
  }
  var emptied = await api.callNext("transcripts");
  check("call next on an empty queue reports no one waiting", emptied.called, null);
  var emptySnap = await api.getQueueSnapshot("transcripts");
  check("waiting count is zero", emptySnap.peopleWaiting, 0);

  /* --- leaving is only allowed while waiting --------------- */
  console.log("\nGuard rails");
  await api.resetDemo();
  var serving = await api.getWaitingList("doc-collection");
  var atCounter = serving.find(function (r) { return r.status === "Serving"; });
  var rejected = false;
  try {
    await api.leaveQueue(atCounter.ticketID);
  } catch (err) {
    rejected = true;
  }
  check("cannot leave once you are at the counter", rejected, true);

  var badLogin = false;
  try {
    await api.staffLogin("admin@queueless.com", "wrong");
  } catch (err) {
    badLogin = true;
  }
  check("wrong staff password is rejected", badLogin, true);

  /* --- statistics are computed, not hardcoded -------------- */
  console.log("\nStatistics");
  await api.resetDemo();
  var s = await api.getStats("doc-collection");
  check("served today reflects seeded history", s.servedToday, 84);
  check("currently waiting is 12", s.currentlyWaiting, 12);
  check("average wait is a real number", typeof s.avgWaitMinutes === "number", true);
  check("served-by-hour has data for the chart", s.servedByHour.length > 0, true);

  await api.callNext("doc-collection");
  var s2 = await api.getStats("doc-collection");
  check("serving the next person increments served today", s2.servedToday, 85);

  /* --- real-time subscription ------------------------------ */
  console.log("\nReal-time");
  await api.resetDemo();
  var fired = 0;
  var unsubscribe = api.subscribe(function () { fired++; });
  await api.joinQueue("payments", { name: "Watcher" });
  await api.callNext("payments");
  check("subscribers are notified on changes", fired >= 2, true);
  unsubscribe();
  var afterUnsub = fired;
  await api.callNext("payments");
  check("unsubscribe stops notifications", fired, afterUnsub);

  console.log("\n" + passed + " passed, " + failed + " failed\n");
  process.exit(failed === 0 ? 0 : 1);
}

run().catch(function (err) {
  console.error("Test harness crashed:", err);
  process.exit(1);
});
