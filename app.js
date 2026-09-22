/* ===========================================================
   QueueLess — frontend logic
   Handles: view navigation and rendering.

   All queue data and queue rules live behind QueueLess.api
   (api-client.js -> the Express server, or the same engine run
   locally if the server is unreachable). This file only asks for
   data and paints it; it never mutates queue state directly.
   =========================================================== */

var api = window.QueueLess.api;

/* The demo organization, per the Master Blueprint. */
var ORG_ID = "uni-admin";

/* The ticket this browser is holding, kept so the user can
   reopen the app and still find their place in the queue. */
var ACTIVE_TICKET_KEY = "queueless_active_ticket";

var activeTicketId = null;
try {
  activeTicketId = localStorage.getItem(ACTIVE_TICKET_KEY);
} catch (error) {
  console.warn("QueueLess: unable to read the saved ticket.", error);
}

function rememberTicket(ticketID) {
  activeTicketId = ticketID;
  try {
    if (ticketID) localStorage.setItem(ACTIVE_TICKET_KEY, ticketID);
    else localStorage.removeItem(ACTIVE_TICKET_KEY);
  } catch (error) {
    console.warn("QueueLess: unable to save the ticket.", error);
  }
}

/* The service the staff dashboard is currently managing. */
var staffServiceId = "doc-collection";

var lastKnownAhead = null;

/* ---------------------------------------------------------
   VIEW NAVIGATION
--------------------------------------------------------- */

// The Queue Status and dashboard screens re-read the backend on a
// timer so they keep up with changes made in another tab. We
// start/stop it as views open and close so nothing keeps polling
// in the background.
var liveRefreshInterval = null;

function stopLiveRefresh() {
  if (liveRefreshInterval) {
    clearInterval(liveRefreshInterval);
    liveRefreshInterval = null;
  }
}

function showView(name) {
  var frame = document.querySelector(".app-frame");
  if (frame) {
    frame.classList.toggle("staff-mode", name === "staff-dashboard" || name === "staff-login");
  }
  document.querySelectorAll(".view").forEach(function (el) {
    el.classList.toggle("active", el.dataset.view === name);
  });
  window.scrollTo(0, 0);

  stopLiveRefresh();
  if (name === "status") {
    liveRefreshInterval = setInterval(renderStatus, 3000);
  } else if (name === "staff-dashboard") {
    liveRefreshInterval = setInterval(renderStaffQueue, 3000);
  }
}

/* ---------------------------------------------------------
   SMALL UI HELPERS (toast + tactile feedback)
--------------------------------------------------------- */

var toastTimer = null;
function showToast(message) {
  var toast = document.getElementById("toast");
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function () { toast.classList.remove("show"); }, 2200);
}

// Adds a brief "pressed" ripple to any .btn on click — purely
// cosmetic feedback layered on top of each button's real handler.
document.querySelectorAll(".btn").forEach(function (btn) {
  btn.addEventListener("click", function () {
    btn.classList.remove("is-pressed");
    // Force reflow so the animation can re-trigger on rapid clicks.
    void btn.offsetWidth;
    btn.classList.add("is-pressed");
    setTimeout(function () { btn.classList.remove("is-pressed"); }, 500);
  });
});

// Briefly flashes a class on an element to draw the eye to a
// value that just changed (used for numbers ticking forward).
function flash(el, className) {
  if (!el) return;
  className = className || "is-updated";
  el.classList.remove(className);
  void el.offsetWidth;
  el.classList.add(className);
}

function reportError(error) {
  console.error("QueueLess:", error);
  showToast(error && error.message ? error.message : "Something went wrong.");
}

/* ---------------------------------------------------------
   RENDER FUNCTIONS — USER SIDE
--------------------------------------------------------- */

function renderServiceList() {
  var list = document.getElementById("service-list");
  return api.getServices(ORG_ID).then(function (services) {
    list.innerHTML = "";
    services.forEach(function (service) {
      var li = document.createElement("li");
      var btn = document.createElement("button");
      btn.className = "service-option";
      btn.innerHTML =
        '<span>' +
          '<span class="service-name"></span>' +
          '<span class="service-meta"></span>' +
        '</span>' +
        '<span class="service-arrow">&rarr;</span>';
      btn.querySelector(".service-name").textContent = service.serviceName;
      btn.querySelector(".service-meta").textContent = service.waiting + " waiting";
      btn.addEventListener("click", function () {
        document.querySelectorAll(".service-option").forEach(function (el) {
          el.classList.remove("is-selected");
        });
        btn.classList.add("is-selected");
        // Small pause so the selection state is visible before the
        // screen transitions — makes the tap feel acknowledged.
        setTimeout(function () { openJoinScreen(service.serviceID); }, 160);
      });
      li.appendChild(btn);
      list.appendChild(li);
    });
  }).catch(reportError);
}

function openJoinScreen(serviceID) {
  return api.getQueueSnapshot(serviceID).then(function (snapshot) {
    document.getElementById("join-service-name").textContent = snapshot.serviceName;
    document.getElementById("join-current-number").textContent = snapshot.currentlyServingLabel;
    document.getElementById("join-people-waiting").textContent = snapshot.peopleWaiting;
    document.getElementById("join-est-wait").textContent = "~" + snapshot.estimatedWaitMinutes + " min";

    document.getElementById("btn-confirm-join").onclick = function () {
      api.joinQueue(serviceID, { name: "Guest" }).then(function (ticket) {
        rememberTicket(ticket.ticketID);
        lastKnownAhead = null;
        return renderTicket();
      }).then(function () {
        showView("ticket");
        var ticketEl = document.getElementById("ticket");
        ticketEl.classList.remove("is-fresh");
        void ticketEl.offsetWidth;
        ticketEl.classList.add("is-fresh");
        showToast("Joined the queue as " + document.getElementById("ticket-number").textContent);
      }).catch(reportError);
    };

    showView("join");
  }).catch(reportError);
}

function renderTicket() {
  if (!activeTicketId) return Promise.resolve();
  return api.getTicket(activeTicketId).then(function (status) {
    document.getElementById("ticket-number").textContent = status.ticketLabel;
    document.getElementById("ticket-service-name").textContent = status.serviceName;
    document.getElementById("ticket-ahead").textContent = status.peopleAhead;
    document.getElementById("ticket-wait").textContent = "~" + status.estimatedWaitMinutes + " min";
    document.getElementById("ticket-current").textContent = status.currentlyServingLabel || "—";

    var statusText = document.getElementById("ticket-status");
    statusText.textContent = status.isYourTurn
      ? "It's your turn!"
      : (status.peopleAhead === 0 ? "You're up next!" : "You're in the queue");
    statusText.classList.toggle("is-live", status.peopleAhead === 0 || status.isYourTurn);
  }).catch(reportError);
}

function renderStatus() {
  if (!activeTicketId) {
    stopLiveRefresh();
    return Promise.resolve();
  }

  return api.getTicket(activeTicketId).then(function (status) {
    var currentEl = document.getElementById("status-current");
    var aheadEl = document.getElementById("status-ahead");

    document.getElementById("status-service-name").textContent = status.serviceName;
    document.getElementById("status-number").textContent = status.ticketLabel;
    currentEl.textContent = status.currentlyServingLabel || "—";
    aheadEl.textContent = status.peopleAhead;
    document.getElementById("status-wait").textContent = "~" + status.estimatedWaitMinutes + " min";

    // Draw attention to whichever number just moved (skip on the
    // very first render for this ticket — nothing has "changed" yet).
    if (lastKnownAhead !== null && lastKnownAhead !== status.peopleAhead) {
      flash(currentEl);
      flash(aheadEl);
      showToast("Queue updated — staff called the next person");
    }
    lastKnownAhead = status.peopleAhead;

    // Progress bar: how far the ticket has moved from "just joined"
    // to "being served now".
    var totalSpan = Math.max(status.peopleAhead + 3, 1);
    var progressPct = Math.min(100, Math.round((3 / totalSpan) * 100 + (status.peopleAhead === 0 ? 40 : 0)));
    var fill = document.getElementById("progress-fill");
    fill.style.width = (status.isYourTurn ? 100 : progressPct) + "%";
    fill.classList.toggle("is-near", status.peopleAhead <= 3);

    var message = document.getElementById("status-message");
    message.classList.toggle("is-live", status.peopleAhead === 0 || status.isYourTurn);

    if (status.isYourTurn) {
      message.textContent = "YOUR TURN — please proceed to Counter " + (status.counter || 2) + ".";
      stopLiveRefresh();
    } else if (status.status === "served") {
      message.textContent = "You have been served. Thank you!";
      stopLiveRefresh();
    } else if (status.status === "skipped") {
      message.textContent = "Your number was called and missed. Please speak to the front desk.";
      stopLiveRefresh();
    } else if (status.peopleAhead === 0) {
      message.textContent = "You're next — please head to the counter.";
    } else if (status.peopleAhead <= 3) {
      message.textContent = "You're getting close!";
    } else {
      message.textContent = "Feel free to step away — we'll track your spot.";
    }
  }).catch(reportError);
}

/* ---------------------------------------------------------
   WIRE UP STATIC BUTTONS
--------------------------------------------------------- */

document.getElementById("btn-join-queue").addEventListener("click", function () {
  renderServiceList().then(function () { showView("services"); });
});

document.getElementById("btn-staff-login").addEventListener("click", function () {
  document.getElementById("staff-login-error").textContent = "";
  if (api.isStaffLoggedIn()) openStaffDashboard();
  else showView("staff-login");
});

document.querySelectorAll("[data-back]").forEach(function (btn) {
  btn.addEventListener("click", function () { showView(btn.dataset.back); });
});

document.getElementById("btn-track-status").addEventListener("click", function () {
  renderStatus().then(function () { showView("status"); });
});

document.getElementById("btn-leave-queue").addEventListener("click", function () {
  if (!activeTicketId) {
    showView("home");
    return;
  }
  api.leaveQueue(activeTicketId).then(function () {
    rememberTicket(null);
    lastKnownAhead = null;
    showView("home");
    showToast("You left the queue");
  }).catch(reportError);
});

// Solo-demo helper: advances the queue without a second browser
// tab open. During the real demo the staff dashboard drives this.
document.getElementById("btn-simulate-advance").addEventListener("click", function () {
  if (!activeTicketId) return;
  api.getTicket(activeTicketId)
    .then(function (ticket) { return api.callNext(ticket.serviceID); })
    .then(renderStatus)
    .catch(reportError);
});

/* ---------------------------------------------------------
   STAFF AUTH + DASHBOARD
   Reads the same backend as the student flow, so the two sides
   stay in step whether they are in one tab or two.
--------------------------------------------------------- */

function renderStaffQueue() {
  return Promise.all([
    api.getWaitingList(staffServiceId),
    api.getStats(staffServiceId)
  ]).then(function (results) {
    var rows = results[0];
    var stats = results[1];

    var tbody = document.getElementById("staff-queue-body");
    tbody.innerHTML = "";

    rows.forEach(function (row) {
      var tr = document.createElement("tr");
      var badgeClass = row.status === "Serving" ? "status-serving" : "status-waiting";
      tr.innerHTML =
        '<td class="col-position"></td>' +
        '<td style="font-weight:700;"></td>' +
        '<td class="col-service"></td>' +
        '<td><span class="status-badge ' + badgeClass + '"></span></td>';
      tr.children[0].textContent = row.status === "Serving" ? "—" : row.position;
      tr.children[1].textContent = row.number;
      tr.children[2].textContent = row.serviceName;
      tr.children[3].firstChild.textContent = row.status;
      tbody.appendChild(tr);
    });

    var servingLabel = stats.currentlyServingLabel || "—";
    document.getElementById("staff-stat-serving").textContent = servingLabel;
    document.getElementById("staff-current-ticket").textContent = servingLabel;
    document.getElementById("staff-stat-waiting").textContent = stats.currentlyWaiting;
    document.getElementById("staff-stat-served").textContent = stats.servedToday;
    document.getElementById("staff-stat-wait").textContent =
      stats.avgWaitMinutes === null ? "—" : stats.avgWaitMinutes + "m";

    renderServedChart(stats.servedByHour);
  }).catch(reportError);
}

/* Served-per-hour bars, scaled to the busiest hour. Replaces the
   fixed heights the markup used to carry, so the chart is now
   evidence rather than decoration. */
function renderServedChart(servedByHour) {
  var chart = document.getElementById("staff-bar-chart");
  if (!chart) return;

  chart.innerHTML = "";
  if (!servedByHour || !servedByHour.length) {
    var empty = document.createElement("p");
    empty.className = "chart-empty";
    empty.textContent = "No one has been served yet today.";
    chart.appendChild(empty);
    return;
  }

  var busiest = servedByHour.reduce(function (max, row) {
    return Math.max(max, row.count);
  }, 0) || 1;

  var peakLabelled = false;

  servedByHour.forEach(function (row) {
    // Label the busiest hour only, and only once if several tie.
    var isPeak = row.count === busiest && !peakLabelled;
    if (isPeak) peakLabelled = true;

    var col = document.createElement("div");
    col.className = "bar-col" + (isPeak ? " is-peak" : "");
    col.title = row.count + " served at " + formatHour(row.hour);

    var track = document.createElement("div");
    track.className = "bar-track";

    var value = document.createElement("span");
    value.className = "bar-value";
    value.textContent = row.count;

    var bar = document.createElement("div");
    bar.className = "bar";
    // A floor of 4% keeps a quiet hour visible instead of vanishing.
    bar.style.height = Math.max(4, Math.round((row.count / busiest) * 100)) + "%";

    var caption = document.createElement("span");
    caption.className = "bar-label";
    caption.textContent = formatHour(row.hour);

    bar.appendChild(value);
    track.appendChild(bar);
    col.appendChild(track);
    col.appendChild(caption);
    chart.appendChild(col);
  });
}

function formatHour(hour) {
  var suffix = hour < 12 ? "AM" : "PM";
  var display = hour % 12 === 0 ? 12 : hour % 12;
  return display + " " + suffix;
}

function openStaffDashboard() {
  if (!api.isStaffLoggedIn()) {
    showView("staff-login");
    return;
  }
  renderStaffQueue().then(function () { showView("staff-dashboard"); });
}

document.getElementById("btn-staff-auth").addEventListener("click", function () {
  var email = document.getElementById("staff-email").value;
  var password = document.getElementById("staff-password").value;
  var error = document.getElementById("staff-login-error");

  api.staffLogin(email, password).then(function () {
    error.textContent = "";
    showToast("Staff login successful");
    openStaffDashboard();
  }).catch(function (err) {
    error.textContent = err.message;
  });
});

document.getElementById("btn-staff-logout").addEventListener("click", function () {
  api.staffLogout().then(function () {
    showView("home");
    showToast("Logged out");
  });
});

document.getElementById("btn-call-next").addEventListener("click", function () {
  api.callNext(staffServiceId).then(function (result) {
    if (!result.called) {
      showToast("No one is waiting.");
    } else {
      showToast("Now serving " + result.called);
    }
    return renderStaffQueue();
  }).catch(reportError);
});

document.getElementById("btn-mark-served").addEventListener("click", function () {
  api.markServed(staffServiceId).then(function (result) {
    showToast(result.served + " marked served.");
    return renderStaffQueue();
  }).catch(reportError);
});

document.getElementById("btn-skip-ticket").addEventListener("click", function () {
  api.skip(staffServiceId).then(function (result) {
    showToast(
      result.called
        ? result.skipped + " skipped — now serving " + result.called
        : result.skipped + " skipped."
    );
    return renderStaffQueue();
  }).catch(reportError);
});

document.getElementById("btn-staff-theme").addEventListener("click", function () {
  document.body.classList.toggle("theme-dark");
});

/* ---------------------------------------------------------
   ENTRANCE QR POSTER
   The QR is rendered by the server so the page needs no QR
   library and still works with no internet at the venue. It
   encodes the address this page was actually opened on, which is
   the one a phone on the same wifi can reach.
--------------------------------------------------------- */

function renderQr() {
  var frame = document.getElementById("qr-frame");
  var urlLabel = document.getElementById("qr-url");
  var hint = document.getElementById("qr-hint");
  var target = window.location.origin + "/";

  urlLabel.textContent = target;

  if (api.getMode() !== "server") {
    frame.innerHTML = '<p class="qr-placeholder" id="qr-placeholder"></p>';
    frame.firstChild.textContent = "QR needs the server running.";
    hint.textContent = "Start the server with `npm start`, then reopen this screen.";
    return Promise.resolve();
  }

  hint.textContent = "Print this, or show it on screen for a phone to scan.";

  return fetch(api.getQrEndpoint() + "?url=" + encodeURIComponent(target))
    .then(function (res) {
      if (!res.ok) throw new Error("Could not render the QR code.");
      return res.text();
    })
    .then(function (svg) { frame.innerHTML = svg; })
    .catch(function (err) {
      frame.innerHTML = '<p class="qr-placeholder"></p>';
      frame.firstChild.textContent = err.message;
    });
}

document.getElementById("btn-show-qr").addEventListener("click", function () {
  showView("qr");
  renderQr();
});

/* A quiet badge on the home screen when the server is not up, so
   the team notices before the audience does. */
api.whenReady().then(function (mode) {
  var pill = document.getElementById("mode-pill");
  if (!pill) return;
  if (mode === "server") {
    pill.hidden = true;
  } else {
    pill.hidden = false;
    pill.textContent = "Offline mode";
    pill.title = "No server reachable — this browser is running the queue on its own.";
  }
});

/* Live updates: the backend tells us when anything changes,
   including changes made in another browser tab. */
api.subscribe(function () {
  var active = document.querySelector(".view.active");
  if (!active) return;
  if (active.dataset.view === "staff-dashboard") renderStaffQueue();
  else if (active.dataset.view === "status") renderStatus();
  else if (active.dataset.view === "ticket") renderTicket();
});

showView("home");
