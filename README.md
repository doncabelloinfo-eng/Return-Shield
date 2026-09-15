# Return Shield

A parcel that fails delivery in Spain goes to a post office, sits there for
about a fortnight, and then goes back to the sender. The business loses the
outbound leg, the return leg and two weeks of blocked stock — and on cash on
delivery, all the revenue.

This makes that countdown visible and acts on it.

Open it in the morning and it tells you what to do first, why it is first, and
puts one button on it.

---

## Running it locally

```bash
cp .env.example .env          # DATABASE_URL and SESSION_SECRET are enough to start
npm install
npm run db:migrate
npm run db:seed               # creates your login; with DEMO_MODE=1, sample parcels too
npm run dev                   # the dashboard
npm run worker                # the jobs — a separate process, on purpose
```

`npm run db:seed` reads `SEED_EMAIL` and `SEED_PASSWORD`. Afterwards, add
people with `npx tsx scripts/create-user.ts ana@example.com "Ana Ruiz"`.

**Something has to run the jobs.** Locally that is `npm run worker`; in
production it is Vercel Cron. Without either, nothing escalates, nothing is
reconciled with Correos, and the countdowns are the only thing still working.

Run a single job by hand at any time:

```bash
npm run job daily-digest
```

### Deploying

See **[docs/deploying.md](docs/deploying.md)** for Vercel — environment
variables, migrations, and the first-deploy order — and
**[docs/cron.md](docs/cron.md)** for the schedule.

The check to run before pushing:

```bash
DATABASE_URL= npm run build
```

With the variable deliberately empty, the build must still succeed. Nothing
constructs a database client at module scope, so a build — including every
preview deployment and every CI run — never needs a live database. If that
command fails, something has started opening a connection at import time.

### Tests

```bash
npm test           # creates <database>_test, migrates it, runs everything
npm run typecheck
```

Tests never touch your development database: `tests/setup.ts` redirects them to
`<database>_test`, and the truncate helper refuses to run against anything whose
name does not end in `_test`. It also clears `DEMO_MODE` and every integration
credential, so a run on your machine exercises the same thing as a run in CI.

---

## How it is put together

```
app/
  (panel)/         today · office · parcel/[id] · import · calls · settings
  e/[token]/       the customer's own page — public, no login
  api/
    webhooks/correos/track     Correos calls this
    webhooks/shopify/[store]   one route per store, HMAC checked
    actions/[token]            the four buttons a customer can tap
  actions/         server actions: everything a button on a screen does
lib/
  carriers/correos/    the Spanish-to-state table, the payload normaliser, trackpub
  carriers/shopify/    HMAC verification and fulfilment ingest
  messaging/           MessageProvider + the Spanish templates
  state-machine/       states, transition guards, and the projection from events
  escalation/          the ladder, the decisions, the runner
  import/              phone normalisation, CSV/XLSX parsing, the commit
  clock.ts             now() — injectable, see "The time machine"
  cron.ts              the wrapper that turns a job into an authenticated route
  integrations.ts      what is connected and what each gap costs
jobs/                  every scheduled job, and the local pg-boss worker
db/                    schema, migrations, seed
docs/                  deploying.md, cron.md
vercel.json            the cron schedule
```

### Events are the source of truth

`shipment_events` is append-only. The `shipments` row — its state, its office,
its deadline — is a projection, rebuilt by `lib/state-machine/project.ts`, which
is a pure function of the events.

That is what makes a normaliser bug survivable. Fix the mapping, replay the
events, and every parcel is right again. Nothing is patched in place, so there
is nothing to un-patch.

```ts
await reprojectAll();   // after changing lib/carriers/correos/state-map.ts
```

### The one index that matters

```sql
UNIQUE (shipment_id, event_code, occurred_at)
```

Push and nightly polling both write the same events. Without this, every
nightly sweep would re-fire the whole escalation ladder at customers who
already heard from us. With it, the second write is a no-op and nothing
downstream runs — which is why the reconcile job is safe to run as often as
you like.

### The office deadline is never hardcoded

`office_deadline = office arrival + product_rules.deposit_days`, worked out in
Madrid calendar days, ending at the end of the last day. Change the number on
the Settings screen and every deadline, countdown and reminder is recalculated
immediately — including the ones that are now in the past, which is exactly
what happens when Correos changes how long they hold things.

**The fifteen is a guess.** It has not been confirmed with Correos. The
Settings screen says so until somebody ticks it off.

---

## The escalation ladder

After a failed delivery, counted forward:

| | |
|---|---|
| +15 min | first message |
| +4 h | reminder to confirm the address |
| +24 h | call task, if nobody replied |
| +48 h | Correos normally has it at the office by now |

At the office, counted backwards from the deadline **D**:

| | |
|---|---|
| D−15 | the office details and the code |
| D−12 | it is still waiting |
| D−8 | we can send it somewhere else |
| D−4 | four days left |
| D−2 | last warning, plus a call nobody may skip |
| D−0 | flag it, alert internally |

Silence falls the moment a `delivered` or `collected` event arrives, or the
customer taps something.

**Ordering is by money at risk, not only by days left.** Cash on delivery is the
whole sale; prepaid is the refund plus both legs of postage. Every row says why
it is where it is.

### Call outcomes drive the machine

| Outcome | What the system does next |
|---|---|
| Will pick it up | quiet for 3 days, then checks it actually happened |
| Wants new address | stops the countdown messages, asks you to sort it with Correos |
| Didn't pick up | back on the list tomorrow, same time |
| Doesn't want it | stops everything, alerts internally, readies the return |

A promise is not a collection: "will pick it up" silences the reminders but
leaves the last warning and the return alert armed.

---

## The time machine

`lib/clock.ts` is the only place that knows what time it is, and every
escalation decision reads from it.

This buys two things. The ladder can be driven from a failed delivery to a
return in a test in well under a second instead of fifteen real days. And the
demo survives, so the system can be shown to somebody without pointing it at
real customers.

`setClock` throws unless `NODE_ENV=test` or `DEMO_MODE=1`. A running business
cannot be given a time machine by accident.

```ts
const clock = new TestClock('2026-09-01T10:00:00+02:00');
clock.install();
clock.advanceDays(13);
```

---

## Integrations

### Correos Track&TracePush — they call us

`POST /api/webhooks/correos/track`, authenticated with `clientID` /
`clientSecret` headers and optionally an IP allowlist
(`CORREOS_PUSH_ALLOWED_IPS`).

**It returns 200 immediately and processes later.** The raw body goes into
`correos_push_inbox`; the `push-drain` job turns it into events. There is no
guaranteed retry from Correos — an event we are slow to acknowledge, or 500 on,
is simply gone. Even a body we cannot parse is stored and acknowledged.

Test against their public mock at `mocks.correospre.es` before telling Correos
the URL exists.

### Correos trackpub — we call them

`reconcile` sweeps live shipments **every two hours**. This is the safety net
for push: Correos does not retry, so if the receiver was down for an hour,
nothing else will ever notice. Nightly would have meant a lost *"at office"*
event leaving a countdown up to a day wrong.

It is bounded — a batch cap and a time budget, both inside the route's
`maxDuration` — and it resumes: `shipments.last_reconciled_at` is the cursor,
and a run that stops early leaves the rest for the next one. The client backs
off on 429s and 5xxs and gives up rather than hammering.

### Shopify

One webhook route per store, HMAC verified on the raw bytes before the body is
parsed. `shopify-backfill` pulls recent fulfilments hourly and inserts anything
whose webhook never arrived, because webhooks are lost more often than people
expect.

### WhatsApp

`lib/messaging` defines `MessageProvider` and nothing else in the codebase
knows what is underneath.

- **Step 1** (`WHATSAPP_PROVIDER=none`) — no provider. The system still writes
  every message at exactly the moment it is due, and puts it in front of an
  operator to send: *Copy message* and a `wa.me` link.
- **Step 2** — an adapter sends the same text automatically.

Templates carry **link buttons only, never quick replies**. The number cannot
receive replies, so a quick-reply button would let a customer think they had
acted when nobody is listening.

Messages are only sent between 09:00 and 21:00 Madrid. One due at 04:00 waits
for the morning — the call task attached to the last warning does not.

---

## Scheduled jobs

| Job | When (Madrid) | Does |
|---|---|---|
| `escalation-tick` | every 30 min | fires whatever rung is due |
| `push-drain` | every minute | turns staged Correos payloads into events |
| `reconcile` | every 2 hours | trackpub sweep — the safety net for push |
| `stale-detector` | 07:30 | flags anything silent over the configured window |
| `daily-digest` | 08:00 | emails what to do today, in order |
| `push-heartbeat` | hourly | no events in working hours means it broke |
| `shopify-backfill` | hourly | fulfilments whose webhook never arrived |
| `import-reminder` | 09:00 | nudges if TikTok has not been uploaded |
| `postcode-stats` | nightly | rebuilds the failure rates behind the warning |
| `housekeeping` | nightly | expired sessions, old rate limits, old payloads |

In production each of these is a route under `app/api/cron/`, scheduled by
`vercel.json` and authenticated with `CRON_SECRET` — every one returns 401
without it. Locally the same functions run under `npm run worker`. The job code
is identical either way; see [docs/cron.md](docs/cron.md) for the UTC-to-Madrid
handling.

Every one is idempotent — assume it will run twice, because it will.

```bash
npm run job daily-digest                # locally
curl -H "Authorization: Bearer $CRON_SECRET" \
  https://your-app.vercel.app/api/cron/reconcile
```

---

## What is deliberately not automated

Two things always sit behind the tap-again confirmation, and the system will
never do them on its own:

- **Send to a new address** — Correos charges for a redirection.
- **Stop chasing this one** — nothing brings the parcel back afterwards.

Everything else happens by itself.

The system also never invents a Correos event. When the deposit window runs out
it flags the parcel and alerts internally; it does not write a return event
that Correos has not sent. The prototype faked those because it had no Correos
to talk to.

---

## When an integration is not set up

The app runs with four variables: `DATABASE_URL`, `SESSION_SECRET`,
`CRON_SECRET` and `APP_URL`. No Correos, no Shopify, no WhatsApp.

A missing integration disables itself and says so on the Settings screen, in
terms of what it costs — *"the two-hourly sweep does nothing, and it is the only
thing that repairs an update Correos dropped"* — with the variables still to set
underneath. The jobs that need one report that they skipped. Nothing crashes,
because none of those credentials exist on day one and somebody still has to be
able to log in and learn the screens.

## Before this goes live

See [DECISIONS.md](DECISIONS.md) for where this departs from the prototype and
why, and [docs/deploying.md](docs/deploying.md) for the deployment itself.
