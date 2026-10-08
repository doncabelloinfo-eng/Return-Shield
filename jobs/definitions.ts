import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, lt, ne, notInArray, or, sql as raw } from 'drizzle-orm';
import { getDb, rowsOf, at as ts } from '@/db';
import {
  correosPushInbox, jobRuns, offices, orders, postcodeStats,
  shipmentEvents, shipments, stores, importBatches, tasks,
} from '@/db/schema';
import { now, DAY, HOUR } from '@/lib/clock';
import { madridParts, madridMidnightUtc, madridDateKey, human, shortDate } from '@/lib/time';
import { normalisePayload } from '@/lib/carriers/correos/normalise';
import { nextSizeUp, shouldProbeLargerBatch, trackpub } from '@/lib/carriers/correos/trackpub';
import { ingestEvent, settleHistory } from '@/lib/shipments/ingest';
import { remapKnownEvents } from '@/lib/shipments/remap';
import {
  countLive, countOverdue, dueCutoffs, dueSql, liveSql,
  recheckHours, urgentRecheckHours, URGENT_STATES,
} from '@/lib/recheck';
import { progressWriter, startProgress } from '@/lib/sweep-progress';
import { liveShipmentIds } from '@/lib/shipments/repo';
import { runTick } from '@/lib/escalation/run';
import { openTask } from '@/lib/escalation/tasks';
import { getSetting, getSettings, setSetting } from '@/lib/settings';
import { say } from '@/lib/activity';
import { raiseAlert } from '@/lib/alerts';
import { purgeExpiredSessions } from '@/lib/auth/session';
import { purgeRateLimits } from '@/lib/rate-limit';
import { callQueue, money } from '@/lib/escalation/decide';
import { loadRows, todayView } from '@/lib/views/rows';
import { storeEnv } from '@/lib/carriers/shopify/verify';
import { pullStore } from '@/lib/carriers/shopify/pull';
import { envNumber, envOr } from '@/lib/env';
import { adminApiUrl } from '@/lib/carriers/shopify/api';

/**
 * Every scheduled job.
 *
 * All of them assume they will run twice — because they will. A worker
 * restarts mid-run, two workers overlap, somebody kicks one by hand. So every
 * job is written so that running it again changes nothing that has already
 * happened: the event table dedupes, tasks are unique per shipment and type,
 * and the escalation fires table means a rung can only fire once.
 */

/**
 * Is Correos' push integration set up at all?
 *
 * Tracking currently runs on trackpub only; Track&TracePush is not configured.
 * Both of the jobs that exist to serve push have to know that, or they spend
 * their time reporting on something nobody switched on — the heartbeat would
 * email a false alarm every working hour, and the drain would poll an empty
 * table every five minutes for ever.
 */
export function pushConfigured(): boolean {
  return Boolean(process.env.CORREOS_PUSH_CLIENT_ID && process.env.CORREOS_PUSH_CLIENT_SECRET);
}

/**
 * The jobs that are actually scheduled. The order is the order they appear on
 * the Settings screen: the ones that matter most first.
 *
 * `push-drain` (every five minutes) and `push-heartbeat` (hourly) are no
 * longer in it. Push is not configured and is not being turned on, so between
 * them they fired about three hundred times a day and every single run
 * recorded "push not configured" — nine of the ten rows in the Scheduled jobs
 * panel were about a feature nobody is using, and the panel's whole job is to
 * show at a glance that the engine is alive.
 *
 * Their code, their routes and the receiver are untouched: see
 * `PAUSED_JOB_NAMES` below. Putting them back is two lines in vercel.json and
 * a move between these two lists.
 */
export const JOB_NAMES = [
  'escalation-tick',
  'reconcile',
  'shopify-backfill',
  'stale-detector',
  'daily-digest',
  'import-reminder',
  'postcode-stats',
  'housekeeping',
] as const;

/**
 * Jobs that still exist and are not scheduled.
 *
 * They keep their place in `JobName` — the routes, the job lock and
 * `runJob` all still work, so hitting one by hand does exactly what it always
 * did — and they are left out of everything that lists the schedule:
 * vercel.json, the Settings panel, and the test that holds those two in step.
 */
export const PAUSED_JOB_NAMES = ['push-drain', 'push-heartbeat'] as const;

export type JobName = typeof JOB_NAMES[number] | typeof PAUSED_JOB_NAMES[number];

export interface JobResult {
  detail: Record<string, unknown>;
  /**
   * The run decided there was nothing for it to do. Recorded separately from
   * `ok`, because a skip is a successful run of a job that had no work — it
   * proves the scheduler is alive, and it must not count as "today's digest
   * has been sent".
   */
  skipped?: boolean;
}

export interface JobOutcome {
  ok: boolean;
  skipped: boolean;
  detail: Record<string, unknown>;
}

/**
 * Wraps a job so every run is recorded, and a failure never kills the worker.
 *
 * It returns the outcome rather than swallowing it. The route needs to know: a
 * job that threw used to return HTTP 200 with an empty detail, so Vercel's cron
 * log showed green on the morning the digest failed.
 */
export async function runJob(job: JobName, fn: () => Promise<JobResult>): Promise<JobOutcome> {
  const [run] = await getDb().insert(jobRuns).values({ job, startedAt: now() })
    .returning({ id: jobRuns.id });

  try {
    const result = await fn();
    // A job that returns `detail.skipped` is saying it had nothing to do, and
    // several already did before the column existed. Honour both.
    const skipped = result.skipped ?? typeof result.detail.skipped === 'string';

    await getDb().update(jobRuns)
      .set({ finishedAt: now(), ok: true, skipped, detail: result.detail })
      .where(eq(jobRuns.id, run.id));

    return { ok: true, skipped, detail: result.detail };
  } catch (err) {
    const message = err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err);
    console.error(`[job:${job}] failed:`, message);
    await getDb().update(jobRuns)
      .set({ finishedAt: now(), ok: false, skipped: false, detail: { error: message } })
      .where(eq(jobRuns.id, run.id));

    return { ok: false, skipped: false, detail: { error: message } };
  }
}

/* ---------------------------------------------------------------- every 30m */

export async function escalationTick(): Promise<JobResult> {
  const ids = await liveShipmentIds();
  const result = await runTick(ids, now());
  return { detail: { ...result } };
}

/* -------------------------------------------------------- every minute-ish */

/**
 * Drain the Correos push staging table.
 *
 * The receiver returns 200 and writes the raw body; this turns those bodies
 * into events. Keeping the two apart is what makes a normaliser bug survivable:
 * clear `processed_at` on the affected rows and they run again.
 */
export async function drainPushInbox(limit = 200): Promise<JobResult> {
  // Nothing can be in the staging table if the receiver refuses every request,
  // so there is nothing to drain. Return before opening a transaction rather
  // than querying an empty table every five minutes.
  if (!pushConfigured()) return { detail: { skipped: 'push not configured' } };

  const rows = await getDb().select().from(correosPushInbox)
    .where(isNull(correosPushInbox.processedAt))
    .orderBy(correosPushInbox.receivedAt)
    .limit(limit);

  let events = 0;
  let unknown = 0;
  let failed = 0;

  for (const row of rows) {
    try {
      const { events: list, problems } = normalisePayload(row.payload, 'push');
      for (const e of list) {
        const r = await ingestEvent(e);
        if (r.status === 'inserted') events += 1;
        if (r.status === 'unknown_shipment') unknown += 1;
      }
      await getDb().update(correosPushInbox).set({
        processedAt: now(),
        attempts: row.attempts + 1,
        lastError: problems.length ? problems.join('; ') : null,
      }).where(eq(correosPushInbox.id, row.id));
    } catch (err) {
      failed += 1;
      const message = err instanceof Error ? err.message : String(err);
      // Left unprocessed so it is retried, unless it has failed too often —
      // at which point it stays in the table as evidence rather than looping.
      await getDb().update(correosPushInbox).set({
        attempts: row.attempts + 1,
        lastError: message,
        processedAt: row.attempts >= 5 ? now() : null,
      }).where(eq(correosPushInbox.id, row.id));
    }
  }

  return { detail: { staged: rows.length, events, unknownShipments: unknown, failed } };
}

/* ------------------------------------------------------------- 03:00 Madrid */

/**
 * The safety net for push. Push has no guaranteed retry, so if the receiver
 * was down for an hour, this is the only thing that will ever notice.
 */
/**
 * How many parcels are dealt with before their "checked" stamps are written.
 *
 * Not a request size — the client decides that, and halves it when Correos
 * refuses (see lib/carriers/correos/trackpub.ts). This is the unit of work
 * between stamp writes, and it exists so that a run killed half way through
 * has still recorded the parcels it genuinely checked. One UPDATE per parcel
 * would be five thousand round trips through a pooler for a sweep that made
 * fifty HTTP requests; no stamping until the end would lose the lot.
 */
const STAMP_EVERY = 100;

export interface ReconcileOptions {
  /** Most parcels to consider in one run. The budget is the real limiter. */
  batchSize?: number;
  /** Stop starting new requests after this long, so the run always finishes. */
  budgetMs?: number;
  /**
   * Only parcels Correos has never been asked about.
   *
   * Used straight after a thirty-day pull: a thousand freshly created parcels
   * would otherwise sit in Pre-admission for up to three hours waiting for the
   * next scheduled sweep, which is the whole window in which somebody could
   * still save the ones already sitting at a post office.
   */
  onlyUnswept?: boolean;
  /**
   * Only the parcels the twelve-hour rule says are due.
   *
   * What the hourly cron passes, and the whole of why the cron can run twelve
   * times as often as it used to for less money. Manual Refresh does NOT pass
   * it: a person pressing the button is asking about everything, and being
   * told "nothing was due" is not an answer to that.
   *
   * See lib/recheck.ts for the rule.
   */
  dueOnly?: boolean;
  /** Shown in the progress bar as "Checking with Correos" rather than "Automatic check". */
  manual?: boolean;
}

/*
 * The states where being out of date costs something, the twelve-hour rule and
 * the three-hour one all live in lib/recheck.ts now, because three other
 * things read them: the queue below, the Settings capacity line, and the
 * digest's overdue count.
 */

/**
 * Ask Correos about every live parcel, urgent ones first.
 *
 * Push is not configured, so this is the only way tracking reaches the system.
 * About a thousand parcels a day are shipped, so roughly five thousand are live
 * at once and every one must be refreshed at least every twelve hours. Running
 * every three hours with batches of a hundred is about fifty requests a run,
 * which clears the whole live set eight times a day.
 *
 * Bounded twice over: at most `batchSize` parcels, and no new request started
 * after `budgetMs`. Both sit inside the route's maxDuration, so the run ends by
 * choice rather than by being killed half way through a sweep.
 */
export async function reconcile(opts: ReconcileOptions = {}): Promise<JobResult> {
  /*
   * Re-apply the state map to the events we already hold, BEFORE anything is
   * asked of Correos — and before the credentials are even checked, because
   * this is local work that does not need them.
   *
   * A wording added in a deploy has to reach the parcels already sitting in
   * the wrong tab, and the one it matters most for — "Finalizado plazo
   * retirada", a collection window that has closed — is exactly the parcel
   * Correos has nothing further to say about, so waiting for its next event
   * means waiting for ever. Cheap when nothing changed: one grouped scan over
   * the distinct events. See lib/shipments/remap.ts.
   */
  const remap = await remapKnownEvents();

  const knownMode = await getSetting('correosBatchMode');
  const knownSize = await getSetting('correosBatchSize');
  const probedAt = await getSetting('correosBatchProbedAt');

  /*
   * Start from the largest size Correos has been seen to accept — or, once a
   * day, from double it.
   *
   * The daily probe costs one refused request and is the only thing that would
   * ever find out that the limit has moved. Without it a single bad afternoon
   * on the gateway would pin the sweep to one parcel per request for ever,
   * which is exactly what happened: a batch of 75 was refused with an HTML 403
   * and all 201 parcels got their own request from then on.
   */
  const probe = shouldProbeLargerBatch(probedAt, now());
  const startSize = probe ? nextSizeUp(knownSize) : knownSize;
  const client = trackpub({
    // The probe opens up a remembered 'single', because otherwise the client
    // would take the one-request-per-parcel path and the larger size would
    // never actually be tried. A remembered 'comma' keeps its proven status:
    // that is what stops a batch of freshly printed labels, which Correos
    // legitimately knows nothing about, reading as a broken format.
    batchMode: probe && knownMode === 'single' ? 'unknown' : knownMode,
    batchSize: startSize,
  });

  if (!client.configured) {
    return {
      detail: {
        skipped: 'Correos credentials are not configured',
        ...(remap.events ? { remappedEvents: remap.events, remappedParcels: remap.moved } : {}),
      },
    };
  }

  // `envNumber`, not `Number(… ?? default)`: `Number('')` is 0, so an empty
  // RECONCILE_BATCH_SIZE would be a sweep that looks at no parcels at all and
  // reports success. See lib/env.ts.
  const batchSize = opts.batchSize ?? envNumber('RECONCILE_BATCH_SIZE', 6000);
  const budgetMs = opts.budgetMs ?? envNumber('RECONCILE_BUDGET_MS', 240_000);

  // Two different clocks, deliberately. The budget measures how long this
  // invocation has actually been running, so it must be wall-clock — a demo or
  // a test that moves the clock forward a fortnight must not convince the sweep
  // it has been going for a fortnight. The cursor comparison below is about the
  // data, so it uses the injectable clock that wrote the stamps.
  const elapsedFrom = Date.now();
  const runStartedAt = now();

  /*
   * Urgent first, then longest since its last check. The ordering IS the
   * cursor: a run that stops early leaves the rest with an older stamp, so the
   * next run continues from exactly where this one gave up — nothing to
   * persist, nothing to get out of step when parcels are added or finish, and
   * no parcel can be starved because the one checked longest ago is always
   * next in its bucket.
   *
   * `dueOnly` is what the hourly cron passes. Raw SQL rather than drizzle's
   * builder because the due rule is one predicate shared with the Settings
   * capacity line and the digest, and it lives in lib/recheck.ts — written
   * once, not three times.
   */
  const cutoffs = dueCutoffs(runStartedAt);
  const scope = opts.onlyUnswept
    ? raw`${liveSql()} AND s.last_reconciled_at IS NULL`
    : (opts.dueOnly ? dueSql(cutoffs) : liveSql());
  const urgentList = raw.join(
    (URGENT_STATES as readonly string[]).map((state) => raw`${state}`),
    raw`, `,
  );

  const queue = rowsOf<{ id: string; code: string; state: string; first_read: boolean }>(
    await getDb().execute(raw`
      SELECT s.id,
             s.shipping_code AS code,
             s.state,
             -- Never asked about before, so whatever Correos is about to tell
             -- us is HISTORY rather than news. A parcel pulled from thirty
             -- days back may have been delivered a fortnight ago; narrating
             -- every step of that, and firing the reminders that were due
             -- while we were not looking, is what settleHistory prevents.
             (s.last_reconciled_at IS NULL) AS first_read
        FROM shipments s
       WHERE ${scope}
       ORDER BY CASE WHEN s.state IN (${urgentList}) THEN 0 ELSE 1 END ASC,
                s.last_reconciled_at ASC NULLS FIRST,
                s.created_at ASC
       LIMIT ${batchSize}
    `),
  ).map((r) => ({ id: r.id, code: r.code, state: r.state, firstRead: r.first_read }));

  /*
   * Nothing due: stop here, without a token and without a request.
   *
   * This is the point of running hourly. Most hours have a handful of parcels
   * due or none at all, and a run that ends in forty milliseconds costs
   * essentially nothing — where the old three-hourly run asked about all 201
   * parcels every time and stayed alive for 114 seconds to learn that 190 of
   * them had not moved.
   */
  if (opts.dueOnly && queue.length === 0) {
    return {
      skipped: true,
      detail: {
        skipped: 'nothing was due',
        live: await countLive(),
        recheckHours: recheckHours(),
        urgentRecheckHours: urgentRecheckHours(),
        ...(remap.events ? { remappedEvents: remap.events, remappedParcels: remap.moved } : {}),
      },
    };
  }

  const byCode = new Map(queue.map((q) => [q.code.toUpperCase(), q.id]));
  const firstRead = new Set(queue.filter((q) => q.firstRead).map((q) => q.code.toUpperCase()));
  let settledHistory = 0;

  /*
   * The progress row, written before the first request so the bar appears at
   * "0 of 201" rather than materialising a third of the way through. Both the
   * manual Refresh and this hourly cron write it, which is how the automatic
   * check becomes visible to anyone with the app open.
   */
  const progressRow = await startProgress({
    total: queue.length,
    manual: opts.manual === true,
    at: runStartedAt,
  });
  const writeProgress = progressWriter(progressRow);
  /**
   * Events that were genuinely new to a parcel we were already watching.
   *
   * Counted apart from `recovered`, which includes a pulled parcel's entire
   * past: "found 4,000 updates that had not reached us" would be true and
   * useless on the day of a thirty-day pull.
   */
  let news = 0;

  /**
   * Parcels Correos told us something new about. The Refresh button reports
   * this as "M changed", so it counts PARCELS rather than events: a parcel
   * whose whole history arrived in one go changed once, not eleven times.
   */
  const changedParcels = new Set<string>();

  let asked = 0;
  let recovered = 0;
  let missing = 0;
  let requests = 0;
  let stoppedEarly: string | null = null;
  const failures: string[] = [];

  for (let i = 0; i < queue.length; i += STAMP_EVERY) {
    // Check the budget before starting a request, never in the middle of one.
    // Being killed mid-sweep is how a parcel gets stamped as checked without
    // having been checked.
    if (Date.now() - elapsedFrom > budgetMs) {
      stoppedEarly = 'ran out of time — the next run continues from here';
      break;
    }

    const chunk = queue.slice(i, i + STAMP_EVERY).map((q) => q.code);
    // Hand the client our deadline so it can stop between requests rather than
    // only between batches — a chunk that falls back to one request per parcel
    // is a hundred requests, and a budget checked only after all of them is
    // not a budget.
    const result = await client.lookupMany(chunk, {
      deadline: elapsedFrom + budgetMs,
      /*
       * The bar has to move while the requests are happening, which is where
       * all the time goes. Reporting from the loop below instead left it at
       * "0 of 12" for eight seconds and then jumped it to 100% — because that
       * is exactly when this function found out.
       *
       * `changed` lags by one chunk, and that is honest: a parcel is "checked"
       * when Correos has answered about it, and whether anything changed is
       * not known until the events are written.
       */
      onAnswered: (answered) =>
        writeProgress({ checked: asked + answered, changed: changedParcels.size }),
    });
    requests += result.requests;

    /** Parcels we genuinely got an answer about, and may stamp as checked. */
    const answered: string[] = [];

    for (const [code, one] of result.byCode) {
      asked += 1;

      if (one.ok) {
        const history = firstRead.has(code);

        for (const event of one.outcome.events) {
          // Quiet for a first read: write the event, recompute the state, and
          // narrate nothing. What the parcel needs today is decided once,
          // below, rather than once per event of its past.
          const ingested = await ingestEvent(event, { quiet: history });
          if (ingested.status === 'inserted') {
            recovered += 1;
            if (!history) news += 1;
            if (ingested.shipmentId) changedParcels.add(ingested.shipmentId);
          }
        }

        await writeProgress({ checked: asked, changed: changedParcels.size });

        if (history) {
          const id = byCode.get(code);
          if (id) {
            const outcome = await settleHistory(id);
            if (outcome !== 'quiet') settledHistory += 1;
          }
        }

        answered.push(code);
        continue;
      }

      if (one.definitive) {
        // Correos has given a final answer about this code and it is a bad
        // one: never heard of it, or an `error` block naming it. Asking again
        // in three hours will say the same thing, so it counts as checked.
        //
        // `definitive`, not `!retryable`: a 401 or a 403 is non-retryable and
        // is about the account rather than the parcel, and stamping every live
        // parcel as checked on the strength of an auth failure is the exact
        // invisible failure this sweep exists to prevent.
        missing += 1;
        answered.push(code);
        continue;
      }

      failures.push(`${code}: ${one.error}`);
    }

    await markReconciled(answered.map((c) => byCode.get(c)).filter(isString), runStartedAt);

    // Codes the deadline arrived before. Nothing was learnt about them, so they
    // keep their old stamp and lead the next run's queue.
    if (result.notReached.length) {
      stoppedEarly = 'ran out of time — the next run continues from here';
      break;
    }

    // A rate limit or an outage means stop, not push harder. The next run picks
    // up where this one stopped; a blocked account picks up nothing.
    if (failures.length >= 10) {
      stoppedEarly = `Correos is refusing requests (${failures[0]})`;
      break;
    }
  }

  // Remember what we learnt about the undocumented batch format, so the next
  // run does not have to probe for it again.
  if (client.mode !== knownMode) await setSetting('correosBatchMode', client.mode);

  /*
   * And the SIZE, which is the number that matters now.
   *
   * `client.batchSize` is what this run DEMONSTRATED, which is a floor rather
   * than a ceiling: a run with six parcels due proves six works and says
   * nothing about eighteen. So it only ever raises the remembered size —
   * unless a refusal actually narrowed it, which is the one case where a
   * smaller number is the truth and has to be written down.
   *
   * 0 means nothing was learnt at all (not configured, nothing to look up, the
   * deadline first) and the stored size is left exactly as it was.
   */
  const learnt = client.batchSize;
  if (learnt > 0) {
    const next = client.narrowed ? learnt : Math.max(knownSize, learnt);
    if (next !== knownSize) await setSetting('correosBatchSize', next);
  }
  if (probe) await setSetting('correosBatchProbedAt', runStartedAt.toISOString());

  /*
   * Only count what was genuinely news. A first read of a pulled parcel brings
   * in its whole past, so `recovered` would be twenty events about a parcel
   * delivered a fortnight ago — "found 4,000 updates that had not reached us"
   * is true and useless.
   */
  if (news > 0) {
    await say(`Check with Correos found ${news} updates that had not reached us`);
  }

  const [remaining] = await getDb().select({ n: raw<number>`count(*)::int` })
    .from(shipments)
    .where(and(
      isNull(shipments.droppedAt),
      notInArray(shipments.state, ['delivered', 'collected', 'returned']),
      or(
        isNull(shipments.lastReconciledAt),
        lt(shipments.lastReconciledAt, runStartedAt),
      ),
    ));

  const tookMs = Date.now() - elapsedFrom;

  // The final write always happens, whatever the throttle says: the line that
  // stays on screen afterwards is the answer to "what did that do".
  await writeProgress(
    {
      checked: asked,
      changed: changedParcels.size,
      done: true,
      tookMs,
      ...(stoppedEarly ? { stoppedEarly } : {}),
    },
    { force: true },
  );

  const overdue = await countOverdue(runStartedAt);

  return {
    detail: {
      asked,
      changed: changedParcels.size,
      /**
       * EVENTS STORED, which is the number that would have made a day of
       * stale answers obvious.
       *
       * Six hourly runs in a row reported "asked 201, changed 0" while Correos
       * had hundreds of events nobody could see, and "changed 0" is also what a
       * perfectly healthy quiet night looks like. `newEvents` separates the
       * two: zero events stored across three runs that asked about hundreds of
       * parcels is not a quiet night, and the Settings screen now says so.
       */
      newEvents: recovered,
      ...(news !== recovered ? { news } : {}),
      recovered,
      missing,
      requests,
      live: queue.length,
      batchMode: client.mode,
      ...(client.diagnosis ? { batchNote: client.diagnosis } : {}),
      stillToCheck: remaining?.n ?? 0,
      overdue,
      batchSize: client.batchSize,
      ...(probe ? { probedLargerBatch: startSize } : {}),
      tookMs,
      ...(settledHistory ? { settledHistory } : {}),
      ...(remap.events ? { remappedEvents: remap.events, remappedParcels: remap.moved } : {}),
      ...(remap.resolved.length ? { nowRecognised: remap.resolved } : {}),
      ...(stoppedEarly ? { stoppedEarly } : {}),
      ...(failures.length ? { failures: failures.slice(0, 10) } : {}),
    },
  };
}

/**
 * Stamp a whole chunk at once. One UPDATE per parcel would be five thousand
 * round trips through a connection pooler for a sweep that only made fifty
 * HTTP requests.
 */
async function markReconciled(ids: string[], at: Date): Promise<void> {
  if (!ids.length) return;
  await getDb().update(shipments)
    .set({ lastReconciledAt: at })
    .where(inArray(shipments.id, ids));
}

function isString(x: string | undefined): x is string {
  return typeof x === 'string';
}

/* ------------------------------------------------------------- 07:30 Madrid */

/**
 * Parcels Correos has gone quiet about. Only ones in motion: a parcel sitting
 * at a post office is meant to be silent for a fortnight, and flagging those
 * would bury the ones that actually vanished.
 */
export async function staleDetector(): Promise<JobResult> {
  const { staleAfterHours } = await getSettings();
  const cutoff = new Date(now().getTime() - staleAfterHours * HOUR);

  const rows = await getDb().select({
    id: shipments.id,
    customerName: orders.customerName,
    lastEventAt: shipments.lastEventAt,
  })
    .from(shipments)
    .innerJoin(orders, eq(orders.id, shipments.orderId))
    .where(and(
      isNull(shipments.droppedAt),
      inArray(shipments.state, ['accepted', 'in_transit', 'out_for_delivery']),
      lt(shipments.lastEventAt, cutoff),
    ));

  const days = Math.round(staleAfterHours / 24);
  for (const r of rows) {
    await openTask({
      shipmentId: r.id,
      type: 'chase_carrier',
      reason: 'no_updates',
      label: `No update for ${days} days — ask Correos`,
    });
  }

  if (rows.length) {
    // Keyed to the day: the hourly catch-up schedule means this job can be
    // attempted many times before one succeeds, and the feed should not carry
    // the same sentence two dozen times.
    await say(
      `${rows.length} parcels have had no update for over ${days} days — on your list to ask Correos`,
      { dedupeKey: `stale-detector:${madridDateKey(now())}` },
    );
  }

  return { detail: { flagged: rows.length, staleAfterHours } };
}

/* ------------------------------------------------------------- 08:00 Madrid */

/**
 * What to do today, in order. Not what happened yesterday — a digest of
 * history is a digest nobody opens twice.
 */
export async function dailyDigest(): Promise<JobResult> {
  const view = await todayView(0, now());

  // Parcels past the cleanup window that are still going. They are kept rather
  // than deleted, which is right — and keeping them quietly would mean nobody
  // ever looks at them, so the digest counts them and points at the tab.
  const { cutoffFor, countKeptUnfinished } = await import('@/lib/cleanup');
  const { retentionDays } = await import('@/lib/retention');
  const overdue = await countKeptUnfinished(cutoffFor(now()));
  const overdueLines = overdue > 0
    ? [
      `· ${overdue} ${overdue === 1 ? 'parcel is' : 'parcels are'} more than `
      + `${retentionDays()} days old and still not finished: `
      + `${appUrl()}/parcels?status=stuck_30`,
    ]
    : [];

  /*
   * Parcels Correos has not been asked about within the rule — a different
   * thing from the line above, which is about parcels that are old.
   *
   * It is here because the promise is invisible otherwise. Every live parcel is
   * supposed to be checked at least twice a day, and the day that stopped
   * happening every screen still looked healthy. A count in the digest is the
   * one place it reaches somebody who is not looking at the dashboard.
   */
  const notChecked = await countOverdue(now());
  const notCheckedLines = notChecked > 0
    ? [
      `· ${notChecked} ${notChecked === 1 ? 'parcel has' : 'parcels have'} not been `
      + `checked with Correos within the last ${recheckHours()} hours`
      + ` (${urgentRecheckHours()} for the urgent ones): ${appUrl()}/settings`,
    ]
    : [];

  if (!view.rows.length) {
    await raiseAlert({
      dedupeKey: `digest-empty:${madridDateKey(now())}`,
      subject: 'Return Shield — nothing needs you today',
      lines: [
        'Every parcel is either moving normally or already handled.',
        ...(overdueLines.length || notCheckedLines.length
          ? ['', ...overdueLines, ...notCheckedLines]
          : []),
        '',
        'Nothing to do. Have a good morning.',
      ],
    });
    return { detail: { items: 0, overdue, notChecked } };
  }

  const lines: string[] = [view.headline, ''];
  for (const d of view.digest) lines.push(`· ${d}`);
  for (const d of overdueLines) lines.push(d);
  for (const d of notCheckedLines) lines.push(d);
  lines.push('', 'In order, most money at risk first:', '');

  view.rows.slice(0, 15).forEach((r, i) => {
    lines.push(`${i + 1}. ${r.action?.label ?? 'Look at it'} — ${r.customerName}`);
    lines.push(`   ${r.why}`);
    lines.push(`   ${r.orderNumber} · ${r.valueText}`
      + `${r.paymentMethod === 'cod' ? ' · cash on delivery' : ''}`
      + `${r.officeName ? ` · ${r.officeName}` : ''}`);
    lines.push(`   ${appUrl()}/parcel/${r.id}`);
    lines.push('');
  });

  if (view.rows.length > 15) lines.push(`...and ${view.rows.length - 15} more on the dashboard.`);

  const raised = await raiseAlert({
    // One digest per Madrid day, whatever the schedule does. This is what makes
    // an hourly catch-up schedule safe: the second invocation's insert does
    // nothing, so nobody gets the same digest twice.
    dedupeKey: `digest:${madridDateKey(now())}`,
    subject: `Return Shield — ${view.headline}`,
    lines,
  });

  return { detail: { items: view.rows.length, calls: view.callCount, notChecked, raised } };
}

/* ----------------------------------------------------------------- hourly */

/**
 * No events during working hours means the integration broke, not that nothing
 * happened. Correos scans parcels all day; silence is a symptom.
 */
export async function pushHeartbeat(): Promise<JobResult> {
  // This job's whole premise is "events should be arriving by push, and they
  // are not". With push unconfigured that premise is false, and the alert it
  // would send is a false alarm — every working hour, for ever.
  if (!pushConfigured()) return { detail: { skipped: 'push not configured' } };

  const at = now();
  const hour = madridParts(at).hour;
  const weekday = madridParts(at).weekday;

  // Outside working hours, and on Sundays, silence is normal.
  if (hour < 9 || hour > 20 || weekday === 0) {
    return { detail: { skipped: 'outside working hours' } };
  }

  const since = new Date(at.getTime() - 3 * HOUR);
  const [row] = await getDb().select({ n: raw<number>`count(*)::int` })
    .from(shipmentEvents)
    .where(and(
      eq(shipmentEvents.source, 'push'),
      gt(shipmentEvents.receivedAt, since),
    ));

  const count = row?.n ?? 0;
  if (count > 0) return { detail: { events: count, healthy: true } };

  // Don't cry wolf when there is genuinely nothing in flight.
  const live = await liveShipmentIds();
  if (live.length === 0) return { detail: { events: 0, healthy: true, note: 'nothing in flight' } };

  await raiseAlert({
    // One per three-hour window, so a heartbeat that fires twice in the same
    // hour does not email twice.
    dedupeKey: `push-silent:${madridDateKey(at)}:${madridParts(at).hour}`,
    subject: 'Return Shield — no tracking updates from Correos for three hours',
    lines: [
      `Nothing has arrived from Correos since ${shortDate(since)} and there are ${live.length} parcels in flight.`,
      '',
      'During working hours that usually means the push integration has broken rather than',
      'that nothing happened. Worth checking:',
      '',
      '  · is the push receiver reachable from outside?',
      '  · has the source IP Correos calls from changed?',
      '  · are CORREOS_PUSH_CLIENT_ID / _SECRET still right?',
      '',
      'The reconcile sweep still picks everything up, so nothing is lost — but',
      'countdowns will be up to three hours stale until push is back.',
    ],
  });

  return { detail: { events: 0, healthy: false, live: live.length } };
}

/* ----------------------------------------------------------------- hourly */

/**
 * Webhooks are lost more often than people expect. This pulls recent
 * fulfilments by API and inserts anything whose webhook never arrived.
 */
export async function shopifyBackfill(): Promise<JobResult> {
  const shopifyStores = await getDb().select().from(stores)
    .where(and(eq(stores.platform, 'shopify'), eq(stores.active, true)));

  let created = 0;
  let checked = 0;
  const skipped: string[] = [];

  for (const store of shopifyStores) {
    const token = storeEnv(store.key, 'ACCESS_TOKEN');
    const domain = store.shopDomain ?? storeEnv(store.key, 'SHOP_DOMAIN');

    if (!token || !domain) { skipped.push(store.key); continue; }

    /*
     * The same paged reader the thirty-day pull uses, because the hourly check
     * had the same two bugs.
     *
     * It asked for `limit: 100` and read the FIRST PAGE ONLY. Two days of
     * orders at a thousand parcels a day is several hundred, so it was looking
     * at a fraction of them and reporting success — and Shopify says nothing
     * when a page ends early, it simply ends.
     *
     * And it filtered `fulfillment_status=shipped`, which leaves out partially
     * fulfilled orders. An order with one item posted and one still to pack is
     * `partial`, and its posted parcel is as real as any other.
     */
    const report = await pullStore(store.key, {
      from: new Date(now().getTime() - 2 * DAY),
      // Well inside the route's 120s maxDuration, and the pull is resumable:
      // anything it does not reach, the next hour's run picks up.
      budgetMs: 90_000,
    });

    checked += report.checked;
    created += report.added;
    if (report.stoppedEarly) skipped.push(`${store.key} (${report.stoppedEarly})`);
  }

  if (created > 0) {
    await say(`Hourly check of Shopify found ${created} parcels whose webhook never arrived`);
  }

  return { detail: { checked, created, skipped } };
}

/* ------------------------------------------------------------- 09:00 Madrid */

/**
 * Nudges if it has been more than a day since the last marketplace upload.
 *
 * Either kind counts. Amazon and TikTok come in through the same screen and
 * the same batch table, so an Amazon upload answers the question "is anybody
 * loading the files" just as well as a TikTok one.
 */
export async function importReminder(): Promise<JobResult> {
  const [last] = await getDb().select({ createdAt: importBatches.createdAt })
    .from(importBatches)
    .where(isNotNull(importBatches.committedAt))
    .orderBy(desc(importBatches.createdAt))
    .limit(1);

  const at = now();
  const cutoff = new Date(at.getTime() - DAY);
  if (last && last.createdAt > cutoff) {
    return { detail: { lastUpload: last.createdAt, nudged: false } };
  }

  await raiseAlert({
    dedupeKey: `import-reminder:${madridDateKey(at)}`,
    subject: 'Return Shield — TikTok or Amazon orders have not been uploaded',
    lines: [
      last
        ? `The last upload was ${human(last.createdAt, at)}.`
        : 'No TikTok or Amazon orders have ever been uploaded.',
      '',
      'Those parcels are invisible to this system until the file is uploaded, which means',
      'nobody is watching their countdowns. Shopify orders are unaffected.',
      '',
      `Upload here: ${appUrl()}/import`,
    ],
  });

  return { detail: { lastUpload: last?.createdAt ?? null, nudged: true } };
}

/* -------------------------------------------------------------- nightly */

/**
 * Rebuilds the failure rates behind the dispatch warning.
 *
 * An area is watched once it fails materially more than average *and* has
 * enough parcels for that to mean anything — flagging a postcode because its
 * only two parcels both failed would cry wolf at every new town.
 */
export async function rebuildPostcodeStats(): Promise<JobResult> {
  const { watchFailRateMultiple } = await getSettings();
  const MIN_SHIPPED = 8;

  const rows = await getDb().select({
    postalCode: orders.postalCode,
    town: orders.city,
    shipped: raw<number>`count(*)::int`,
    failed: raw<number>`count(*) FILTER (WHERE EXISTS (
      SELECT 1 FROM shipment_events e
      WHERE e.shipment_id = ${shipments.id} AND e.mapped_state = 'failed'
    ))::int`,
    returned: raw<number>`count(*) FILTER (WHERE ${shipments.state} IN ('returning', 'returned', 'refused'))::int`,
  })
    .from(shipments)
    .innerJoin(orders, eq(orders.id, shipments.orderId))
    .where(and(isNotNull(orders.postalCode), ne(orders.postalCode, '')))
    .groupBy(orders.postalCode, orders.city, shipments.id);

  // Fold the per-shipment grouping back up to one row per postcode.
  const byCode = new Map<string, { town: string | null; shipped: number; failed: number; returned: number }>();
  for (const r of rows) {
    const key = r.postalCode!;
    const acc = byCode.get(key) ?? { town: r.town, shipped: 0, failed: 0, returned: 0 };
    acc.shipped += r.shipped;
    acc.failed += r.failed;
    acc.returned += r.returned;
    acc.town ??= r.town;
    byCode.set(key, acc);
  }

  const totalShipped = [...byCode.values()].reduce((a, v) => a + v.shipped, 0);
  const totalFailed = [...byCode.values()].reduce((a, v) => a + v.failed, 0);
  const average = totalShipped ? totalFailed / totalShipped : 0;

  let watched = 0;
  const at = now();

  for (const [postalCode, v] of byCode) {
    const failRate = v.shipped ? v.failed / v.shipped : 0;
    const watch = v.shipped >= MIN_SHIPPED && average > 0 && failRate >= average * watchFailRateMultiple;
    if (watch) watched += 1;

    await getDb().insert(postcodeStats).values({
      postalCode,
      town: v.town,
      shipped: v.shipped,
      failed: v.failed,
      returned: v.returned,
      failRate,
      watch,
      rebuiltAt: at,
    }).onConflictDoUpdate({
      target: postcodeStats.postalCode,
      set: { town: v.town, shipped: v.shipped, failed: v.failed, returned: v.returned, failRate, watch, rebuiltAt: at },
    });
  }

  return { detail: { postcodes: byCode.size, watched, averageFailRate: Number(average.toFixed(4)) } };
}

/* -------------------------------------------------------------- nightly */

/** Expired sessions and old rate-limit buckets are dead weight and a liability. */
/**
 * Sessions, rate limits, and the rolling retention window.
 *
 * The window is the substantial part and lives in lib/cleanup.ts. Everything
 * it deletes goes by whole Madrid days, one day per night, so this job is the
 * same on its first night as on its thousandth.
 */
export async function housekeeping(): Promise<JobResult> {
  const [sessions, limits] = await Promise.all([purgeExpiredSessions(), purgeRateLimits()]);

  const { runCleanup, databaseBytes } = await import('@/lib/cleanup');
  const cleaned = await runCleanup(now());

  // Measured after the deletes, which is the number worth recording: it says
  // whether the window is actually holding the database still.
  const bytes = await databaseBytes();

  if (cleaned.orders > 0) {
    await say(
      `Nightly cleanup removed ${cleaned.orders} finished `
      + `${cleaned.orders === 1 ? 'order' : 'orders'} older than ${cleaned.windowDays} days`,
    );
  }

  return {
    detail: {
      sessions,
      rateLimitBuckets: limits,
      ...cleaned,
      databaseMb: Math.round((bytes / (1024 * 1024)) * 10) / 10,
    },
  };
}

function appUrl(): string {
  return envOr('APP_URL', 'http://localhost:3000').replace(/\/$/, '');
}
