# The schedule

Vercel Cron runs everything in **UTC**, and `TZ` cannot be set on Vercel, so the
runtime is UTC too. Madrid is UTC+1 in winter and UTC+2 in summer, so a fixed UTC
schedule drifts by an hour twice a year.

Vercel Cron is also **best-effort**: a failed run is never retried, the same run
can occasionally fire twice, and two runs can overlap. Three mechanisms in
`lib/cron.ts` are there for that, and the table below says which apply to what.

| Route | UTC schedule | `maxDuration` | Notes |
|---|---|---|---|
| `escalation-tick` | `*/30 * * * *` | 60 | The heartbeat the engine banner is calibrated against. |
| `reconcile` | `10 */3 * * *` | 300 | Batches of 100 codes, urgent parcels first. |
| `push-drain` | `*/5 * * * *` | 60 | Returns at once while push is unconfigured. |
| `push-heartbeat` | `5 * * * *` | 30 | Skips entirely while push is unconfigured. |
| `shopify-backfill` | `15 * * * *` | 120 | |
| `stale-detector` | `0 * * * *` | 60 | Catch-up, from Madrid hour 7. |
| `daily-digest` | `0 * * * *` | 60 | Catch-up, from Madrid hour 8. |
| `import-reminder` | `0 * * * *` | 30 | Catch-up, from Madrid hour 9. |
| `postcode-stats` | `45 1 * * *` | 120 | 02:45 or 03:45 Madrid; drift is harmless. |
| `housekeeping` | `15 3 * * *` | 60 | 04:15 or 05:15 Madrid; drift is harmless. |

`lib/engine-health.ts` writes the same cadences down a second time, in words,
for the Settings screen. A test asserts the two lists name exactly the same
jobs, rather than trusting anyone to remember.

## Catch-up, instead of firing at both candidate hours

The three daily jobs used to be scheduled at **both** UTC hours that could be
the right Madrid hour, with the job doing nothing unless the Madrid hour matched
exactly. That was correct and fragile: Vercel does not retry, so one dropped
invocation meant the digest never went out that day and nothing anywhere said
so.

Now each is scheduled **hourly** and asks two questions instead:

1. Is it past its hour in Madrid?
2. Has a real run already finished today, in Madrid days?

The first run after the hour does the work; the rest of the day's invocations
find it done and skip. A dropped invocation now costs an hour rather than a day.

"A real run" is narrower than it looks, and each exclusion is a bug that was
available:

- `ok` must be exactly **true**. A `job_runs` row has three states, not two: an
  instance killed mid-run leaves `ok` null for ever, because the catch block
  never executed. Counting null as done loses the day.
- `skipped` must be **false**. A skip is a successful run that correctly did
  nothing. It proves the scheduler is alive — which is what the banner wants —
  but it is not "today's digest has been sent".
- The day is bounded at **both** ends, which looks unnecessary because nothing
  is in the future. Demo mode puts things in the future: it stamps `started_at`
  from an offset clock, and resetting the offset leaves those rows dated days
  ahead. An open-ended `>= midnight` would read them as "today is done" and
  suppress the job until the calendar caught up.

## The lock

Every job takes a lease before doing anything, and returns `{ skipped: 'locked' }`
with a 200 if somebody else holds it. A 500 would be wrong: Vercel duplicates
ticks routinely, and making the lock itself look like an outage would train
whoever reads the log to ignore it.

It is a row in `job_locks` with a `locked_until` lease, taken with a single
conditional statement — insert-or-update-where-expired, returning the row only
if this caller won. **Not** a session advisory lock: through Supabase's
transaction pooler the lock would be taken on one backend and the work done on
another, so it would protect nothing. The lease is `maxDuration + 30` seconds,
so an instance killed without running its `finally` frees the job shortly after
it could possibly still be working.

The lock comes **before** the catch-up check, and the order is not
interchangeable. `runJob` records success only on completion, so "has today's
run happened" reads false for the whole time a run is in flight. Checking it
outside the lock is a race: read false, the other run commits and releases, this
one takes a now-free lock and sends a second digest.

The lock is the first line of defence, not the only one. Every message, task and
alert is unique **in the database** — so two concurrent ticks cannot double-send
even if the lock is bypassed entirely, which is how `tests/concurrency.test.ts`
runs them.

A locked or already-done invocation still writes a `job_runs` row, marked
`skipped`. Without it the operator cannot tell "the scheduler fired and
correctly did nothing" from "the scheduler never fired", which is the exact
question the banner exists to answer.

## An honest status

A job that threw used to return 200 with an empty detail, so Vercel's cron log
showed green on the day it failed. It now returns 500. Vercel does not retry on
500, so this changes nothing about the schedule — it is purely about the log
telling the truth.

## Two jobs the brief's table left out

**`push-drain`** is load-bearing when push is in use. The Correos receiver
returns 200 and writes the raw body to `correos_push_inbox`; nothing becomes an
event until this runs. Push is **not** configured at the moment, so the job
returns `{ skipped: 'push not configured' }` immediately and reconcile is the
only source of events. It runs every 5 minutes rather than every minute: at one
minute it was 1,440 invocations a day to do nothing.

> An alternative on Vercel is `waitUntil()` from `@vercel/functions`, letting
> the receiver process after responding. We kept the staging table because it
> survives a crash mid-processing and leaves the raw payload as evidence, which
> is what makes "fix the normaliser and replay" possible.

**`housekeeping`** clears expired sessions, old rate-limit buckets, push
payloads over 90 days old, delivered alerts over 90 days old and `job_runs` rows
over 30 days old. Nightly, drift irrelevant.

## Why reconcile runs every three hours

Correos does not retry a push, and push is not configured anyway, so this sweep
is not a safety net — it is the only way an event ever arrives. A dropped *"at
office"* event would leave a countdown wrong on the one screen whose entire job
is to be right about how many days are left.

At about 1,000 new parcels a day, roughly 5,000 are live at any time and every
one must be refreshed at least every 12 hours. Batches of 100 codes make that
about 50 requests a run, so every live parcel is seen on every run.

Parcels are ordered so the urgent ones go first — `delivery_failed`, `at_office`
and `address_issue` — and the rest follow least-recently-checked first. If a run
does get cut short, what it dropped is the parcels where nothing is at stake.

It is bounded twice: at most `RECONCILE_BATCH_SIZE` parcels (6,000), and it
stops starting new lookups after `RECONCILE_BUDGET_MS` (240s), inside the
route's 300s `maxDuration`. The budget is checked **between requests**, not
between batches of 100 — a batch that falls back to one code per request is 100
requests, and a budget that could only interrupt between batches could not stop
it.

## How it resumes

`shipments.last_reconciled_at` **is** the cursor. The sweep takes the
oldest-checked live parcels first (nulls first, so ones never checked lead), and
stamps each one only after it has actually been looked up.

A run that stops early — budget spent, or Correos refusing requests — simply
leaves the rest with an older stamp, and the next run continues from exactly
there. Nothing separate to persist, nothing to get out of step when parcels are
added or finish, and no parcel can be starved, because the one checked longest
ago is always next.

The response says what is left:

```json
{ "checked": 4900, "recovered": 3, "queued": 12, "stillToCheck": 41,
  "mode": "comma", "requests": 51,
  "stoppedEarly": "ran out of time — the next run continues from here" }
```

`stillToCheck` above zero across several consecutive runs means the sweep is not
keeping up: raise `RECONCILE_BATCH_SIZE`, or the frequency, or both. `mode` is
what the client has worked out about the undocumented multi-parcel format;
`requests` next to `checked` is how to see at a glance whether batching is
actually working.

## Reading `job_runs`

Settings → Connections shows, per job, when it was **last heard from** and when
it **last did something**. The first includes skips, because a skip still proves
Vercel fired the route, the secret matched, the database was writable and
`runJob` reached the end — exactly the facts a 401, a deleted schedule or an
unreachable database would deny us. The second is the one to look at when asking
whether work is happening.

The roster of jobs on that screen comes from the `JobName` union, not from
`SELECT DISTINCT job`. That column is free text and still holds
`nightly-reconcile` rows from before the rename; reading the roster out of the
data would leave a dead job on the screen until those rows aged out.

## Running one by hand

Locally, without HTTP:

```bash
npx tsx jobs/run-once.ts daily-digest
```

Against a deployment:

```bash
curl -H "Authorization: Bearer $CRON_SECRET" https://your-app.vercel.app/api/cron/reconcile
```

Every route returns 401 without that header — and also with it, if `CRON_SECRET`
is not set on the server at all, because an open endpoint that sweeps the whole
shipment table and emails the team is worse than a job that never runs.

The standalone worker (`jobs/worker.ts`) still exists for local development: one
process, real timers, no HTTP. It is not what runs in production.
