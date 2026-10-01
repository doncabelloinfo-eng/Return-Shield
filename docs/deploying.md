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
| `DATABASE_URL` | Postgres connection string. On Supabase this is the **transaction pooler, port 6543** — see [Two Supabase URLs](#two-supabase-urls) below, because migrations need the other one. |
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

### Two Supabase URLs

Supabase offers two poolers and this app needs both, for different things.

| | Port | Used by | Why |
|---|---|---|---|
| **Transaction pooler** | 6543 | the app (`DATABASE_URL`) | Multiplexes many short-lived serverless instances onto few backends, which is exactly the shape of this workload. It does not support prepared statements, so `db/connection.ts` sets `prepare: false` everywhere. |
| **Session pooler** | 5432 | migrations (`MIGRATE_DATABASE_URL`) | A migration takes an advisory lock and runs DDL, and both need a session that stays on one backend. Through the transaction pooler the lock would be taken on one connection and the DDL run on another. |

Both want `?sslmode=require`. TLS is on by default for any host that is not
local anyway: `connectionShape()` honours an explicit `?sslmode=` if you give
one, skips TLS for localhost and for any database whose name ends in `_test`,
and otherwise requires it.

If you are on a single plain Postgres rather than Supabase, one URL does both
jobs and there is nothing to choose.

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
| `CORREOS_OAUTH_SCOPE` | Optional. Defaults to `AP3 LBS RCG`. |
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
the step it broke rather than to a `job_runs` row three hours later.

### Shopify — per store, optional

For a store whose `stores.key` is `main-store`:

| Variable | What breaks without it |
|---|---|
| `SHOPIFY_MAIN_STORE_WEBHOOK_SECRET` | Its webhooks are rejected — an unverified webhook writes to the order table, so rejecting is the safe default. |
| `SHOPIFY_MAIN_STORE_ACCESS_TOKEN` | The hourly backfill skips that store, so a lost webhook is never recovered. |
| `SHOPIFY_MAIN_STORE_SHOP_DOMAIN` | Optional if `stores.shop_domain` is set in the database. |

The key is uppercased with non-alphanumerics turned into underscores.

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
| `MIGRATE_DATABASE_URL` | Supabase's **session pooler** URL, port 5432. Not the transaction pooler the app uses — a migration needs a session that stays on one backend. |

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

1. Create the Postgres database. Copy **both** URLs if it is Supabase: the
   transaction pooler (6543) for the app, the session pooler (5432) for
   migrations.
2. Set the four required variables in Vercel. `DATABASE_URL` is the transaction
   pooler one, and **you generate `CRON_SECRET` yourself** — Vercel does not.
3. Add `MIGRATE_DATABASE_URL` as a GitHub Actions secret (the session pooler
   URL), plus `SEED_EMAIL`, `SEED_PASSWORD` and `SEED_NAME`.
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
   Correos connection**. Then add Shopify's, and watch the Connections panel
   turn over.

Each later migration is step 4 again, without `seed`: run the workflow first,
then deploy. The migration is written so the old code still works against the
new schema, which is what makes that order safe.
