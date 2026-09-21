# QueueLess — Backend

## Run it

```bash
npm install
npm start          # http://localhost:3000
npm test           # 84 checks: database, engine rules, HTTP API
```

The server prints a `http://192.168.x.x:3000` address on startup. **That is the
one to use for the demo** — phones on the same wifi can reach it, `localhost`
cannot.

Reset to the opening state between rehearsals:

```bash
npm run reset
```

## Layout

```
shared/schema.js       reference data + seed rows
shared/engine.js       queue rules — no SQL, no HTTP, no disk
shared/memory-repo.js  storage: arrays (browser fallback, tests)
server/database.js     SQLite connection, DDL, seeding
server/sqlite-repo.js  storage: real SQL
server/app.js          Express routes, SSE, QR rendering
server/index.js        entry point, prints the network address
api-client.js          browser client -> window.QueueLess.api
app.js                 UI rendering only
```

The rules and the storage are separate. `shared/engine.js` never sees SQL — it
asks a **repository** for rows. Two repositories satisfy that contract: SQLite
on the server, arrays in the browser. So the same queue rules run in both
places and cannot drift apart.

## The database

SQLite. A real relational database that needs no server process, no credentials
and no internet — the whole thing is one file at `server/data/queueless.db`.
That matters for a demo laptop.

The driver is Node's built-in `node:sqlite` where available, so there is
nothing to install. On older Node it falls back to `better-sqlite3`, which is
listed as an optional dependency.

### Tables

| Table | Columns |
|---|---|
| `organizations` | `organizationID` PK, `name`, `isDemo` |
| `users` | `userID` PK, `name`, `contact`, `createdAt` |
| `services` | `serviceID` PK, `serviceName`, `organizationID` FK, `prefix`, `avgServiceMinutes` |
| `queues` | `queueID` PK, `serviceID` FK UNIQUE, `currentNumber`, `nextNumber`, `status` |
| `tickets` | `ticketID` PK, `userID` FK, `queueID` FK, `serviceID` FK, `queueNumber`, `queueLabel`, `joinedAt`, `calledAt`, `closedAt`, `status` |

### Integrity is the database's job, not the app's

Four rules are enforced by the schema, so a bug in the application cannot break
them (`db.test.js` proves each one by trying to violate it):

- `UNIQUE (serviceID, queueNumber)` — **two people can never hold the same
  ticket number.**
- `UNIQUE (serviceID) WHERE status='serving'` — **two people can never be at
  the counter for one service at once.**
- `CHECK status IN (...)` — a ticket cannot have an invented status.
- Foreign keys — a ticket cannot belong to a service that does not exist.

Multi-step moves (call next, skip, join) run inside a transaction, so the queue
is never observed half-advanced, and a failure rolls the whole move back.

### Inspecting it

```bash
sqlite3 server/data/queueless.db "SELECT queueLabel, status FROM tickets WHERE serviceID='doc-collection' ORDER BY queueNumber DESC LIMIT 10;"
```

## Two modes

The client probes `/api/health` at startup:

- **server** — normal. Calls the API over HTTP, live updates over Server-Sent
  Events. Phones and laptops all see one queue.
- **local** — the safety net. If the server is unreachable the same engine runs
  in the browser against `localStorage`. The app stays fully usable, but cannot
  sync across devices. An "Offline mode" badge appears on the home screen.

The fallback exists so a dead laptop or locked-down venue wifi cannot sink the
demo.

## Endpoints

| Method | Path | Does |
|---|---|---|
| GET | `/api/health` | liveness probe |
| GET | `/api/organizations` | the four organizations |
| GET | `/api/services?organizationID=` | services + live waiting counts |
| GET | `/api/queues/:serviceID` | now serving, waiting, ETA |
| POST | `/api/queues/:serviceID/tickets` | join — issues the next number |
| GET | `/api/tickets/:ticketID` | position, ETA, your-turn flag |
| DELETE | `/api/tickets/:ticketID` | leave the queue |
| POST | `/api/queues/:serviceID/call-next` | advance the queue |
| POST | `/api/queues/:serviceID/serve` | close out the counter |
| POST | `/api/queues/:serviceID/skip` | record a no-show |
| GET | `/api/queues/:serviceID/tickets` | dashboard waiting list |
| GET | `/api/stats/:serviceID` | computed statistics |
| POST | `/api/auth/login` | demo staff login |
| GET | `/api/qr?url=` | QR code as SVG |
| GET | `/api/events` | live updates (SSE) |
| POST | `/api/demo/reset` | back to the opening state |

Errors return the right status — 404 unknown service/ticket, 401 bad password,
409 an action that does not apply — with `{ "error": "..." }`.

## Data model

Section 9 of the 5-Day Blueprint.

| Collection | Fields |
|---|---|
| `users` | `userID`, `name`, `contact`, `createdAt` |
| `services` | `serviceID`, `serviceName`, `organizationID`, `prefix`, `avgServiceMinutes` |
| `queues` | `queueID`, `serviceID`, `currentNumber`, `nextNumber`, `status` |
| `tickets` | `ticketID`, `userID`, `queueID`, `queueNumber`, `queueLabel`, `serviceID`, `joinedAt`, `calledAt`, `closedAt`, `status` |

```
waiting -> serving -> served
waiting -> serving -> skipped
waiting -> left                 (the user cancelled)
```

Each service has its own sequence and prefix: Document Collection issues A037,
A038… while Student Registration issues B018, B019…

## The three staff actions are different

The easiest thing to get wrong:

- **CALL NEXT** — closes out whoever is at the counter, then promotes the next
  person.
- **MARK SERVED** — closes out the counter and stops. Nobody is promoted.
- **SKIP** — records a no-show and promotes the next person. A skipped ticket is
  **not** counted in "served today".

## Position and waiting time

`peopleAhead` is counted from the live queue, not derived from the ticket
number. If someone ahead of you leaves or is skipped you move up immediately,
and your number never changes.

`estimatedWaitMinutes` is `peopleAhead × average service time`, measured from
the last 20 genuinely served tickets once there are at least three, so the
estimate sharpens through the day.

## Statistics

Computed from ticket rows — nothing hardcoded. `servedToday`, `skippedToday`,
`currentlyWaiting`, `avgWaitMinutes` (join → called), `avgServiceMinutes`
(called → closed), and `servedByHour`, which draws the dashboard chart.

## Moving to Postgres or Supabase

Write a new repository with the same methods as `server/sqlite-repo.js` and
hand it to the routes in `server/app.js`. The queue rules and the whole
frontend stay exactly as they are — that is the point of the split.
