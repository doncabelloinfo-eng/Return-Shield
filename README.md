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

`reconcile` sweeps live shipments **every three hours**. Push is not
configured, so this is not a safety net for it — it is the only way an event
ever reaches us. Correos does not retry either way, so nothing else would ever
notice a dropped update, and a lost *"at office"* event would leave a countdown
wrong on the one screen whose whole job is to be right about how many days are
left.

A token is minted by OAuth client-credentials against CorreosID, with
`scope=TPB` — trackpub's own application code, and the single value that
decides whether any of this works — and cached until its `exp` claim minus a
minute; a 401 from trackpub drops it, fetches one more and retries once. Codes go up 100 to a request — the multi-parcel format is
undocumented, so the client tries comma-separated first, checks that the answer
actually covers what it asked about, and falls back to one request per code if
it does not. Which mode is in use is on the Settings screen, with a lever to
make it probe again.

Urgent parcels are swept first — `delivery_failed`, `at_office`,
`address_issue` — and the rest least-recently-checked first, so a run cut short
drops the ones where nothing is at stake. It is bounded by a batch cap and a
time budget, both inside the route's `maxDuration`, and it resumes:
`shipments.last_reconciled_at` is the cursor, and a run that stops early leaves
the rest for the next one. The client backs off on 429s and 5xxs and gives up
rather than hammering.

### The screens

**Today** is what needs doing. **Post office** is what a post office is
holding. **Parcels** is everything else — a tab per status in journey order,
each with its count, filtered and paged in SQL because a thousand parcels a day
means a screen that loads them all gets slower every day until it times out.

That third one was missing, and the gap was not academic: eleven parcels were
tracked, correct, moving normally through Correos, and on no screen at all.
Today lists only parcels with a next action and Post office only `at_office`,
so a parcel simply in transit was invisible.

Four tabs are not a status but a problem:

- **Stuck in pre-admission** — a label printed and nothing from Correos for two
  **working** days. Weekends never count: Correos does not admit parcels on a
  Saturday and the warehouse does not hand them over, so a Friday label is not
  late on Monday. Flagging it would teach the operator to ignore the badge.
- **Same status 3+ working days** — delivery takes two to three, so a parcel
  that has said the same thing for three full working days has stopped moving
  without Correos saying anything is wrong.
- **Missed delivery, at the post office** — Correos tried, nobody took it, and
  it is now sitting at an office with a countdown running. These are the
  customers to ring today, so the row carries the phone, the WhatsApp link with
  the finished Spanish text, the email, the office and its address, the last
  day and the number of attempts. A parcel sent *straight* to an office the
  customer chose is not here; nobody missed anything.
- **Stuck 30+ days, not finished** — past the cleanup window and still going.
  These are kept rather than deleted, and this is how anybody finds out.

Columns include **Ordered** and **Shipped**, and the filter bar has a date
picker that lists what went out on a given Madrid day. The marketplace files
have no order date, so those rows show "—" rather than the ship date twice.

**The operator reads English.** Every label, tab, badge, button and timeline
entry leads in English, with Correos' own Spanish underneath in a smaller muted
line — because that is the phrase to match when ringing them or reading the
public tracker, and it is evidence, so it is never rewritten. Customer-facing
text is the other way round and stays Spanish: the WhatsApp templates and the
public `/e/{token}` pages are read by Spanish customers.

### Closing a parcel by hand

"Stop chasing this one" needs a reason: **Lost**, **Delivered (confirmed by
hand)**, **Returned (received back)** or **Other**, which requires a note. It
used to write a timestamp and nothing else, so a month later a parcel Correos
lost and one the customer had all along were the same row.

Each closure also writes a small permanent row to `closures` — order number,
shop, code, reason, note, value, days from order, who and when, and no customer
details. The 30-day cleanup never touches that table, so "how many did we lose
last quarter, and to what" still has an answer after the parcel has gone.
Undoing a closure marks the row undone rather than deleting it; every count
excludes those.

### Shopify

One webhook route per store, HMAC verified on the raw bytes before the body is
parsed. `shopify-backfill` pulls recent fulfilments hourly and inserts anything
whose webhook never arrived, because webhooks are lost more often than people
expect. The Admin API version is one constant in
`lib/carriers/shopify/api.ts` — Shopify does not reject a retired version, it
quietly serves the oldest one it still supports, so a stale version here is
invisible rather than loud.

Orders are read a page at a time, 250 at a time, following Shopify's `Link`
header to the end — the hourly check used to ask for 100 and read the first
page only, which at a thousand parcels a day was a fraction of two days of
orders with nothing to say so. **Settings → Shopify** has a "Pull the last 30
days" button per shop, which is also how a newly connected shop gets any
history. History arrives quietly: a parcel delivered before the pull gets no
ticker line and no task, and none of the reminders that were due while nobody
was watching.

Adding a store needs no code: a row in `stores`, a webhook made in that store's
Shopify admin, and an Admin API token from a per-store custom app. The
procedure is in [docs/deploying.md](docs/deploying.md#adding-a-shopify-store).

Orders that Shopify syncs in from TikTok are **deliberately ignored** — they
carry `PKA6TP…` codes with no carrier name, so `isCorreos` does not recognise
them. TikTok comes in through the file upload on the Import screen, and
teaching `isCorreos` to accept a bare `PKA6TP…` would ingest those orders
twice.

### Uploading TikTok and Amazon files

**Upload orders** takes the shipping-confirmation export as it comes — `.txt`,
`.csv`, `.tsv` or `.xlsx`. Both marketplaces export the *same eight columns*,
so each row's marketplace is worked out from its order id and never from the
file name: one real file was `Seguimiento_Amazon_07102026_015340.txt` and the
other `tiktok shop.txt`, and people rename these. A file may hold both kinds.

These files carry no name, phone, email, address or value. That is normal, so a
missing phone is not an error in one of them — and the parcels are contacted
through the marketplace's own chat instead. The order number stands in for the
customer name on the screens, and the Spanish message drops the greeting name
and the "somos {shop}" accordingly, because it is pasted into a thread that
already shows the seller.

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
| `reconcile` | every 3 hours | trackpub sweep, 100 codes a request, urgent parcels first |
| `push-drain` | every 5 min | turns staged Correos payloads into events |
| `push-heartbeat` | hourly | no events in working hours means it broke |
| `shopify-backfill` | hourly | fulfilments whose webhook never arrived |
| `stale-detector` | from 07:30 | flags anything silent over the configured window |
| `daily-digest` | from 08:00 | emails what to do today, in order |
| `import-reminder` | from 09:00 | nudges if TikTok has not been uploaded |
| `postcode-stats` | nightly | rebuilds the failure rates behind the warning |
| `housekeeping` | nightly | expired sessions, old rate limits, and the rolling 30-day window |

Push is not configured, so `reconcile` is not a safety net — it is the only way
an event arrives. `push-drain` and `push-heartbeat` skip immediately until it
is; the heartbeat in particular would otherwise raise a false alarm every
working hour.

"From 07:30" means hourly with a catch-up check, not at 07:30 exactly: the first
invocation past the hour in Madrid does the work and the rest of the day's find
it already done. Vercel never retries, so a job pinned to one invocation is a
job that silently does not happen on the day that invocation is dropped.

In production each of these is a route under `app/api/cron/`, scheduled by
`vercel.json` and authenticated with `CRON_SECRET` — every one returns 401
without it. **You set `CRON_SECRET` by hand; Vercel does not generate it.**
Locally the same functions run under `npm run worker`. The job code is identical
either way; see [docs/cron.md](docs/cron.md) for the UTC-to-Madrid handling, the
per-job lock and the catch-up rule.

Every one is idempotent — assume it will run twice, because it will. Each takes
a lease in `job_locks` first, and every message, task and alert it could create
is unique in the database, so two overlapping runs cannot double-send even with
the lock bypassed.

**If nothing is running, every screen says so.** A missing or wrong
`CRON_SECRET` makes every cron route answer 401 while the dashboard carries on
showing countdowns that nothing is counting down — the one failure here that is
invisible from the inside. So when no job has succeeded in 45 minutes, a banner
appears on every panel screen, it distinguishes "nothing has ever run" from
"stopped at *time*", and it is not dismissible. Settings → Connections breaks it
down per job: when each was last heard from, and when each last did something.

```bash
npm run job daily-digest                # locally
curl -H "Authorization: Bearer $CRON_SECRET" \
  https://your-app.vercel.app/api/cron/reconcile
```

---

## What is deliberately not automated

Two things always sit behind the tap-again confirmation, and the system will
never do them on its own:

- **Mark new address as sent to Correos** — a redirection is arranged by a
  person, Correos charge for it, and closing the task is not undoable.
- **Stop chasing this one** — nothing brings the parcel back afterwards.

Everything else happens by itself.

The system also never invents a Correos event, and no longer invents a date
either. It used to work out when a parcel would go back — arrival plus a
"deposit window" an operator typed in, 15 days, never confirmed with anybody —
and every countdown, last day and customer message came off it. Correos
announce the return themselves (`L03D320R`, phase `DEVOLUCION`), so the
screens show how long a parcel has been at the office and nothing claims to
know when it leaves. See DECISIONS.md section 5.

---

## When an integration is not set up

The app runs with four variables: `DATABASE_URL`, `SESSION_SECRET`,
`CRON_SECRET` and `APP_URL`. No Correos, no Shopify, no WhatsApp.

A missing integration disables itself and says so on the Settings screen, in
terms of what it costs — *"the sweep does nothing, and it is the only way an
event reaches us at all"* — with the variables still to set underneath. The jobs
that need one report that they skipped.

Trackpub needs four variables from two different Correos systems — the gateway
pair `CORREOS_CLIENT_ID` / `CORREOS_CLIENT_SECRET` from the developer-portal
app, and `CORREOS_OAUTH_CLIENT_ID` / `CORREOS_OAUTH_CLIENT_SECRET` from the
CorreosID system-user application — so Settings calls it ready only when all
four are set, and **Test Correos connection** on that screen checks them in two
steps: mint a token (it reports how many minutes it lasts, never the token
itself), then look up a tracking code you type in. Nothing crashes,
because none of those credentials exist on day one and somebody still has to be
able to log in and learn the screens.

## Before this goes live

See [DECISIONS.md](DECISIONS.md) for where this departs from the prototype and
why, and [docs/deploying.md](docs/deploying.md) for the deployment itself.
