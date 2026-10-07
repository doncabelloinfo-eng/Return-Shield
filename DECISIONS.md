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

**Reconcile went from nightly to every three hours** at the same time. Correos
does not retry a push, and push is not configured at all, so that sweep is not
a safety net — it is the only way an event ever arrives. Nightly meant a lost
*"at office"* could leave a countdown up to a day wrong, on the one screen whose
whole job is to be right about how many days are left.

Three hours rather than two because the arithmetic changed: at ~1,000 new
parcels a day about 5,000 are live, and batches of 100 codes make a full sweep
roughly 50 requests. Every live parcel is seen on every run, so the interval is
the staleness bound — three hours, against a 12-hour requirement, with room to
tighten it if Correos' gateway turns out to tolerate less.

### The build must never need a database

The first deploy failed on `Collecting page data` with `DATABASE_URL is not
set`, because the client was built at module scope — importing a route module
opened a connection.

Setting the variable in Vercel would have made the error go away and left the
problem: every build, every preview deployment and every CI run would need to
reach the live production database. Now everything goes through `getDb()`,
which builds the client on first call, and `DATABASE_URL= npm run build` is the
check that it stays that way.

## 2. Running on Supabase, and making a dropped job visible

### The transaction pooler was the plan, and it was wrong

The design was: the app on Supabase's **transaction** pooler (6543), which
multiplexes many short-lived serverless instances onto few backends and is
this workload's shape exactly; migrations on the **session** pooler (5432),
because an advisory lock and DDL need a session that stays on one backend.
`prepare: false` everywhere, not just on the pooler, because a connection
string can be changed without a deploy and a setting that only holds for
Supabase is a setting that breaks when somebody changes the URL.

**Both are now on 5432.** On 6543, production broke within minutes: `/today`
hung to the 300-second limit, push-drain's `job_locks` upsert hit a statement
timeout, and — the one that matters — a `contact_log` query ran with a
*different concurrent query's* parameters, `['PAQ ESTÁNDAR', 'PAQ 48', 'PAQ
PREMIUM']` against a uuid column. `22P02`, on `unnamed portal parameter $1`,
through a `Promise.all`.

postgres.js pipelines concurrent queries down one connection; Supavisor's
transaction mode can route those statements to different backends, so one
query's `Bind` lands on another's unnamed portal. `prepare: false` does not
prevent it, and was already set.

Two things are worth keeping about this.

It is a **correctness** failure wearing a performance failure's clothes. It
threw only because a uuid column rejected a product code. Two concurrent
queries with type-compatible parameters would have crossed in silence and
rendered one parcel's contact log under another parcel's name — and no screen,
log or test in this system would have noticed. The 504s were the symptom that
got attention; the crossing is the one that should have.

And the architectural lesson is narrower than "pooling is hard": **a pooler and
a client that both make reasonable assumptions can still be wrong together.**
Transaction-mode pooling assumes statements are independent; a pipelining
driver assumes a connection is its own. Neither is unreasonable. The seam
between them is where the data corrupted, and nothing in either component's
documentation is where you would look.

What session mode costs is a ceiling: one backend per client connection, so the
limit is the project's pool size (15) rather than hundreds. At `DB_POOL_MAX=3`
that is about five busy instances, which is fine at this volume and is written
down in `db/index.ts` next to the number, because the failure mode when it is
reached — the sixth instance waiting out `connect_timeout` — looks nothing like
a pool-size problem.

Fixing 6543 properly means not pipelining: a driver that serialises per
connection (`node-postgres`), or a transaction around each query so Supavisor
pins a backend. Neither is in here, and deliberately so — reproducing the
crossing needs a real Supavisor in transaction mode, which neither a dev
machine nor a cloud session can reach, and a driver swap touches every query in
the app. Shipping that on theory is how you trade a known problem for an
unknown one.

TLS is on for anything that is not local. An explicit `?sslmode=` always wins,
localhost and any database whose name ends in `_test` are exempt, everything
else requires it. One function, `connectionShape()`, so the app and the
migrator cannot drift apart on this.

### Migrations run from GitHub Actions, manually

Cloud sessions cannot reach Postgres ports, so somebody has to run migrations
from somewhere that can. Actions can. `workflow_dispatch` only — a migration
must never ride along with a deploy.

**The repository is public, so those logs are public.** Nothing in the workflow
prints a password, a connection string or an email address, the pre-flight
checks name a missing secret without echoing any value, and
`scripts/create-user.ts` is deliberately not used there: it prints a generated
password to stdout, which is right at a terminal and wrong in a public log. For
the same reason `db/migrate.ts` logs only the shape of the connection, and on
failure prints `err.message` rather than the error — a postgres.js connection
error carries the full options, password included.

`db:seed` is re-runnable: an existing user's password is never touched, and
there is no default password at all, so a seeded instance cannot be reachable
with a credential written down in this repository.

### A lease in a table, not an advisory lock

Vercel Cron is best-effort: no retries, occasional duplicate fires, overlapping
runs. The lock is a `job_locks` row with a `locked_until` lease, taken with a
single conditional insert-or-update that returns a row only to the winner.
Session advisory locks were the obvious answer and are the wrong one here, for
the pooler reason above.

A held lock returns **200** with `{ skipped: 'locked' }`. A 500 would make the
lock itself look like an outage, and the operator would learn to ignore the one
signal that is supposed to mean something.

The lock is the first line of defence and not the only one. Every message, task
and alert is unique in the database, so two concurrent ticks cannot double-send
even with the lock bypassed — which is how the concurrency test runs them,
deliberately.

**There is a crash window, and it is the honest trade.** A rung is claimed by
`markFired` before its side effect, so an instance killed between the two
leaves the rung marked fired and the message unsent. The alternative — send
first, record after — turns the same crash into a customer receiving the same
WhatsApp twice, possibly repeatedly. One missed message that the daily digest
and the parcel page both still show is recoverable by a human. A loop of
duplicates at a customer is not.

### Daily jobs catch up rather than firing at both candidate hours

The three daily jobs used to be scheduled at both UTC hours that could be the
right Madrid hour, doing nothing unless the Madrid hour matched. Correct and
fragile: Vercel never retries, so one dropped invocation meant the digest never
went out that day and nothing said so. They are now hourly with two questions —
past the hour in Madrid, and not already done today — so a dropped invocation
costs an hour.

"Already done" counts only a run with `ok` exactly true and `skipped` false,
within a Madrid day bounded at both ends. Each of those three conditions is a
bug that was available: `ok` null is an instance killed mid-run, a skip is a
run that correctly did nothing, and demo mode leaves `job_runs` rows dated in
the future which an open-ended `>= midnight` would read as "today is done".

### The engine's own failure had to become visible

A wrong `CRON_SECRET` makes every cron route answer 401 while the dashboard
carries on rendering countdowns that nothing is counting down. Parcels go back
and no screen says why. It is the one failure in this system that is invisible
by construction, so something had to go looking for it: no successful run in 45
minutes puts a banner on every panel screen, it is not dismissible, and it
names the two things that actually cause it.

It distinguishes "nothing has ever run" from "stopped at *time*", because those
have different causes and only one of them is a new deployment. A **skipped**
run counts as a heartbeat — it proves Vercel fired the route, the secret
matched, the database was writable and the job reached its end, which is
exactly what a 401 or a deleted schedule would deny us. A **failed** run does
not count: a job throwing every half hour proves the scheduler is alive and is
not something to be quiet about.

In demo mode the banner says nothing at all. Demo mode exists to jump the
clock, and "+1 day" moves `now()` forward with nothing running in between.

### The Correos token, and a batch format nobody documented

The developer portal does not say where the JWT comes from. Two open-source
SDKs independently do the same thing, so that is what this does — OAuth
client-credentials against CorreosID, `idToken` with `access_token` as a
fallback, cached until `exp` minus a minute, 25 minutes assumed if there is no
`exp`. The response field is configurable and a hand-pasted `CORREOS_JWT` still
works for testing. Nothing logs the token, at any level, ever.

**The scope is `TPB`, and the SDKs were wrong about it.** They send
`AP3 LBS RCG`; CorreosID issues a token for that scope without complaint and
trackpub then rejects every call with `401 {"error": "Invalid token."}`. The
real answer came from Correos support: `TPB` is trackpub's application code in
CorreosID, and a working token carries `aud=TPB`, `iss=CID` and `oid=<client
id>`. The lesson is not about the scope, which is now a constant with a comment
on it. It is that this app told the operator "check
CORREOS_OAUTH_CLIENT_ID" — our guess — where Correos had said "Invalid token."
Everything in that exchange was pointing at the wrong variable, and it cost a
day. Every non-2xx answer now carries their status and their body, and the hint
comes after it rather than instead of it.

The multi-parcel format is genuinely undocumented: the manual says 100 codes a
request and does not say how to write them. So the client tries
comma-separated, then **checks the answer actually covers the codes it asked
about**, and falls back to one request per code if it does not. That coverage
check is the part that matters: without it a response that quietly ignored half
the codes would stamp those parcels as freshly checked, and their countdowns
would go stale with nothing on any screen to say so.

The verdict is sticky, and that cuts both ways: it saves 5,000 requests a run
when batching works, and it would cost 5,000 when a single odd answer
downgraded it wrongly. So a zero-coverage answer only downgrades a format that
has never been **proven**, and there is a lever on the Settings screen to make
it probe again.

### The response shape was nothing like the push feed's

trackpub v2 answers `/search` with `code`, `events[]`, `summaryText` and
`eventHours`. This app was reading `codEnvio`, `eventos[]`, `desEvento` and
`horEvento`, which is what the Track&TracePush body uses. Both feeds are still
read, because both exist.

The failure was the interesting part: a token that worked, HTTP 200, and a
Settings screen reporting *"Correos knows the code but has no events for it
yet"* about a parcel with three events. Nothing was an error anywhere. Left
alone, every parcel would have sat in `created` until its deposit window ran
out, and the dashboard would have looked fine the whole time. A parse that
returns zero events needs to be as loud as a parse that throws — which is why
the fixture in `tests/helpers/correos.ts` is a verbatim capture, nulls
included, rather than a payload written to match the parser.

Three event codes are now confirmed from that traffic and keyed in `BY_CODE`;
everything else still matches on the Spanish wording. Correos' coarse
`phaseDes` is a third fallback below both, and an event rescued by its phase is
still queued for review: the phase keeps the parcel moving, and it is not a
claim that we understand the event.

### Empty is unset

`process.env.X ?? default` reads as "use the default when X is not configured"
and does not do that: `??` fires on `undefined`, and a key added through a
hosting dashboard with the value left blank is the empty string. Every read now
goes through `lib/env.ts`, which treats blank and whitespace as absent and
trims what it returns.

Two of these were live. `CORREOS_TRACKPUB_BASE_URL` was added with no value, so
every lookup fetched a relative URL and production said `Failed to parse URL
from /search/PK…` — naming no variable. And `Number(process.env.X ?? 6000)` is
worse than it looks, because `Number('')` is 0: a blank
`RECONCILE_BATCH_SIZE` would have been a sweep that checked no parcels and
reported success.

---

## 3. The screens, the language, and what gets deleted

### Three screens answering three different questions

Today answers "what do I have to do". Post office answers "what is being
held". Neither answers "where is everything", and that gap was not academic:
eleven parcels were tracked, correct, moving normally through Correos, and on
no screen at all. Today lists only parcels with a next action; Post office
lists only `at_office`. A parcel in transit existed in the database and nowhere
a human could see it.

Parcels is a tab per status, filtered and paged **in SQL**. `officeView` loads
every row and filters in memory, which is fine for the few dozen a post office
holds and wrong at a thousand a day: thirty thousand rows in the window, and a
screen that loads all of them to show a hundred gets slower every day until it
times out.

Every tab's count comes from the same predicate as its list, in one statement
with `count(*) FILTER`. Two queries that agree today drift the moment somebody
edits one, and a tab that says 7 and lists 5 is a screen nobody trusts again.
The one exception is deliberate and commented: the Closed-by-hand count comes
from `closures`, because that is the table its list reads.

### Two working days, not forty-eight hours

"Stuck in pre-admission" counts **working days**. Correos does not admit
parcels at the weekend and the warehouse does not hand them over, so a label
printed on Friday afternoon is not late on Monday morning — nothing could have
happened in between. Counting in hours would flag it, the operator would look,
find nothing wrong, and learn to ignore the badge. **A badge that cries wolf is
worse than no badge**, and that is the whole reason this is more complicated
than a subtraction.

The implementation has a seam worth knowing about. The badge needs a count per
row; the tab needs a predicate the database can run against thirty thousand
rows. So there are two functions — `workingDaysSince` for the row and
`workingDayCutoff` for the query — and they must agree exactly, or a parcel
appears in the stuck tab with no badge, or carries a badge and is missing from
the tab. The cutoff works because the rule is monotonic: an earlier label is
always at least as stuck, so there is exactly one cutoff instant. A test walks
fourteen days against four different "today"s and asserts the two answers
match, because that is the kind of agreement that rots silently.

Holidays are deliberately absent. Spain has national, regional and local ones,
and a half-built list is worse than an honest Monday-to-Friday — so the rule
lives in one function, `isWorkingDay`, ready for them.

### English first, Spanish second, and Spanish for the customer

The operator reads English. The parcel timeline led with Correos' Spanish in
italics and put our English in a small chip underneath, which made it a column
of sentences to decode before it could be used — "Clasificado" and "Admitido."
are not guessable.

So every label, tab, badge, button and timeline row leads in English, with
Correos' phrase beneath it, smaller and muted. Their wording is never rewritten
or translated, only labelled: it is the sentence to read out when ringing them
and the string to match against the public tracker. It is evidence.

The other half of the rule is easier to break by accident, so it has its own
tests: **customer-facing text stays Spanish.** The WhatsApp templates and the
public `/e/{token}` pages are read by Spanish customers, and "translate
everything to English" would send them a message they cannot read.

Three of the new tracker wordings were deliberately NOT mapped, and the reason
is the same each time — a word that nearly means something is worse than one
that means nothing. "Llegada a la oficina de destino" says the parcel reached
the office, not that the customer can collect it; mapping it to `at_office`
would start the deposit countdown early and send somebody to collect a parcel
that is not collectable. "Alta en unidad de reparto" is the delivery unit
booking it in, not a van on the road. Both go to the review queue, where a
human can look at real traffic.

### A rolling window, because the database has a ceiling

500 MB on Supabase's free plan, 13 MB used, and nothing deleting anything. One
`shipment_events` row is about 550 bytes of raw payload, so a thousand parcels
a day is roughly a gigabyte a year: the only question was when writes would
start failing, and when they did, tracking would stop arriving with nothing on
any screen to explain it.

The window is thirty days and it rolls: every night the job deletes the day
that has just become the thirty-first day back. Never a sweep that removes
everything older than X at once. The job is identical on its first night and
its thousandth, which means a mistake costs one day instead of the archive —
and the first night after this ships is not the night a bug deletes a year.

Three decisions inside it are worth the words.

**An unfinished parcel past the window is kept.** A parcel still moving at
thirty-one days is precisely the one that needs a human, and deleting it would
also stop its tracking, because the reconcile sweep reads `shipments`. But
keeping them quietly is only half an answer, so they get a tab, a badge on
every list they appear in, and a line in the daily digest. Keeping something
nobody is told about is just a slower way of losing it.

**The cutoff is a Madrid midnight, not `now - 30 × 86,400,000`.** Subtracting
milliseconds makes the edge of the window drift through the night, so a run at
03:15 and a run at 03:20 disagree about a parcel on the boundary — and on the
night the clocks change, by an hour.

**`closures` is never touched.** It is the one table meant to outlive its
parcel, which is also why it holds no customer details: a permanent record of
somebody's name, phone and address is a liability rather than an asset.

`RETENTION_DAYS` can move the window but never below fourteen days, because the
escalation ladder runs over a fifteen-day deposit window — a shorter retention
would delete parcels still being chased and the chasing would stop with no
trace. A number below the floor is clamped; something that is not a number
falls back to thirty. Those are different mistakes and get different answers,
which is worth saying because the first version did not: `13` clamped to 14
while `0` fell back to 30, and the "did it clamp" flag reported one of them as
fine.

### Closing a parcel needs a reason

"Stop chasing this one" wrote a timestamp and nothing else. A month later the
system could say how many parcels had been given up on and never why — a parcel
Correos lost and one the customer had all along were the same row — and once
the retention window existed, even that much would have gone after thirty days.

So the reason is required, and the second tap IS the reason. That keeps the
guard against a single click writing a parcel off without adding a step, and it
cannot be clicked through the way a confirm dialog can. "Other" will not submit
without a note, because "Other" with nothing written records that somebody
closed it and nothing else.

`droppedAt` stays the single answer to "is this closed", so everything written
before the three new columns keeps working untouched. Undo marks the closure
row undone rather than deleting it: that somebody wrote a parcel off and then
changed their mind is worth keeping, and every count excludes those rows.

### The dock is gone

The "Customer phone / Correos updates" panel on the right went, and the main
content took the full width — which the eight-column Parcels table needs. The
component files are kept rather than deleted: WhatsApp returns in Step 2, and
the parcel page still has its own Copy message and WhatsApp buttons, which is
where they belong anyway.

---

## 4. The ship date, the pull, and files that say which they are

### The window had to count from the ship date

`orders.created_at` is not the day a parcel went out, and after a thirty-day
pull it is not even close: every pulled order is written with today's date. A
retention window counted from that would keep a parcel posted five weeks ago
for another thirty days, and the first pull would hold two months at once
before settling down.

So `shipments.shipped_at` exists, with three sources in order of how much they
are worth: the Shopify fulfilment's own `created_at` or a marketplace file's
`ship-date`; then Correos' Prerregistrado event; then when we first saw the
row. The cleanup, the "Stuck 30+ days" tab and the date filter all read the
same `COALESCE(shipped_at, created_at)`, because a parcel in the tab that the
cleanup will not delete is the kind of inconsistency nobody reports and
everybody stops trusting.

The migration backfills with the same chain, and the pull overwrites those
fallbacks with the real fulfilment date as it goes — which is why the upsert
there is `onConflictDoUpdate` rather than `DoNothing`, and why it distinguishes
an insert from an update with `xmax = 0`: a parcel the pull merely re-dated is
not a new parcel and must not be announced.

`orders.placed_at` became nullable in the same migration. The marketplace files
genuinely have no order date, and the importer was writing the ship date into
it — so the two columns on the Parcels screen said the same thing while
claiming the order was placed the day it was posted. A null the screen shows as
"—" is the honest answer.

### Two Shopify bugs that cost orders silently

The hourly check asked for `limit: 100` and read the **first page only**. At a
thousand parcels a day, two days of orders is several hundred — so it was
looking at a fraction of them and reporting success. Shopify says nothing when
a page ends early; the page simply ends. It also filtered
`fulfillment_status=shipped`, which leaves out partially fulfilled orders whose
posted parcel is as real as any other.

Both are fixed by one paged reader that the hourly check and the new thirty-day
pull share, following the `Link` header to the end at 250 a page. The lesson
worth keeping: a loop that reads one page and stops is indistinguishable from a
loop that read everything, and neither logs anything.

### History arriving quietly

A pulled parcel is new to us and not new in the world. Left alone, the first
sweep would narrate its whole life — "nobody home, reminders started", "now at
the post office", "delivered, closed itself" — for something that finished a
fortnight ago, and then fire the four reminders that were due while nobody was
watching at a customer who may already have collected.

So `ingestEvent` takes a `quiet` flag and the sweep sets it for any parcel it
has never asked about before — `last_reconciled_at IS NULL` is exactly the
right signal, and it needed no new column. The events are written and the state
recomputed; nothing is said. Then `settleHistory` decides **once**: a parcel
already finished gets nothing at all, and one that still needs a person gets
what a new event of that state would give it today, followed by silencing every
message rung whose due time has gone by. The final warning stays armed, because
that one is still ahead of the customer.

One ticker line per pull, not one per parcel. The ticker holds twenty-four
hours, so a thousand lines of history would bury a whole day of real events —
which is a slower way of losing them.

### Working days, again, and a seam to watch

"Same status 3+ working days" uses the same two functions as pre-admission:
`workingDaysSince` for the per-row badge and `workingDayCutoff(at, 3)` for the
predicate the database runs. They must agree exactly, or a row appears in the
tab with no badge or carries a badge and is missing from the tab, so both tabs
have a test that walks a fortnight against four different "today"s and asserts
the two answers match.

Which states it applies to is the interesting decision. Not `created`, which
has its own two-day flag; not `at_office`, which has a deposit countdown that
is a better signal than silence; not `refused`, `returning` or `stale`, which
are already moving the right way or already flagged. Five states, where three
days of silence actually means late.

### Missed delivery is not the same as waiting at an office

A parcel the customer *chose* to collect from an office was never out for
delivery and nobody missed anything. One that got there after a failed attempt
is a different problem with a different conversation, so it is a different tab
— and the test for it checks both directions, because the distinction is the
whole value of the tab.

The discriminator is whether a `failed` or `out_for_delivery` event happened
**before** `office_arrived_at`. Out-for-delivery counts even with no failed
event, because Correos does not always send one; an attempt *after* it reached
the office does not, because that is a later story.

### Files that look identical and are not

Amazon and TikTok export the same eight columns. The `order-id` is the only
reliable difference — `404-0000000-0000001` against eighteen plain digits — and
the file name is never proof: one real file was
`Seguimiento_Amazon_07102026_015340.txt` and the other `tiktok shop.txt`.
Amazon's filled `order-item-id` and `quantity` agree with the order id, but a
TikTok export that populated them one day would then be read as Amazon, so they
are not used.

Three smaller calls:

**An `order-id` like `5.76962E+17` is refused, not repaired.** Excel rewrote a
long number in scientific notation when somebody opened and saved the file, and
the digits are gone. The row says so and names the fix — export it again and do
not open it in Excel — rather than importing a parcel nobody can place.

**A missing phone is not an error in these files.** They carry no customer
details at all, so judging the rows on a phone number would paint all eighty
red and make the preview worthless. The database stores an empty
`customer_name` rather than "Unknown customer", and the screens label it — the
useful side effect being that the Spanish greeting becomes "Hola," by itself
rather than by a check somebody has to remember to write.

**Correos Express is skipped by name**, before the looser "contains Correos"
test. It is a separate courier with its own tracking numbers, and one of its
parcels would sit here for ever while the sweep asked Correos about a code
Correos has never heard of.

### No default for the marketplace order URLs

`AMAZON_ORDER_URL` and `TIKTOK_ORDER_URL` are optional and empty. Seller-central
paths differ per marketplace, per region and per account, and a guessed URL
sends the operator to a 404 at the moment they are trying to stop a parcel
going back. Until one is pasted in, the button is "Copy order number", which
still works and takes one more paste.

---

## 5. The return date was a guess, so it is gone

### What the guess was, and what it reached

Correos holds a parcel at a post office for a while and then sends it back. The
system used to work out when: `arrival + depositDays`, where `depositDays` came
from a per-service number an operator nudged up and down on the Settings
screen. It started at 15, carried a checkbox reading **"Still a guess"**, and
nobody ever confirmed it with Correos — who do not publish it and do not send
it.

Everything downstream of that number was therefore an invention presented as a
fact: the big number on Today and the parcel page, the "goes back" column on
Parcels, the "Last day" column in the Missed-delivery worklist, the ordering of
the Post office list, the colour of every row, the countdown on the customer's
own `/e/{token}` page, and four customer messages that named the date outright
— *"Último día para recogerlo: 16 sep"*, *"el 16 sep tu pedido se devuelve
automáticamente"*.

On a service Correos hold for longer, that brought a customer in a week early
in a panic. On a shorter one it told them they had time they did not have.

### What replaced it

The one date Correos does give us: the moment the parcel reached the counter,
`H01I350V` / "A disposición del destinatario", stored as
`shipments.office_arrived_at`. Every screen now counts **forward** from it —
**"At the office since 23 Sep · 14 days"** — and goes red at eleven days, which
is the day of the fourth reminder, so the screen gets louder on the same day
the customer hears from us again.

And when the parcel actually goes back, Correos say so themselves:
`L03D320R`, phase `DEVOLUCION`. That event is what moves a parcel to *Coming
back* now, with their date on it, and it raises the alert that our own
arithmetic used to raise early or late.

`office_deadline` is still a column. Nothing computes it and nothing reads it;
`reproject` writes an explicit null. Dropping it would need a migration run in
the right order against a fork somebody has to click **Sync fork** on, which is
a real cost for no benefit — and `tests/no-invented-date.test.ts` is what stops
anybody filling it in again.

### The ladder kept its rung ids on purpose

The office reminders fire on the same days they always did — day of arrival,
+3, +7, +11, +13 — because 15 − 12 = 3 and 15 − 8 = 7: the old ids were days
*left* against the guess, and they are days *after arrival* now. Keeping
`o15`…`o2` means a parcel part way up the ladder when this changed does not
shift and does not get a reminder twice.

`o0` is gone rather than renamed. It fired when our arithmetic said the window
was up, raised an alert and opened a "confirm with Correos" task. Correos
announce the return themselves, so that rung was only ever a guess arriving
early or late.

### Office details: only what Correos gave

`officeDetails` used to fall back to a hard-coded `L–V 08:30–20:30 · S
09:30–13:00` whenever an office had no hours — and since today's events carry
no office details at all, that was every single message. Customers were being
given opening times nobody had checked. The sentence is now left out when there
are no real hours, and the Office column, the office line and the maps link are
hidden rather than showing "not said yet" beside a search for an empty string.

---

## 6. Taking off the screen everything that does not work yet

The operator has to be able to see how far the system really goes. A control
that does nothing in today's set-up makes that impossible — on 7 October the
Step 1 / Step 2 switch was flipped back and forth several times and nothing
changed.

Everything below is **hidden or relabelled, never deleted**. Each one comes
back on its own the moment the thing behind it exists.

| What | Was | Now | Comes back when |
| --- | --- | --- | --- |
| The top-bar switch | "Step 1 — just for us / Step 2 — we message customers" | gone | a WhatsApp provider is configured; `settings.phase` is still stored and still read |
| Connections → WhatsApp | "WhatsApp — Step 1 · **Connected**" | no row | `WHATSAPP_PROVIDER` is anything but `none` |
| Connections → Correos live push | "Correos live push · Not set up" | no row | `CORREOS_PUSH_CLIENT_ID` / `_SECRET` are set |
| `push-drain`, `push-heartbeat` | every 5 minutes / hourly, ~300 runs a day recording "push not configured" | off `vercel.json` and off the Scheduled jobs list | move them from `PAUSED_JOB_NAMES` back to `JOB_NAMES` and add two lines to `vercel.json` |
| Restock buttons | "Put back in stock" / "Put all back in stock" | "Mark as back in stock" | the Shopify token gains write scope; the record itself always worked |
| Redirection button | "Send to a new address", confirming with "Tap again — Correos charges" | "Mark new address as sent to Correos" | something can actually tell Correos a new address |
| Chase buttons | "Ask Correos about this one", "Fix address with Correos", "Book another delivery" | "Mark as asked Correos", "Mark address as fixed with Correos", "Mark new delivery as booked" | same |
| Connections → Email | *nothing at all* | a row saying **Not set up**, with "alerts and the daily digest only go to the logs" | `SMTP_HOST` and `MAIL_TO` are set |

The Email row is an addition rather than a removal, and it is the same kind of
problem the rest of this list is: `sendInternalAlert` logs to stdout and returns
`logged` when no SMTP host is configured, `logged` counts as delivered on
purpose — a daily job that threw for want of a mail server would fail every day
on every dev machine — and so an alert nobody will ever read was stored as
sent, with nothing on any screen saying whether a single email had ever left.

The demo clock controls were already hidden behind `DEMO_MODE`, and are left
alone.

---

## 6b. A `'use server'` file can only export async functions

The Refresh button shipped broken, and the way it broke is worth keeping.

`app/actions/refresh.ts` carries `'use server'` and exported one constant:

```ts
export const MANUAL_SWEEP_GAP_MS = 5 * MINUTE;
```

Next refuses to load such a module at all:

```
Error: A "use server" file can only export async functions, found number.
```

Not that one export — **the whole module**. So all three actions in the file
went down with it: the Refresh button, the Correos check after an upload, and
the Correos check after a thirty-day pull. Each answered 500 with
"Application error: a server-side exception has occurred", which is also why
the eighty-one uploaded TikTok parcels were still sitting in *Pre-admission*.

Three things about it are worth writing down, because each one is the reason it
got past everything:

- **`npm run build` passes.** Verified by putting the bad export back and
  building: `✓ Compiled successfully`. The rule is applied when the module is
  first *loaded*, which is when somebody presses the button in production.
- **Every page still renders.** `GET /office` is 200; only the action POST is
  500. So a smoke test that loads the screens sees nothing wrong — and that is
  exactly what the previous round's verification did.
- **The unit tests import the actions directly.** Vitest loads them as ordinary
  ES modules, where the rule does not exist. Every test passed.

So `tests/use-server-exports.test.ts` **reads** the files instead of importing
them: it finds every file whose first statement is the directive and fails on
any export that is not an async function — `export const`, `let`, `class`,
`enum`, a plain `function`, a default, or a re-exported value. `export type`
and `export interface` are allowed, because they vanish at compile time and
every action file has them. The test also checks itself against a synthetic
file that exports a number, so a broken sweep cannot pass by finding nothing.

The rule to keep: **a `'use server'` file holds async functions and types, and
nothing else.** Constants and pure helpers go in `lib/` — which is where
`MANUAL_SWEEP_GAP_MS`, the budget and the lease now live, as `lib/refresh.ts`,
along with `sweepResultLine`, which is better off unit-testable anyway.

And the verification for this round was done by invoking the three actions over
HTTP against a built server with a stub standing in for Correos, not by loading
the pages. That is the only check that would have caught it.

---

## 7. Where I departed from the prototype

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

## 8. Things I chose, where the brief left it open

| | Chose | Why |
|---|---|---|
| ORM | Drizzle | The projection is the important code and it is plain SQL-shaped; Drizzle stays out of the way. |
| Jobs | pg-boss | Schedule lives in Postgres, so it survives restarts and does not run N times on N instances. |
| Money | integer cents | Every sum and every "most money at risk" ordering happens in SQL, and floats lose cents. |
| Passwords | scrypt, from `node:crypto` | No native build, no dependency that can be taken over. Parameters are stored in the hash, so raising them later locks nobody out. |
| Sessions | random id in the cookie, its hash in the table | A leaked database backup is not a set of live sessions. |
| Import route | server action, not `api/import/tiktok` | The brief allows either. A server action gets the file straight into a typed function with the session already resolved. |

---

## 9. Still open

- **`CRON_SECRET` must be set in production.** Every cron route refuses every
  request without it. That is deliberate — an open endpoint that sweeps the
  shipment table and emails the team is worse than a job that never runs — but
  it does mean a deployment that forgets it has a dashboard and no engine.
  **This is now visible**: no successful run in 45 minutes puts an undismissable
  banner on every panel screen, and Settings → Connections shows when each job
  was last heard from. What is still open is that nobody is *told* — there is no
  push, no SMS, nothing that reaches somebody who is not looking at the screen.
  If the business depends on this, that is the next thing to add.
- **~~The deposit window~~ — settled: there isn't one.** It was a guess and it
  is gone; see section 5. Nothing in the system claims to know when a parcel
  goes back, and Correos tell us when they send one.
- **Correos event codes.** `BY_CODE` in `state-map.ts` holds the eight
  confirmed against real traffic. Guessing a numeric code is worse than falling
  back to the wording, because a wrong code maps silently while a missing one
  asks a human — so one is only added once a stored payload has been seen
  carrying it. That loop worked: "Intento de entrega. Ausente" was mapped by
  wording alone, `remapKnownEvents` wrote its real code onto the review-queue
  row it resolved, and `H01R420V` came back off the Settings screen.
- **Ten codes waiting on Correos.** `H01R424V` "Realizado intento de entrega",
  `H06P010V`/`H06P050V` "En proceso de entrega", `G01L010V` "Alta en la unidad
  de reparto", `M010090R`/`M01E020R` "Envío a estacionar", `M01E320R`
  "Estacionado", `M02E340V`/`M02E360V` "Desestacionado" and `R010751V` "Entrega
  modificada". Two are near-misses worth care: "Realizado intento de entrega"
  says an attempt was made and *not* whether it succeeded, so reading it as a
  failure would start the post-failure ladder on delivered parcels; and "Alta
  en la unidad de reparto" differs by one word from `'alta en unidad de
  reparto'`, which *is* mapped, from Correos' public tracker rather than from
  their feed. `tests/wordings.test.ts` holds both apart on purpose.
- **Office opening hours.** Correos' events carry no office details at all —
  `location` is empty in every sample — so there are no hours for any office,
  and the messages and screens now leave the office out rather than filling the
  gap. `offices.opening_hours` is waiting for an API that exposes them.

- **Which store a TikTok upload belongs to.** Every upload goes to one
  `tiktok-es` store. If you run more than one TikTok shop, the import screen
  needs a picker.
- **The `product_code` for Shopify fulfilments** is parsed out of
  `tracking_company` (`"Correos PAQ 48"` → `PAQ 48`). If your stores do not put
  the service in that field, this needs to come from somewhere else — and it
  matters, because it picks the deposit window.

---

## 10. What I would do next

1. **Point it at the Correos mock.** `CORREOS_TRACKPUB_BASE_URL` already
   exists; the push receiver can be pointed at from their Postman collection.
   Everything else is ready.
2. **Watch the review queue for a fortnight.** Every unmapped code Correos
   sends lands on the Settings screen. After two weeks you will know what the
   real mapping table looks like, and `reprojectAll()` will apply it to
   everything historic.
3. **Connect a WhatsApp provider.** The adapter is written and the templates
   are the same ones already going out by copy-paste, so it is an environment
   variable and a WhatsApp template approval — not a code change. Setting
   `WHATSAPP_PROVIDER` is also what brings the top-bar switch and the
   Connections row back.
4. **Connect SMTP**, so a parcel coming back reaches somebody who is not
   looking at the screen. Until then every alert is a line in the logs that the
   database records as sent.
