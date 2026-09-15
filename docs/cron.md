# The schedule

Vercel Cron runs everything in **UTC**. Madrid is UTC+1 in winter and UTC+2 in
summer, so a fixed UTC schedule drifts by an hour twice a year.

For the four jobs where nobody would notice an hour either way, we accept the
drift. For the three where the hour is the whole point, the schedule fires at
**both** candidate UTC hours and the job checks the Madrid-local hour and does
nothing on the wrong one (`onlyAtMadridHour` in `lib/cron.ts`). Exactly one of
the pair does the work on any given day, all year.

| Route | UTC schedule | In Madrid | Hour guarded? |
|---|---|---|---|
| `push-drain` | `* * * * *` | every minute | — |
| `escalation-tick` | `*/30 * * * *` | every 30 min | — |
| `reconcile` | `10 */2 * * *` | every 2 hours | — |
| `push-heartbeat` | `5 * * * *` | hourly | — (checks working hours itself) |
| `shopify-backfill` | `15 * * * *` | hourly | — |
| `stale-detector` | `30 5,6 * * *` | 07:30 | yes — Madrid hour 7 |
| `daily-digest` | `0 6,7 * * *` | 08:00 | yes — Madrid hour 8 |
| `import-reminder` | `0 7,8 * * *` | 09:00 | yes — Madrid hour 9 |
| `postcode-stats` | `45 1 * * *` | 02:45 or 03:45 | no — drift is harmless |
| `housekeeping` | `15 3 * * *` | 04:15 or 05:15 | no — drift is harmless |

## Two jobs the brief's table left out

**`push-drain`** is load-bearing. The Correos receiver returns 200 and writes
the raw body to `correos_push_inbox`; nothing becomes an event until this runs.
Without it, tracking simply stops arriving and only the two-hourly reconcile
would ever notice. It runs every minute.

> An alternative on Vercel is `waitUntil()` from `@vercel/functions`, letting
> the receiver process after responding. We kept the staging table because it
> survives a crash mid-processing and leaves the raw payload as evidence, which
> is what makes "fix the normaliser and replay" possible.

**`housekeeping`** clears expired sessions, old rate-limit buckets and push
payloads over 90 days old. Nightly, drift irrelevant.

## Why reconcile moved from nightly to every two hours

Correos does not retry a push. A dropped event is only ever repaired by this
sweep, so running it nightly meant a lost *"at office"* event could leave a
countdown up to a day wrong — on the one screen whose entire job is to be right
about how many days are left.

It is bounded twice: at most `RECONCILE_BATCH_SIZE` parcels (200), and it stops
starting new lookups after `RECONCILE_BUDGET_MS` (45s), both well inside the
route's 60s `maxDuration`. The run always ends by choice, never by being killed
half way through.

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
{ "checked": 200, "recovered": 3, "queued": 200, "stillToCheck": 41,
  "tookMs": 44_812, "stoppedEarly": "ran out of time — the next run continues from here" }
```

`stillToCheck` above zero across several consecutive runs means the sweep is not
keeping up: raise `RECONCILE_BATCH_SIZE`, or the frequency, or both.

## Running one by hand

Locally, without HTTP:

```bash
npx tsx jobs/run-once.ts daily-digest
```

Against a deployment:

```bash
curl -H "Authorization: Bearer $CRON_SECRET" https://your-app.vercel.app/api/cron/reconcile
```

Every route returns 401 without that header.
