# QueueLess — Backend (Person 2)

`backend.js` is the queue engine. It owns all data and all queue rules.
Nothing else in the app should change queue state directly — the frontend
asks the backend and paints the answer.

## Running the tests

```bash
node backend.test.js     # 33 checks, no dependencies
```

## Data model

Follows section 9 of the 5-Day Blueprint.

| Collection | Fields |
|---|---|
| `users` | `userID`, `name`, `contact`, `createdAt` |
| `services` | `serviceID`, `serviceName`, `organizationID`, `prefix`, `avgServiceMinutes` |
| `queues` | `queueID`, `serviceID`, `currentNumber`, `nextNumber`, `status` |
| `tickets` | `ticketID`, `userID`, `queueID`, `queueNumber`, `queueLabel`, `serviceID`, `joinedAt`, `calledAt`, `closedAt`, `status` |

Ticket status moves through:

```
waiting -> serving -> served
waiting -> serving -> skipped
waiting -> left                 (the user cancelled)
```

Each service has its own number sequence and letter prefix, so Document
Collection issues A037, A038... while Student Registration issues B018, B019...

## API

Every method returns a Promise and is named after the REST call it stands
in for. Read `window.QueueLess.api`.

| Method | Stands in for |
|---|---|
| `getOrganizations()` | `GET /organizations` |
| `getServices(orgID)` | `GET /services` |
| `getQueueSnapshot(serviceID)` | `GET /queues/:id` |
| `joinQueue(serviceID, user)` | `POST /queues/:id/tickets` |
| `getTicket(ticketID)` | `GET /tickets/:id` |
| `leaveQueue(ticketID)` | `DELETE /tickets/:id` |
| `callNext(serviceID)` | `POST /queues/:id/call-next` |
| `markServed(serviceID)` | `POST /queues/:id/serve` |
| `skip(serviceID)` | `POST /queues/:id/skip` |
| `getWaitingList(serviceID)` | `GET /queues/:id/tickets` |
| `getStats(serviceID)` | `GET /stats/:id` |
| `staffLogin(email, password)` | `POST /auth/login` |

Errors reject, so use `.catch()`:

```js
api.joinQueue("doc-collection", { name: "Ada" })
   .then(ticket => console.log(ticket.ticketLabel))   // "A050"
   .catch(err => console.warn(err.message));
```

## The three staff actions are genuinely different

This is the part that is easy to get wrong:

- **CALL NEXT** — closes out whoever is at the counter (marks them served),
  then promotes the next waiting person.
- **MARK SERVED** — closes out the person at the counter and stops there.
  Nobody is promoted; staff press CALL NEXT when they are ready.
- **SKIP** — marks the current person `skipped` (they did not show up) and
  promotes the next one. A skipped ticket is **not** counted in
  "served today".

## Position and waiting time

`peopleAhead` is counted from the live queue, not worked out from the
ticket number. That matters: if someone ahead of you leaves or is skipped,
your position improves straight away and your number stays the same.

`estimatedWaitMinutes` is `peopleAhead x average service time`. The average
is measured from the last 20 genuinely served tickets once there are at
least three, so the estimate sharpens as the day goes on; before that it
falls back to the service's seed figure.

## Statistics

`getStats()` computes everything from ticket rows — nothing is hardcoded.
It returns `servedToday`, `skippedToday`, `currentlyWaiting`,
`avgWaitMinutes` (join -> called), `avgServiceMinutes` (called -> closed) and
`servedByHour`, which is ready for the optional bar chart in the blueprint.

## Real-time

`api.subscribe(fn)` fires `fn` after every change, including changes made
in another browser tab, and returns an unsubscribe function. That is what
keeps the student's phone view and the staff dashboard in step during the
demo. The status and dashboard screens also poll every 3 seconds as a
safety net.

## Demo reset

`api.resetDemo()` puts the data back to its opening state (Document
Collection serving A037, 12 waiting, 84 served today) so the demo can be
rehearsed repeatedly without editing code. From the browser console:

```js
QueueLess.api.resetDemo().then(() => location.reload());
```

## Moving to Firebase or Supabase

Storage is isolated in the `Storage` adapter at the top of `backend.js`
(`read`, `write`, `clear`). Point those three at Firebase or Supabase and
the rest of the file, and all of the frontend, stays as it is. The API is
already async, so no call site needs to change.
