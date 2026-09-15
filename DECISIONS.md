# Decisions, and the things that still need answering

Everything here is either a call I made that you might want made differently,
or a question I could not answer from the prototype and the brief.

---

## 1. Hosting — decided: Vercel Pro

This was the open question in the first pass. It is now settled: the whole app
runs on Vercel Pro, jobs included.

**What that changed.** The always-on pg-boss worker cannot run there, so every
job is now a route under `app/api/cron/` scheduled by `vercel.json`. The job
functions themselves are untouched — they were already separate and idempotent,
so it was wiring. `npm run worker` still exists for local work and demo mode.

**What is still worth knowing.** IP filtering is Enterprise-only, so on Pro the
`clientID` / `clientSecret` pair is the only control on the Correos receiver.
That is a real control, and the endpoint is the least dangerous one in the app —
it authenticates, writes a row to a staging table, returns 200, and `push-drain`
later ignores anything whose tracking code we do not recognise. Keep the
credentials long and rotate them. If Correos ever insist on an allowlist, that
one route moves to a small always-on host and nothing else does; it has no
dependency on any other route.

The cold-start worry does not apply, because the receiver was already built to
return 200 and process later. A cold start costs latency, not the event.

**Reconcile went from nightly to every two hours** at the same time. Correos
does not retry a push, so that sweep is the only thing that ever repairs a
dropped event — nightly meant a lost *"at office"* could leave a countdown up to
a day wrong, on the one screen whose whole job is to be right about how many
days are left. Two hours cuts that to two, and on Pro it costs nothing.

### The build must never need a database

The first deploy failed on `Collecting page data` with `DATABASE_URL is not
set`, because the client was built at module scope — importing a route module
opened a connection.

Setting the variable in Vercel would have made the error go away and left the
problem: every build, every preview deployment and every CI run would need to
reach the live production database. Now everything goes through `getDb()`,
which builds the client on first call, and `DATABASE_URL= npm run build` is the
check that it stays that way.

## 2. Where I departed from the prototype

The prototype is the specification, and I ported it. These are the places I did
not, and why. Each one is a small revert if you disagree.

### The escalation engine never invents a Correos event

The prototype's `f48` rung synthesised a *"Disponible en oficina para recoger"*
event, and `o0` synthesised *"Devolución a origen iniciada"*. That was the
simulator standing in for Correos.

In production, writing an event Correos never sent would poison the one table
that is supposed to be the truth — and the parcel timeline would show Correos
saying something Correos never said. So:

- **f48** opens a task: *"Two days since the missed delivery and Correos has
  not said it reached an office"*. If Correos genuinely has not scanned it,
  that is worth a person looking, not something to paper over.
- **o0** flags the parcel, alerts internally, and opens a task to confirm with
  Correos. The real `returning` state still arrives from Correos, and when it
  does everything behaves as the prototype did.

### "Stale" is 72 hours, not 5 days

The brief says over 72 hours, twice. The prototype's screen said five days. I
went with the brief, and put the number in `settings` so it is one change
rather than an argument. The task label follows the setting, so at 72 hours it
reads *"No update for 3 days — ask Correos"*.

### Messages are not sent between 21:00 and 09:00

The prototype's clock moved in whole days and never landed at four in the
morning. A real one does, every night. A WhatsApp at 04:00 about a parcel is
how a send-only number gets reported.

A message due in the quiet hours waits for 09:00. **The call task attached to
the D−2 last warning is not held back** — a task appearing on a list wakes
nobody, and delaying it until nine on the second-to-last day is exactly the
delay that loses the parcel.

### Dates in Spanish messages use Spanish months

The prototype rendered *"16 Sep"* from an English month table. The operator
screens still do. The customer messages now say *"16 sep"*, because they are
read by Spanish customers.

To revert: `shortDateEs` → `shortDate` in `lib/messaging/build-message.ts`.

### The deadline is the end of the day, not an instant

The prototype's deadline was `arrival + 15 × 24h` exactly. A parcel that
reached the counter at 13:47 does not go back at 13:47 a fortnight later — it
goes back at the end of its last day. Treating it as an instant warns customers
a day early and writes off parcels that are still collectable.

Related: all day arithmetic counts Madrid calendar days rather than blocks of
86,400,000 ms. There is a test for the October clock change; the millisecond
version was off by one across it.

### Task types have reason codes

The prototype's `nextAction()` decided what to show by matching the *start of a
task's label* (`label.indexOf('No update') === 0`). That works until somebody
improves the wording.

Tasks now carry a `reason` code that the code switches on, and the label is
still the exact sentence an operator reads. The prototype's five kinds map to:
`urgent` → `address_fix` / `chase_carrier`, `stock` → `receive_return`,
`call`, `contact` and `insight` unchanged.

### The import screen takes real files

The prototype had a *"Pretend to upload a file"* button. This takes a real CSV
or XLSX, matches column headers loosely (TikTok has renamed them at least
twice), and shows the same preview. Nothing is written until the preview is
confirmed.

### The "areas we watch" list is computed, not hardcoded

The prototype hardcoded Manacor, Telde and Elche. The `postcode-stats` job
builds it nightly from what has actually failed, and only watches a postcode
once it has at least 8 parcels and fails at least twice the average rate —
otherwise a new town whose only two parcels both failed would cry wolf.

**It will be empty for the first few weeks.** That is correct, and the Settings
screen says so rather than showing a blank table.

### A half-configured integration disables itself rather than throwing

`messageProvider()` used to throw when `WHATSAPP_PROVIDER` was set but its
credentials were not. On Vercel that is one mistyped variable away from taking
the escalation engine down entirely.

It now falls back to Step 1 with a warning: every message is still written at
exactly the right moment and put in front of an operator. Wrong in a small way,
where throwing was wrong in a large one. The same reasoning runs through
`lib/integrations.ts` — a missing credential is a notice on the Settings screen
saying what it costs, not a stack trace.

### The demo clock is behind DEMO_MODE

The prototype's +1 hour / +1 day / Play / Start over controls only appear with
`DEMO_MODE=1`, and `setClock` throws otherwise. The offset lives in the
database so the dashboard and the worker agree about what time it is.

---

## 3. Things I chose, where the brief left it open

| | Chose | Why |
|---|---|---|
| ORM | Drizzle | The projection is the important code and it is plain SQL-shaped; Drizzle stays out of the way. |
| Jobs | pg-boss | Schedule lives in Postgres, so it survives restarts and does not run N times on N instances. |
| Money | integer cents | Every sum and every "most money at risk" ordering happens in SQL, and floats lose cents. |
| Passwords | scrypt, from `node:crypto` | No native build, no dependency that can be taken over. Parameters are stored in the hash, so raising them later locks nobody out. |
| Sessions | random id in the cookie, its hash in the table | A leaked database backup is not a set of live sessions. |
| Import route | server action, not `api/import/tiktok` | The brief allows either. A server action gets the file straight into a typed function with the session already resolved. |

---

## 4. Still open

- **`CRON_SECRET` must be set in production.** Every cron route refuses every
  request without it. That is deliberate — an open endpoint that sweeps the
  shipment table and emails the team is worse than a job that never runs — but
  it does mean a deployment that forgets it has a dashboard and no engine, and
  nothing on the dashboard will say so. The job-run rows in `job_runs` going
  quiet is the symptom.
- **The deposit window.** 15 days is unconfirmed. The Settings screen shows an
  amber banner until somebody ticks each service off, and every countdown is an
  estimate until then. It may also differ per service — the table is per
  product code so that is already possible.
- **Correos event codes.** `BY_CODE` in `state-map.ts` is deliberately empty:
  every mapping currently matches on the Spanish wording, which is all the
  prototype gave us. Guessing a numeric code is worse than falling back to the
  wording, because a wrong code maps silently while a missing one asks a human.
  Fill it in from real traffic — the Settings screen lists everything Correos
  has said that we do not recognise.
- **Office opening hours** are currently one default string for every office.
  Correos' push payload carries an office code; if their API exposes hours per
  office, `offices.opening_hours` is waiting for them.
- **Which store a TikTok upload belongs to.** Every upload goes to one
  `tiktok-es` store. If you run more than one TikTok shop, the import screen
  needs a picker.
- **The `product_code` for Shopify fulfilments** is parsed out of
  `tracking_company` (`"Correos PAQ 48"` → `PAQ 48`). If your stores do not put
  the service in that field, this needs to come from somewhere else — and it
  matters, because it picks the deposit window.

---

## 5. What I would do next

1. **Point it at the Correos mock.** `CORREOS_TRACKPUB_BASE_URL` already
   exists; the push receiver can be pointed at from their Postman collection.
   Everything else is ready.
2. **Watch the review queue for a fortnight.** Every unmapped code Correos
   sends lands on the Settings screen. After two weeks you will know what the
   real mapping table looks like, and `reprojectAll()` will apply it to
   everything historic.
3. **Confirm the deposit window**, then tick the services off.
4. **Then Step 2.** The provider adapter is written and the templates are the
   same ones already going out by copy-paste, so it is an environment variable
   and a WhatsApp template approval — not a code change.
