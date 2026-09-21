/* ===========================================================
   QueueLess — Person 1 frontend logic
   Handles: view navigation, rendering, and a mock queue engine.

   FOR PERSON 2 (backend/database):
   Every function in the "MOCK QUEUE ENGINE" section below is a
   stand-in for a real API/database call. Each one is written to
   return the same shape of data so you can swap the internals
   (e.g. a fetch() to your endpoint) without touching the render
   functions. Look for the "// BACKEND HOOK" comments.
   =========================================================== */

/* ---------------------------------------------------------
   MOCK QUEUE ENGINE
   Replace the internals of these functions with real calls to
   your database. Keep the same function names + return shapes
   and the rest of the frontend keeps working unchanged.
--------------------------------------------------------- */

const DEFAULT_SERVICES = [
  { id: "doc-collection", name: "Document Collection", currentlyServing: 37, waiting: 12, avgMinutesPerPerson: 3 },
  { id: "registration", name: "Student Registration", currentlyServing: 18, waiting: 6, avgMinutesPerPerson: 4 },
  { id: "payments", name: "Payment / Fees", currentlyServing: 52, waiting: 9, avgMinutesPerPerson: 2 },
  { id: "transcripts", name: "Transcript Request", currentlyServing: 9, waiting: 3, avgMinutesPerPerson: 5 },
];

const QUEUE_STORAGE_KEY = "queueless_shared_state_v1";
const STAFF_SESSION_KEY = "queueless_staff_session";

function loadQueueState() {
  try {
    const saved = JSON.parse(localStorage.getItem(QUEUE_STORAGE_KEY));
    if (saved && Array.isArray(saved.services)) return saved;
  } catch (error) {
    console.warn("QueueLess: unable to read saved queue state.", error);
  }
  return {
    services: DEFAULT_SERVICES.map((service) => ({
      ...service,
      queue: Array.from({ length: service.waiting }, (_, i) => ({
        ticket: service.currentlyServing + i + 1,
        service: service.name,
        status: "Waiting"
      }))
    })),
    servedCount: 84,
    currentServiceId: "doc-collection"
  };
}

let sharedState = loadQueueState();
let SERVICES = sharedState.services;

function saveQueueState() {
  sharedState.services = SERVICES;
  try {
    localStorage.setItem(QUEUE_STORAGE_KEY, JSON.stringify(sharedState));
  } catch (error) {
    console.warn("QueueLess: unable to save queue state.", error);
  }
}

let activeTicket = null;
let lastKnownAhead = null;

function numberToLabel(n) {
  return "A" + String(n).padStart(3, "0");
}

// BACKEND HOOK: replace with GET /services
function getServices() {
  return SERVICES;
}

// BACKEND HOOK: replace with GET /queues/:serviceId
function getQueueSnapshot(serviceId) {
  const service = SERVICES.find((s) => s.id === serviceId);
  return {
    service,
    currentlyServingLabel: numberToLabel(service.currentlyServing),
    peopleWaiting: service.waiting,
    estimatedWaitMinutes: service.waiting * service.avgMinutesPerPerson,
  };
}

// BACKEND HOOK: replace with POST /queues/:serviceId/join
function joinQueue(serviceId) {
  const service = SERVICES.find((s) => s.id === serviceId);
  if (!service) return null;

  service.queue = Array.isArray(service.queue) ? service.queue : [];
  const highestQueued = service.queue.reduce(
    (highest, item) => Math.max(highest, Number(item.ticket) || 0),
    service.currentlyServing
  );
  const ticketNumber = highestQueued + 1;
  service.waiting += 1;
  service.queue.push({
    ticket: ticketNumber,
    service: service.name,
    status: "Waiting"
  });

  activeTicket = { serviceId, number: ticketNumber, label: numberToLabel(ticketNumber) };
  lastKnownAhead = null;
  saveQueueState();
  return activeTicket;
}

function getTicketStatus() {
  if (!activeTicket) return null;
  const service = SERVICES.find((s) => s.id === activeTicket.serviceId);
  if (!service) return null;
  const peopleAhead = Math.max(activeTicket.number - service.currentlyServing - 1, 0);
  return {
    service,
    ticketLabel: activeTicket.label,
    currentlyServingLabel: numberToLabel(service.currentlyServing),
    peopleAhead,
    estimatedWaitMinutes: peopleAhead * service.avgMinutesPerPerson,
  };
}

function devSimulateCallNext(serviceId = activeTicket?.serviceId) {
  const service = SERVICES.find((s) => s.id === serviceId);
  if (!service || service.waiting <= 0) return false;
  service.currentlyServing += 1;
  service.waiting = Math.max(0, service.waiting - 1);
  if (Array.isArray(service.queue) && service.queue.length) service.queue.shift();
  sharedState.servedCount = Number(sharedState.servedCount || 0) + 1;
  saveQueueState();
  return true;
}

function leaveQueue() {
  if (activeTicket) {
    const service = SERVICES.find((s) => s.id === activeTicket.serviceId);
    if (service) {
      const index = Array.isArray(service.queue)
        ? service.queue.findIndex((item) => item.ticket === activeTicket.number)
        : -1;
      if (index >= 0) {
        service.queue.splice(index, 1);
        service.waiting = Math.max(0, service.waiting - 1);
        saveQueueState();
      }
    }
  }
  activeTicket = null;
  lastKnownAhead = null;
}

/* ---------------------------------------------------------
   VIEW NAVIGATION
--------------------------------------------------------- */

// Only the Queue Status screen auto-refreshes (mimics a live
// backend push). We start/stop it as that view opens/closes so
// nothing keeps ticking in the background.
let liveStatusInterval = null;

function stopLiveStatus() {
  if (liveStatusInterval) {
    clearInterval(liveStatusInterval);
    liveStatusInterval = null;
  }
}

function showView(name) {
  document.querySelector(".app-frame")?.classList.toggle("staff-mode", name === "staff-dashboard" || name === "staff-login");
  document.querySelectorAll(".view").forEach((el) => {
    el.classList.toggle("active", el.dataset.view === name);
  });
  window.scrollTo(0, 0);

  if (name === "status") {
    stopLiveStatus();
    liveStatusInterval = setInterval(() => {
      devSimulateCallNext();
      renderStatus();
    }, 6000);
  } else {
    stopLiveStatus();
  }
}

/* ---------------------------------------------------------
   SMALL UI HELPERS (toast + tactile feedback)
--------------------------------------------------------- */

let toastTimer = null;
function showToast(message) {
  const toast = document.getElementById("toast");
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), 2200);
}

// Adds a brief "pressed" ripple to any .btn on click — purely
// cosmetic feedback layered on top of each button's real handler.
document.querySelectorAll(".btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    btn.classList.remove("is-pressed");
    // Force reflow so the animation can re-trigger on rapid clicks.
    void btn.offsetWidth;
    btn.classList.add("is-pressed");
    setTimeout(() => btn.classList.remove("is-pressed"), 500);
  });
});

// Briefly flashes a class on an element to draw the eye to a
// value that just changed (used for numbers ticking forward).
function flash(el, className = "is-updated") {
  if (!el) return;
  el.classList.remove(className);
  void el.offsetWidth;
  el.classList.add(className);
}

/* ---------------------------------------------------------
   RENDER FUNCTIONS
--------------------------------------------------------- */

function renderServiceList() {
  const list = document.getElementById("service-list");
  list.innerHTML = "";
  getServices().forEach((service) => {
    const li = document.createElement("li");
    const btn = document.createElement("button");
    btn.className = "service-option";
    btn.innerHTML = `
      <span>
        <span class="service-name">${service.name}</span>
        <span class="service-meta">${service.waiting} waiting</span>
      </span>
      <span class="service-arrow">&rarr;</span>
    `;
    btn.addEventListener("click", () => {
      document.querySelectorAll(".service-option").forEach((el) =>
        el.classList.remove("is-selected")
      );
      btn.classList.add("is-selected");
      // Small pause so the selection state is visible before the
      // screen transitions — makes the tap feel acknowledged.
      setTimeout(() => openJoinScreen(service.id), 160);
    });
    li.appendChild(btn);
    list.appendChild(li);
  });
}

function openJoinScreen(serviceId) {
  const snapshot = getQueueSnapshot(serviceId);
  document.getElementById("join-service-name").textContent = snapshot.service.name;
  document.getElementById("join-current-number").textContent = snapshot.currentlyServingLabel;
  document.getElementById("join-people-waiting").textContent = snapshot.peopleWaiting;
  document.getElementById("join-est-wait").textContent = `~${snapshot.estimatedWaitMinutes} min`;

  document.getElementById("btn-confirm-join").onclick = () => {
    const ticket = joinQueue(serviceId);
    renderTicket();
    showView("ticket");
    document.getElementById("ticket").classList.remove("is-fresh");
    void document.getElementById("ticket").offsetWidth;
    document.getElementById("ticket").classList.add("is-fresh");
    showToast(`Joined the queue as ${ticket.label}`);
  };

  showView("join");
}

function renderTicket() {
  const status = getTicketStatus();
  if (!status) return;

  document.getElementById("ticket-number").textContent = status.ticketLabel;
  document.getElementById("ticket-service-name").textContent = status.service.name;
  document.getElementById("ticket-ahead").textContent = status.peopleAhead;
  document.getElementById("ticket-wait").textContent = `~${status.estimatedWaitMinutes} min`;
  document.getElementById("ticket-current").textContent = status.currentlyServingLabel;

  const statusText = document.getElementById("ticket-status");
  statusText.textContent = status.peopleAhead === 0
    ? "You're up next!"
    : "You're in the queue";
  statusText.classList.toggle("is-live", status.peopleAhead === 0);
}

function renderStatus() {
  const status = getTicketStatus();
  if (!status) {
    stopLiveStatus();
    
/* ---------------------------------------------------------
   STAFF AUTH + DASHBOARD
   Uses the same queue state as the student flow via localStorage.
--------------------------------------------------------- */

const STAFF_EMAIL = "admin@queueless.com";
const STAFF_PASSWORD = "admin123";

function isStaffLoggedIn() {
  return sessionStorage.getItem(STAFF_SESSION_KEY) === "true";
}

function refreshSharedState() {
  sharedState = loadQueueState();
  SERVICES = sharedState.services;
}

function renderStaffQueue() {
  refreshSharedState();
  const service = SERVICES.find((s) => s.id === "doc-collection") || SERVICES[0];
  if (!service) return;

  const queue = Array.isArray(service.queue) ? service.queue : [];
  const tbody = document.getElementById("staff-queue-body");
  tbody.innerHTML = "";

  queue.forEach((item, index) => {
    const row = document.createElement("tr");
    row.innerHTML = `
      <td>${index + 1}</td>
      <td style="font-weight:700;">${item.ticket}</td>
      <td>${item.service}</td>
      <td><span class="status-badge status-waiting">${item.status}</span></td>
    `;
    tbody.appendChild(row);
  });

  document.getElementById("staff-stat-serving").textContent = numberToLabel(service.currentlyServing);
  document.getElementById("staff-current-ticket").textContent = numberToLabel(service.currentlyServing);
  document.getElementById("staff-stat-waiting").textContent = service.waiting;
  document.getElementById("staff-stat-served").textContent = Number(sharedState.servedCount || 0);
}

function openStaffDashboard() {
  if (!isStaffLoggedIn()) {
    showView("staff-login");
    return;
  }
  renderStaffQueue();
  showView("staff-dashboard");
}

document.getElementById("btn-staff-auth").addEventListener("click", () => {
  const email = document.getElementById("staff-email").value.trim();
  const password = document.getElementById("staff-password").value;
  const error = document.getElementById("staff-login-error");

  if (email !== STAFF_EMAIL || password !== STAFF_PASSWORD) {
    error.textContent = "Invalid staff email or password.";
    return;
  }

  sessionStorage.setItem(STAFF_SESSION_KEY, "true");
  error.textContent = "";
  showToast("Staff login successful");
  openStaffDashboard();
});

document.getElementById("btn-staff-logout").addEventListener("click", () => {
  sessionStorage.removeItem(STAFF_SESSION_KEY);
  showView("home");
  showToast("Logged out");
});

document.getElementById("btn-call-next").addEventListener("click", () => {
  refreshSharedState();
  const service = SERVICES.find((s) => s.id === "doc-collection") || SERVICES[0];
  if (!service || service.waiting <= 0) {
    showToast("No waiting tickets.");
    renderStaffQueue();
    return;
  }
  devSimulateCallNext(service.id);
  renderStaffQueue();
  showToast("Next ticket called.");
});

document.getElementById("btn-mark-served").addEventListener("click", () => {
  refreshSharedState();
  const service = SERVICES.find((s) => s.id === "doc-collection") || SERVICES[0];
  if (!service || service.waiting <= 0) {
    showToast("No waiting ticket to mark served.");
    return;
  }
  devSimulateCallNext(service.id);
  renderStaffQueue();
  showToast("Ticket marked served.");
});

document.getElementById("btn-skip-ticket").addEventListener("click", () => {
  refreshSharedState();
  const service = SERVICES.find((s) => s.id === "doc-collection") || SERVICES[0];
  if (!service || service.waiting <= 0) {
    showToast("No waiting ticket to skip.");
    return;
  }
  devSimulateCallNext(service.id);
  renderStaffQueue();
  showToast("Ticket skipped.");
});

document.getElementById("btn-staff-theme").addEventListener("click", () => {
  document.body.classList.toggle("theme-dark");
});

window.addEventListener("storage", (event) => {
  if (event.key === QUEUE_STORAGE_KEY && document.querySelector('[data-view="staff-dashboard"].active')) {
    renderStaffQueue();
  }
});

showView("home");
    return;
  }

  const currentEl = document.getElementById("status-current");
  const aheadEl = document.getElementById("status-ahead");

  document.getElementById("status-service-name").textContent = status.service.name;
  document.getElementById("status-number").textContent = status.ticketLabel;
  currentEl.textContent = status.currentlyServingLabel;
  aheadEl.textContent = status.peopleAhead;
  document.getElementById("status-wait").textContent = `~${status.estimatedWaitMinutes} min`;

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
  const totalSpan = Math.max(status.peopleAhead + 3, 1);
  const progressPct = Math.min(100, Math.round(((3) / totalSpan) * 100 + (status.peopleAhead === 0 ? 40 : 0)));
  const fill = document.getElementById("progress-fill");
  fill.style.width = progressPct + "%";
  fill.classList.toggle("is-near", status.peopleAhead <= 3);

  const message = document.getElementById("status-message");
  message.classList.toggle("is-live", status.peopleAhead === 0);
  if (status.peopleAhead === 0) {
    message.textContent = "You're next — please head to the counter.";
    stopLiveStatus();
  } else if (status.peopleAhead <= 3) {
    message.textContent = "You're getting close!";
  } else {
    message.textContent = "Feel free to step away — we'll track your spot.";
  }
}

/* ---------------------------------------------------------
   WIRE UP STATIC BUTTONS
--------------------------------------------------------- */

document.getElementById("btn-join-queue").addEventListener("click", () => {
  renderServiceList();
  showView("services");
});

// Staff Login belongs to Person 3's admin build — this just
// routes back home for now so the button isn't a dead end.
document.getElementById("btn-staff-login").addEventListener("click", () => {
  document.getElementById("staff-login-error").textContent = "";
  showView("staff-login");
});

document.querySelectorAll("[data-back]").forEach((btn) => {
  btn.addEventListener("click", () => showView(btn.dataset.back));
});

document.getElementById("btn-track-status").addEventListener("click", () => {
  renderStatus();
  showView("status");
});

document.getElementById("btn-leave-queue").addEventListener("click", () => {
  leaveQueue();
  
/* ---------------------------------------------------------
   STAFF AUTH + DASHBOARD
   Uses the same queue state as the student flow via localStorage.
--------------------------------------------------------- */

const STAFF_EMAIL = "admin@queueless.com";
const STAFF_PASSWORD = "admin123";

function isStaffLoggedIn() {
  return sessionStorage.getItem(STAFF_SESSION_KEY) === "true";
}

function refreshSharedState() {
  sharedState = loadQueueState();
  SERVICES = sharedState.services;
}

function renderStaffQueue() {
  refreshSharedState();
  const service = SERVICES.find((s) => s.id === "doc-collection") || SERVICES[0];
  if (!service) return;

  const queue = Array.isArray(service.queue) ? service.queue : [];
  const tbody = document.getElementById("staff-queue-body");
  tbody.innerHTML = "";

  queue.forEach((item, index) => {
    const row = document.createElement("tr");
    row.innerHTML = `
      <td>${index + 1}</td>
      <td style="font-weight:700;">${item.ticket}</td>
      <td>${item.service}</td>
      <td><span class="status-badge status-waiting">${item.status}</span></td>
    `;
    tbody.appendChild(row);
  });

  document.getElementById("staff-stat-serving").textContent = numberToLabel(service.currentlyServing);
  document.getElementById("staff-current-ticket").textContent = numberToLabel(service.currentlyServing);
  document.getElementById("staff-stat-waiting").textContent = service.waiting;
  document.getElementById("staff-stat-served").textContent = Number(sharedState.servedCount || 0);
}

function openStaffDashboard() {
  if (!isStaffLoggedIn()) {
    showView("staff-login");
    return;
  }
  renderStaffQueue();
  showView("staff-dashboard");
}

document.getElementById("btn-staff-auth").addEventListener("click", () => {
  const email = document.getElementById("staff-email").value.trim();
  const password = document.getElementById("staff-password").value;
  const error = document.getElementById("staff-login-error");

  if (email !== STAFF_EMAIL || password !== STAFF_PASSWORD) {
    error.textContent = "Invalid staff email or password.";
    return;
  }

  sessionStorage.setItem(STAFF_SESSION_KEY, "true");
  error.textContent = "";
  showToast("Staff login successful");
  openStaffDashboard();
});

document.getElementById("btn-staff-logout").addEventListener("click", () => {
  sessionStorage.removeItem(STAFF_SESSION_KEY);
  showView("home");
  showToast("Logged out");
});

document.getElementById("btn-call-next").addEventListener("click", () => {
  refreshSharedState();
  const service = SERVICES.find((s) => s.id === "doc-collection") || SERVICES[0];
  if (!service || service.waiting <= 0) {
    showToast("No waiting tickets.");
    renderStaffQueue();
    return;
  }
  devSimulateCallNext(service.id);
  renderStaffQueue();
  showToast("Next ticket called.");
});

document.getElementById("btn-mark-served").addEventListener("click", () => {
  refreshSharedState();
  const service = SERVICES.find((s) => s.id === "doc-collection") || SERVICES[0];
  if (!service || service.waiting <= 0) {
    showToast("No waiting ticket to mark served.");
    return;
  }
  devSimulateCallNext(service.id);
  renderStaffQueue();
  showToast("Ticket marked served.");
});

document.getElementById("btn-skip-ticket").addEventListener("click", () => {
  refreshSharedState();
  const service = SERVICES.find((s) => s.id === "doc-collection") || SERVICES[0];
  if (!service || service.waiting <= 0) {
    showToast("No waiting ticket to skip.");
    return;
  }
  devSimulateCallNext(service.id);
  renderStaffQueue();
  showToast("Ticket skipped.");
});

document.getElementById("btn-staff-theme").addEventListener("click", () => {
  document.body.classList.toggle("theme-dark");
});

window.addEventListener("storage", (event) => {
  if (event.key === QUEUE_STORAGE_KEY && document.querySelector('[data-view="staff-dashboard"].active')) {
    renderStaffQueue();
  }
});

showView("home");
  showToast("You left the queue");
});

document.getElementById("btn-simulate-advance").addEventListener("click", () => {
  devSimulateCallNext();
  renderStatus();
});


/* ---------------------------------------------------------
   STAFF AUTH + DASHBOARD
   Uses the same queue state as the student flow via localStorage.
--------------------------------------------------------- */

const STAFF_EMAIL = "admin@queueless.com";
const STAFF_PASSWORD = "admin123";

function isStaffLoggedIn() {
  return sessionStorage.getItem(STAFF_SESSION_KEY) === "true";
}

function refreshSharedState() {
  sharedState = loadQueueState();
  SERVICES = sharedState.services;
}

function renderStaffQueue() {
  refreshSharedState();
  const service = SERVICES.find((s) => s.id === "doc-collection") || SERVICES[0];
  if (!service) return;

  const queue = Array.isArray(service.queue) ? service.queue : [];
  const tbody = document.getElementById("staff-queue-body");
  tbody.innerHTML = "";

  queue.forEach((item, index) => {
    const row = document.createElement("tr");
    row.innerHTML = `
      <td>${index + 1}</td>
      <td style="font-weight:700;">${item.ticket}</td>
      <td>${item.service}</td>
      <td><span class="status-badge status-waiting">${item.status}</span></td>
    `;
    tbody.appendChild(row);
  });

  document.getElementById("staff-stat-serving").textContent = numberToLabel(service.currentlyServing);
  document.getElementById("staff-current-ticket").textContent = numberToLabel(service.currentlyServing);
  document.getElementById("staff-stat-waiting").textContent = service.waiting;
  document.getElementById("staff-stat-served").textContent = Number(sharedState.servedCount || 0);
}

function openStaffDashboard() {
  if (!isStaffLoggedIn()) {
    showView("staff-login");
    return;
  }
  renderStaffQueue();
  showView("staff-dashboard");
}

document.getElementById("btn-staff-auth").addEventListener("click", () => {
  const email = document.getElementById("staff-email").value.trim();
  const password = document.getElementById("staff-password").value;
  const error = document.getElementById("staff-login-error");

  if (email !== STAFF_EMAIL || password !== STAFF_PASSWORD) {
    error.textContent = "Invalid staff email or password.";
    return;
  }

  sessionStorage.setItem(STAFF_SESSION_KEY, "true");
  error.textContent = "";
  showToast("Staff login successful");
  openStaffDashboard();
});

document.getElementById("btn-staff-logout").addEventListener("click", () => {
  sessionStorage.removeItem(STAFF_SESSION_KEY);
  showView("home");
  showToast("Logged out");
});

document.getElementById("btn-call-next").addEventListener("click", () => {
  refreshSharedState();
  const service = SERVICES.find((s) => s.id === "doc-collection") || SERVICES[0];
  if (!service || service.waiting <= 0) {
    showToast("No waiting tickets.");
    renderStaffQueue();
    return;
  }
  devSimulateCallNext(service.id);
  renderStaffQueue();
  showToast("Next ticket called.");
});

document.getElementById("btn-mark-served").addEventListener("click", () => {
  refreshSharedState();
  const service = SERVICES.find((s) => s.id === "doc-collection") || SERVICES[0];
  if (!service || service.waiting <= 0) {
    showToast("No waiting ticket to mark served.");
    return;
  }
  devSimulateCallNext(service.id);
  renderStaffQueue();
  showToast("Ticket marked served.");
});

document.getElementById("btn-skip-ticket").addEventListener("click", () => {
  refreshSharedState();
  const service = SERVICES.find((s) => s.id === "doc-collection") || SERVICES[0];
  if (!service || service.waiting <= 0) {
    showToast("No waiting ticket to skip.");
    return;
  }
  devSimulateCallNext(service.id);
  renderStaffQueue();
  showToast("Ticket skipped.");
});

document.getElementById("btn-staff-theme").addEventListener("click", () => {
  document.body.classList.toggle("theme-dark");
});

window.addEventListener("storage", (event) => {
  if (event.key === QUEUE_STORAGE_KEY && document.querySelector('[data-view="staff-dashboard"].active')) {
    renderStaffQueue();
  }
});

showView("home");