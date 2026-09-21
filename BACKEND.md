# QueueLess — Backend

## Run it

```bash
npm install
npm start          # http://localhost:3000
npm test           # 63 checks: engine rules + HTTP API
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
shared/engine.js    queue rules — no HTTP, no disk, no browser
server/index.js     entry point, prints the network address
server/app.js       Express routes, SSE, QR rendering
server/store.js     JSON file persistence
api-client.js       browser client -> window.QueueLess.api
app.js              UI rendering only
```

`shared/engine.js` runs in **both** Node and the browser. One copy of the rules,
so the server and the offline fallback cannot drift apart.

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

## Moving to Firebase or Supabase

Reimplement `loadSync()` and `writeNow()` in `server/store.js`. Nothing else in
the server touches storage.
