# Deploying to Vercel

## Before the first deploy

The build must not need a database. Check it locally, with the variable
deliberately empty:

```bash
DATABASE_URL= npm run build
```

If that fails, something is constructing a database client at module scope
again. Next.js evaluates every route module during **Collecting page data**, so
anything built at import time runs during the build — which would mean every
build, every preview deployment and every CI run needs a live production
database. Everything goes through `getDb()` in `db/index.ts`, which builds the
client on first call and reads `DATABASE_URL` then, not at import.

## Environment variables

Set these in **Project → Settings → Environment Variables**.

### Required — the app will not serve a page without these

| Variable | What it is |
|---|---|
| `DATABASE_URL` | Postgres connection string. On Supabase use the **session pooler, port 5432** — see [The database port](#the-database-port) below, which is not the obvious choice and has a reason. |
| `SESSION_SECRET` | 32+ random bytes. Signs login sessions and the public `/e/{token}` links. `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `CRON_SECRET` | **You set this by hand. Vercel does not generate it.** Any long random string: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`. Vercel then sends it as `Authorization: Bearer $CRON_SECRET` on every cron invocation. Without it **every cron route refuses every request**, which is deliberate — and the panel shows a banner, because a dashboard with no engine behind it looks perfectly healthy. |
| `APP_URL` | The public URL, e.g. `https://shield.example.com`. It goes into the links inside customer messages, so `localhost` here means a dead link on somebody's phone. |

**With only those four set, the app boots and every screen renders.** No
Correos, no Shopify, no WhatsApp needed. The Settings screen shows what is not
connected and what that costs, and the jobs that need a missing integration
report that they skipped rather than failing.

**Do not try to set `TZ`.** It is a reserved variable on Vercel and cannot be
set there; production runs in UTC. Nothing depends on it — `lib/time.ts` does
its own Europe/Madrid arithmetic with `Intl`, and the test suite pins `TZ=UTC`
so it exercises the same configuration production does. Set it locally if you
like; it only makes your own logs easier to read.

### The database port

**Use the session pooler, port 5432, for both `DATABASE_URL` and
`MIGRATE_DATABASE_URL`.** Supabase offers two poolers; this app currently uses
one of them for everything.

| | Port | Status |
|---|---|---|
| **Session pooler** | 5432 | **What to use.** Each client gets its own backend for the life of the connection. |
| **Transaction pooler** | 6543 | **Do not use for the app.** Right on paper for serverless, broke production in minutes. Never valid for migrations. |

Both want `?sslmode=require`. TLS is on by default for any host that is not
local anyway: `connectionShape()` honours an explicit `?sslmode=` if you give
one, skips TLS for localhost and for any database whose name ends in `_test`,
and otherwise requires it.

If you are on a single plain Postgres rather than Supabase, one URL does both
jobs and there is nothing to choose.

#### Why not the transaction pooler

It was tried in production on 6 October and failed three ways within minutes:

1. **Hangs.** `/today` ran to the 300-second function limit and returned 504,
   repeatedly.

2. **Crossed parameters.** This query

   ```sql
   select "shipment_id", "at", "outcome", "note" from "contact_log"
    where "contact_log"."shipment_id" in ($1, $2, $3)
   ```

   was executed with `['PAQ ESTÁNDAR', 'PAQ 48', 'PAQ PREMIUM']` — the
   parameters of a different, concurrent query. It failed with `22P02 invalid
   input syntax for type uuid`, and the error named `unnamed portal parameter
   $1`. The stack trace ran through `Promise.all`.

3. **Lock timeout.** push-drain's `INSERT INTO job_locks … ON CONFLICT` failed
   with `57014 canceling statement due to statement timeout`.

The likely cause is that postgres.js pipelines concurrent queries down one
connection, and Supavisor's transaction mode can route those statements to
different backends, so one query's `Bind` lands on another's unnamed portal.
**`prepare: false` does not prevent this** — the problem is the unnamed portals
and the pipelining, not named prepared statements, and `prepare: false` was
already set when this happened.

Take the second one seriously even though it threw. It is a **correctness**
failure, and it threw only because a uuid column happened to reject a product
code. Two concurrent queries whose parameters are type-compatible — two uuid
lookups, say — would have crossed silently and shown one parcel's contact log
under another parcel's name, with nothing in any log.

On 5432 the same pages and the same jobs work.

#### What session mode costs

Session mode holds a backend per client connection, so the ceiling is the
project's **pool size: 15** on this project, rather than the few hundred the
transaction pooler would allow.

With `DB_POOL_MAX=3` (the default on Vercel) and `idle_timeout: 20`, that is
about **five instances holding connections at once**, and each keeps holding
them for up to 20 seconds after it goes quiet. The sixth concurrent instance
waits on `connect_timeout` and then fails.

If that starts happening, raise the pool size in **Supabase → Database →
Settings**. Do not raise `DB_POOL_MAX` against an unchanged ceiling — that
reaches the same limit with fewer instances.

#### If you want to fix it properly

The work is to stop pipelining concurrent queries down one connection. The
likely shapes are a driver that serialises per connection (`node-postgres`
rather than `postgres.js`), or wrapping each query in its own transaction so
Supavisor pins a backend for it.

Neither is in here, because neither can be verified from a dev machine or a
cloud session: reproducing crossed parameters needs a real Supavisor in
transaction mode, and a driver swap touches every query in the app. If you
take it on, do it in its own commit with a test that reproduces the crossing
first.

### How much history is kept

The database is on Supabase's free plan: **500 MB**, and until this shipped
nothing deleted anything. One `shipment_events` row carries about 550 bytes of
raw Correos payload, so a thousand parcels a day is roughly a gigabyte a year —
the only question was when it would stop, not whether.

So the system holds a **rolling 30 days**, counted from the **ship date** —
the day the parcel was handed to Correos, not the day its row was written.
That distinction matters the moment history is pulled in: a thirty-day Shopify
pull writes every order with today's date, so a window counted from the row
would keep a parcel posted five weeks ago for another thirty days, and the
first pull would hold two months at once.

Every night `housekeeping` deletes the day that has just become the
thirty-first day back: orders whose shipments have all finished and whose
newest ship date is past the cutoff, and with them (by `ON DELETE CASCADE`)
their events, tasks, messages and contact log. Also trimmed to the same window: activity lines,
resolved review-queue rows, processed push payloads, delivered alerts, import
batches and job runs.

Never a sweep that wipes everything older than X all at once. The job is
identical on its first night and its thousandth, which means a mistake costs
one day rather than the archive.

**An unfinished parcel past the window is kept until it finishes.** A parcel
still moving at thirty-one days is exactly the one that needs a human, and
deleting it would also stop its tracking — the reconcile sweep reads
`shipments`, so a deleted parcel is one nobody is asking Correos about. They
get their own tab (Parcels → **Stuck 30+ days**), a red badge wherever they
appear, and a line in the daily digest.

**Never deleted at all:** users, shops, settings, deposit windows, post
offices, postcode stats, and `closures` — the permanent record of every parcel
written off by hand, which is the one table meant to outlive its parcel.

Settings shows the database size against the 500 MB ceiling and turns the bar
red above 400 MB.

### Correos — optional, and the app runs without them

| Variable | What breaks without it |
|---|---|
| `CORREOS_PUSH_CLIENT_ID` | The receiver refuses every request, so no tracking arrives on its own. |
| `CORREOS_PUSH_CLIENT_SECRET` | As above. |
| `CORREOS_PUSH_ALLOWED_IPS` | Optional. Comma-separated. Without it the client id and secret are the only control on a public endpoint that writes to the shipment table. Set it once Correos tell you the address they call from. |
| `CORREOS_CLIENT_ID` | The reconcile sweep does nothing. The **gateway** credential, from the developer-portal app. Sent as a `client_id` header. |
| `CORREOS_CLIENT_SECRET` | As above, the matching header. |
| `CORREOS_OAUTH_CLIENT_ID` | No token can be minted, so every lookup is unauthorised. The **CorreosID system-user application** credential — a different app in a different place from the two above. |
| `CORREOS_OAUTH_CLIENT_SECRET` | As above. |
| `CORREOS_OAUTH_SCOPE` | Optional, and defaults to the right thing (`TPB`). See below before changing it. |
| `CORREOS_TOKEN_URL` | Optional. Defaults to production. Pre-production is `apioauthcid.correospre.es`. |
| `CORREOS_TRACKPUB_BASE_URL` | Optional. Point at `api1.correospre.es` or a mock to test without live credentials. |
| `CORREOS_JWT` | **Optional, for testing only.** A token pasted in by hand. It bypasses the token endpoint and is used as-is until it expires, which it does in about thirty minutes — so it is not something to configure in production, and Settings reports an integration running on one as *partial* rather than ready. |

**All four of the first ones.** Trackpub needs the gateway pair *and* the OAuth
pair, from two different Correos systems, and it is easy to mix them up. Three
out of four is not a working integration, so Settings reports trackpub as ready
only when all four are set — otherwise the sweep would quietly do nothing while
the screen said everything was fine.

Once they are set, press **Test Correos connection** on Settings → Connections.
It mints a token (telling you how many minutes it lasts, never what it is) and
then looks up a tracking code you type in, so a wrong value is attributable to
the step it broke rather than to a `job_runs` row three hours later. On any
non-2xx answer it shows Correos' own status and body, which is the only thing
that reliably says what is wrong.

### The OAuth scope is `TPB`

`TPB` is trackpub's application code in CorreosID. Correos support confirmed
it, and a working production token carries `aud=TPB`, `iss=CID` and
`oid=<CorreosID client id>`, lasting thirty minutes.

This is worth a paragraph because of how it fails. The two open-source Correos
SDKs send `scope=AP3 LBS RCG`, which is what this app shipped with. CorreosID
issues a token for that scope without complaint; trackpub then rejects every
call with `401 {"error": "Invalid token."}`. Nothing in the failure mentions a
scope, and the obvious reading — bad credentials — is wrong. It cost a day.

| What you get | What it means |
|---|---|
| `401 {"error": "Invalid token."}` | The token is real but minted for the wrong scope. Check `CORREOS_OAUTH_SCOPE` first, the OAuth credentials second. |
| `400 {"error": "JWT Token is required."}` | No bearer token reached them at all. |
| `403` | The token is fine and the gateway is not: check `CORREOS_CLIENT_ID` / `_SECRET` and that the portal app's trackpub contract is approved. |

### Empty is unset

Every variable this app reads treats an empty or whitespace-only value as not
configured, and credentials are trimmed before use. `process.env.X ?? default`
does not do that — `??` only fires on `undefined`, and a key added through the
Vercel UI with the value left blank is the empty string.

That is not hypothetical either: `CORREOS_TRACKPUB_BASE_URL` was added with no
value, the base URL became `''`, every lookup fetched the bare path as a
relative URL, and production answered `Failed to parse URL from /search/PK…`.
So it is safe to add a key and leave it blank — you get the default. See
`lib/env.ts`.

### Adding a Shopify store

**There is no screen for this.** A store is four steps: a database row, a
webhook, an Admin API token, and a redeploy. Nothing here is a code change —
the first store, Don Cabello Profesional, was added without touching the
repository.

Each store has a **key**: a short slug that appears in the webhook URL and in
the variable names. `doncabello` is the live one. The variable suffix is the key
uppercased with every non-alphanumeric character turned into an underscore, so
`doncabello` → `SHOPIFY_DONCABELLO_*` and `don-cabello` → `SHOPIFY_DON_CABELLO_*`.
Pick a key with no punctuation and the two always match.

| Variable | What breaks without it |
|---|---|
| `SHOPIFY_<KEY>_WEBHOOK_SECRET` | Its webhooks are rejected. An unverified webhook writes to the order table, so rejecting is the safe default. |
| `SHOPIFY_<KEY>_ACCESS_TOKEN` | The hourly backfill skips that store, so a lost webhook is never recovered. |
| `SHOPIFY_<KEY>_SHOP_DOMAIN` | Optional if `stores.shop_domain` is set on the row below. |

#### 1. The store row

In the Supabase SQL editor:

```sql
insert into stores (key, name, platform, ingest, shop_domain)
values ('<key>', '<name>', 'shopify', 'auto', '<x>.myshopify.com')
on conflict (key) do update
  set name = excluded.name,
      shop_domain = excluded.shop_domain,
      active = true;
```

Re-runnable, so it is also how you rename a store or point it at a new domain.

#### 2. The webhook

In the **Shopify admin** of that store: **Settings → Notifications →
Webhooks**.

| Field | Value |
|---|---|
| Event | **Order fulfillment** |
| Format | JSON |
| API version | `2026-10` |
| URL | `https://<your-app>/api/webhooks/shopify/<key>` |

Admin-made webhooks are signed with **that store's own signing key**, shown on
the webhooks page once the webhook is created — not with any app's secret. It
goes in `SHOPIFY_<KEY>_WEBHOOK_SECRET`.

#### 3. The Admin API token

This is the fiddly one, and it is per store.

**Make the app.** A custom app in the agency's Shopify Dev Dashboard. One app
per store, because custom distribution reaches a single store.

- Scope: `read_orders`. Nothing else is needed.
- App URL: the app's own URL. Embedding off.
- Allowed redirect URL: `http://localhost:3456/callback`.

**Install it.** Set the app's distribution to **custom**, nominate the store,
then install from the link Shopify generates.

**Get the token.** One authorization-code exchange, which the operator runs
from a small local helper (a few lines of PowerShell: open the authorize URL,
catch the `code` on `localhost:3456`, POST it to the store's
`/admin/oauth/access_token`). The offline token that comes back goes in
`SHOPIFY_<KEY>_ACCESS_TOKEN`.

Two things worth knowing, both learnt the hard way:

- **Custom apps are exempt from Shopify's expiring offline tokens**, so this
  token does not need rotating.
- **The client credentials grant does not work here.** It only reaches stores
  inside the app's own organization, and client stores are collaborator stores
  in organizations of their own.

#### 4. Redeploy and test

Add the variables in Vercel, redeploy, then use **Send test notification** from
the webhook's own menu in the Shopify admin. It should answer **200**. The
hourly `shopify-backfill` picks the store up on its own from the row in step 1.

#### Pulling history: "Pull the last 30 days"

**Settings → Shopify** has a button per shop. It reads every page of the last
thirty days and adds any Correos parcel that is missing, and it is how a newly
connected shop gets any history at all.

It runs in two steps and shows both: the pull creates the parcels, then a
second request asks Correos about them. Two requests because both are bounded
by the same 300-second function limit — a sweep inside the pull would get
whatever seconds the pull left over, which on a thousand parcels is none. And
without that second step the parcels sit in Pre-admission until the next
scheduled sweep, up to three hours later, which for one already waiting at a
post office is three hours of a countdown nobody can see.

Safe to press twice: shipping codes are unique, so a second press reports
everything as already there. It never asks for anything older than the
retention window, because the nightly cleanup would delete it the same night.

History arrives **quietly**. A parcel pulled from three weeks back may have
been delivered a fortnight ago, so the first sweep writes its events and says
nothing: no ticker line per order, no task for a parcel that is already
finished, and none of the reminders that were due while nobody was watching.
A parcel that still needs a person gets what a new event of that state would
give it today, once. One ticker line per pull, not one per parcel.

#### TikTok orders are deliberately skipped

Orders that Shopify syncs in from TikTok carry `PKA6TP…` tracking codes with no
carrier name, so `isCorreos` in `lib/carriers/shopify/ingest.ts` does not
recognise them and the webhook, the hourly check and the thirty-day pull all
ignore them. **That is intended** — TikTok orders come in through the Upload
orders screen, and making `isCorreos` accept a bare `PKA6TP…` would ingest them
twice.

#### Uploading TikTok and Amazon files

**Upload orders** takes the shipping-confirmation export ("Seguimiento") as it
comes: `.txt`, `.csv`, `.tsv` or `.xlsx`. Amazon and TikTok export the *same
eight columns*, so which marketplace each row belongs to is worked out from the
order id — `404-0000000-0000001` is Amazon, eighteen plain digits is TikTok —
and never from the file name, which people rename. A file may hold both; each
row goes to its own shop, and the `amazon-es` shop is created the first time an
Amazon order turns up, the way `tiktok-es` always was.

These files carry **no customer details at all**, so a missing phone is not an
error in one. Contact for those parcels goes through the marketplace's own chat;
see `AMAZON_ORDER_URL` and `TIKTOK_ORDER_URL` above.

Two rows are refused rather than guessed: an order id in neither shape, and one
Excel has rewritten as `5.76962E+17` — that is a file somebody opened and saved
in Excel, and the digits are gone for good. Carriers other than Correos are
skipped, Correos Express included: it is a different company with its own
tracking.

#### Old variables to delete

`SHOPIFY_MAINSTORE_WEBHOOK_SECRET`, `SHOPIFY_MAINSTORE_ACCESS_TOKEN` and
`SHOPIFY_MAINSTORE_SHOP_DOMAIN` were placeholders from the first deploy. There
is no `mainstore` row in `stores`, so they belong to nothing and can be removed
from the Vercel project.

### WhatsApp — Step 2 only

| Variable | Notes |
|---|---|
| `WHATSAPP_PROVIDER` | `none` (default) is Step 1: messages are written for an operator to send. `whatsapp-cloud` sends them. |
| `WHATSAPP_API_URL`, `WHATSAPP_API_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID` | Needed by `whatsapp-cloud`. If the provider is set but these are not, it falls back to Step 1 with a warning rather than taking the escalation engine down. |

### Email — optional

`SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM`, `MAIL_TO`.
Without `SMTP_HOST` the daily digest and the internal alerts are logged instead
of sent — visible in the Vercel function logs, but nobody's inbox.

### Never in production

| Variable | |
|---|---|
| `DEMO_MODE` | `1` seeds sample parcels and puts the clock controls in the top bar. `lib/clock.ts` refuses to be moved unless this is set, which is the point — a running business must not be able to fast-forward fifteen days of reminders at real customers. **Leave it unset.** |

### Tuning — all optional

| Variable | Default |
|---|---|
| `DB_POOL_MAX` | 3 on Vercel, 10 elsewhere. Many short-lived instances against one database; a generous pool per instance is how Postgres runs out of connections at 9am. |
| `AMAZON_ORDER_URL` | Optional, **no default**. A template with `{id}` in it, e.g. `https://sellercentral.amazon.es/orders-v3/order/{id}`. Turns the "Open in Amazon" button on Parcels → Missed delivery into a link; until it is set that button is "Copy order number" instead. Not guessed, because seller-central paths differ per region and account and a wrong one is a 404 at the worst moment. |
| `TIKTOK_ORDER_URL` | The same for TikTok Shop, e.g. `https://seller-es.tiktok.com/order/detail?order_no={id}`. |
| `RETENTION_DAYS` | 30. How many days of history the system keeps; the nightly job deletes the day that has just fallen off the end. **Never goes below 14** whatever you set — the escalation ladder runs over a fifteen-day deposit window, so a shorter retention would delete parcels still being chased. A value below the floor is clamped and the job detail says so; a value that is not a number falls back to 30. |
| `SHOPIFY_API_VERSION` | `2026-10`, from `lib/carriers/shopify/api.ts`. A version Shopify has retired does not fail — it silently serves the oldest one still supported, so this is worth reviewing each year. Set it only to pin an older version on purpose. |
| `RECONCILE_BATCH_SIZE` | 6000. How many parcels one sweep may consider. At ~5,000 live parcels this is "all of them". |
| `RECONCILE_BUDGET_MS` | 240000. The sweep stops asking Correos anything new after this, which is 60 seconds inside the route's `maxDuration` of 300. |

---

## Migrations

**Migrations do not run in the build.** A failed migration must not be able to
take the site down on an unrelated deploy, and a build that migrates will try
to do so once per deployment including previews — against whatever database it
was handed.

### Through GitHub Actions

**Actions → Database migrate → Run workflow.** Manual only; there is no trigger
on push.

It needs one secret, under **Settings → Secrets and variables → Actions**:

| Secret | What |
|---|---|
| `MIGRATE_DATABASE_URL` | Supabase's **session pooler** URL, port 5432 — the same URL as `DATABASE_URL`. A migration needs a session that stays on one backend, so this is never the transaction pooler whatever the app is using. |

The workflow has an optional `seed` input, default off. With it on it also runs
`npm run db:seed`, which needs three more secrets and fails before touching the
database if any of them is missing:

| Secret | What |
|---|---|
| `SEED_EMAIL` | The first user's address. |
| `SEED_PASSWORD` | Their password, 12 characters or more. There is deliberately **no default** — a seeded instance must not be reachable with a password that is written down in this repository. |
| `SEED_NAME` | Their display name. |

`db:seed` is safe to re-run. If the user already exists its password is left
alone, and product rules are keyed by product code so they are neither
duplicated nor reset over a deposit window somebody has since edited on the
Settings screen.

**This repository is public, so these logs are public.** Nothing in the
workflow prints a password, a connection string or an email address, and
`scripts/create-user.ts` is deliberately not used in it — it prints a generated
password to stdout, which is correct at a terminal and wrong in a public log.
`db/migrate.ts` prints only the shape of the connection it made, never the URL,
and on failure prints `err.message` rather than the error object, because a
postgres.js connection error carries the full options including the password.

### Or by hand, from a machine that can reach Postgres

```bash
DATABASE_URL="postgres://…:5432/postgres?sslmode=require" npm run db:migrate
```

Note the port: the **session** pooler, for the reason in the table above.

The order that keeps a deploy safe:

1. Write the migration so the **old code still works against the new schema** —
   add columns, do not rename or drop them in the same release.
2. Run `npm run db:migrate` against production.
3. Deploy.
4. Only in a later release, once nothing is running against the old schema,
   remove what is now unused.

`npm run db:migrate` is idempotent: drizzle records what it has applied and
skips it. Running it twice does nothing the second time.

To see what a change would produce before committing it:

```bash
npm run db:generate      # writes db/migrations/NNNN_*.sql — read it, then commit it
```

---

## Cron

`vercel.json` holds the schedule; each job is a route under `app/api/cron/`.
See [cron.md](cron.md) for the table, the UTC/Madrid handling, the per-job
lock and how the reconcile sweep resumes.

Every cron route requires `Authorization: Bearer $CRON_SECRET` and returns 401
without it. Vercel sends that header automatically. To run one by hand:

```bash
curl -H "Authorization: Bearer $CRON_SECRET" https://your-app.vercel.app/api/cron/reconcile
```

### The Correos receiver is still worth thinking about

`/api/webhooks/correos/track` returns 200 and stages the payload, so a cold
start costs latency rather than the event — the design already survives
serverless better than most.

What serverless does not give you is IP filtering below Enterprise. On Pro, the
`clientID` / `clientSecret` pair is the only control on that endpoint. It is a
real control — the endpoint only ever writes a row to a staging table, and
`push-drain` ignores anything whose tracking code we do not recognise — but
keep the credentials long and rotate them.

If Correos insist on an allowlist, put that one route on a small always-on host
and leave everything else here. It has no dependency on any other route.

---

## First deploy, in order

1. Create the Postgres database and copy the **session pooler** URL, port
   5432. On Supabase that one URL is used for both the app and the migrations
   — see [The database port](#the-database-port) for why not 6543.
2. Set the four required variables in Vercel. **You generate `CRON_SECRET`
   yourself** — Vercel does not.
3. Add `MIGRATE_DATABASE_URL` as a GitHub Actions secret (the same session
   pooler URL), plus `SEED_EMAIL`, `SEED_PASSWORD` and `SEED_NAME`.
4. Run **Actions → Database migrate** with `seed` ticked. The migrations build
   the schema; **the seed is what inserts `product_rules`**, and without it
   every parcel has no deposit window and no office deadline, because the
   deadline is `office arrival + product_rules.deposit_days` and there is
   nothing to read the days from. The seed also creates the first user, so
   there is somebody to log in as.
5. Deploy.
6. Sign in. The Settings screen will say nothing is connected, and the deposit
   windows from step 4 will be there to check. That is correct.
7. Add the Correos credentials as they arrive — all four — and press **Test
   Correos connection**. Then add each Shopify store by the procedure in
   [Adding a Shopify store](#adding-a-shopify-store), and watch the Connections
   panel turn over.

Each later migration is step 4 again, without `seed`: run the workflow first,
then deploy. The migration is written so the old code still works against the
new schema, which is what makes that order safe.
