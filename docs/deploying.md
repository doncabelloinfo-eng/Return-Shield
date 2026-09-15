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
| `DATABASE_URL` | Postgres connection string. Vercel Postgres, Neon, Supabase — anything that speaks Postgres. |
| `SESSION_SECRET` | 32+ random bytes. Signs login sessions and the public `/e/{token}` links. `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `CRON_SECRET` | Vercel generates this. Without it **every cron route refuses every request**, which is deliberate. |
| `APP_URL` | The public URL, e.g. `https://shield.example.com`. It goes into the links inside customer messages, so `localhost` here means a dead link on somebody's phone. |

**With only those four set, the app boots and every screen renders.** No
Correos, no Shopify, no WhatsApp needed. The Settings screen shows what is not
connected and what that costs, and the jobs that need a missing integration
report that they skipped rather than failing.

Also set `TZ=Europe/Madrid`. The app does its own Madrid-time arithmetic and
does not depend on this, but logs are far easier to read when the runtime
agrees.

### Correos — optional, and the app runs without them

| Variable | What breaks without it |
|---|---|
| `CORREOS_PUSH_CLIENT_ID` | The receiver refuses every request, so no tracking arrives on its own. |
| `CORREOS_PUSH_CLIENT_SECRET` | As above. |
| `CORREOS_PUSH_ALLOWED_IPS` | Optional. Comma-separated. Without it the client id and secret are the only control on a public endpoint that writes to the shipment table. Set it once Correos tell you the address they call from. |
| `CORREOS_CLIENT_ID` | The reconcile sweep does nothing. |
| `CORREOS_CLIENT_SECRET` | As above. |
| `CORREOS_JWT` | As above. |
| `CORREOS_TRACKPUB_BASE_URL` | Optional. Point at `mocks.correospre.es` to test without live credentials. |

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
| `RECONCILE_BATCH_SIZE` | 200 |
| `RECONCILE_BUDGET_MS` | 45000 |

---

## Migrations

**Migrations do not run in the build.** A failed migration must not be able to
take the site down on an unrelated deploy, and a build that migrates will try
to do so once per deployment including previews — against whatever database it
was handed.

Run them deliberately, from a machine with the production `DATABASE_URL`:

```bash
DATABASE_URL="postgres://…" npm run db:migrate
```

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
See [cron.md](cron.md) for the table, the UTC/Madrid handling and how the
reconcile sweep resumes.

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

1. Create the Postgres database and copy its connection string.
2. Set the four required variables. Let Vercel generate `CRON_SECRET`.
3. `DATABASE_URL="…" npm run db:migrate` from your machine.
4. `DATABASE_URL="…" npx tsx scripts/create-user.ts you@example.com "Your Name"` —
   it prints a password once.
5. Deploy.
6. Sign in. The Settings screen will say nothing is connected. That is correct.
7. Add the Correos and Shopify credentials as they arrive, and watch the
   Connections panel turn over.
