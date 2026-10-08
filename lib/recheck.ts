import { sql as raw, type SQL } from 'drizzle-orm';
import { getDb, rowsOf, at as ts } from '@/db';
import { now, HOUR } from '@/lib/clock';
import { envNumber } from '@/lib/env';

/**
 * How often each parcel has to be asked about, and which parcels cannot wait.
 *
 * THE RULE THIS FILE EXISTS FOR: every live parcel is checked at least every
 * twelve hours, and a parcel where something is about to happen every three.
 * Finished parcels are never checked again.
 *
 * It replaced a sweep that asked about EVERY live parcel on EVERY run. At 201
 * parcels and one request each that was 114 seconds of a function being alive,
 * every three hours, to learn nothing about the 190 parcels that had not
 * moved. Vercel bills memory for the whole time a function is alive and CPU
 * only while code is running, and this sweep spends almost all of its life
 * waiting on Correos — so the bill is wall-clock, and the way to cut it is to
 * ask about fewer parcels, more often, and finish sooner.
 *
 * Hence: the cron runs every hour and does only what is due. Most runs are
 * short; a run with nothing due ends without asking Correos at all.
 */

/** Twelve hours, so every parcel is seen at least twice a day. */
export const DEFAULT_RECHECK_HOURS = 12;

/**
 * Three hours for the parcels where being out of date costs something.
 *
 * `out_for_delivery` is on this list because that is the state a failed
 * delivery comes out of, and the gap between "the van has it" and "nobody was
 * home" is the gap in which a customer can still be told. The other three are
 * already on a clock: a parcel at a post office is being counted, one whose
 * delivery failed is about to be, and one with a bad address is waiting on a
 * person.
 */
export const DEFAULT_URGENT_RECHECK_HOURS = 3;

export function recheckHours(): number {
  return positive(envNumber('RECHECK_HOURS', DEFAULT_RECHECK_HOURS), DEFAULT_RECHECK_HOURS);
}

export function urgentRecheckHours(): number {
  return positive(
    envNumber('URGENT_RECHECK_HOURS', DEFAULT_URGENT_RECHECK_HOURS),
    DEFAULT_URGENT_RECHECK_HOURS,
  );
}

/**
 * Zero or a negative number would make every parcel permanently due, which is
 * the sweep this change exists to stop — so a nonsense value falls back to the
 * default rather than quietly costing money. `envNumber` already handles a
 * blank or non-numeric value; this handles a number that parses and is wrong.
 */
function positive(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * The states checked every three hours instead of every twelve.
 *
 * The brief's words for them are Out for delivery, Failed delivery, Wrong
 * address and Waiting at the post office.
 */
export const URGENT_STATES = ['out_for_delivery', 'failed', 'bad_address', 'at_office'] as const;

/** Nothing more happens on its own, so there is nothing to ask about. */
export const FINISHED_STATES = ['delivered', 'collected', 'returned'] as const;

export interface DueCutoffs {
  /** A normal parcel checked before this is due. */
  normal: Date;
  /** An urgent parcel checked before this is due. */
  urgent: Date;
}

export function dueCutoffs(at: Date = now()): DueCutoffs {
  return {
    normal: new Date(at.getTime() - recheckHours() * HOUR),
    urgent: new Date(at.getTime() - urgentRecheckHours() * HOUR),
  };
}

/**
 * Is this parcel due? The same rule the SQL below applies, for one row.
 *
 * Written twice — here and as SQL — which is a real cost, so the tests drive
 * both against the same cases. The SQL is what the sweep selects with, because
 * the alternative is loading thirty thousand rows to pick two hundred; this
 * one is what a screen and a digest line can use on a row they already have.
 */
export function isDue(
  parcel: { state: string; lastReconciledAt: Date | null; droppedAt?: Date | null },
  at: Date = now(),
): boolean {
  if (parcel.droppedAt) return false;
  if ((FINISHED_STATES as readonly string[]).includes(parcel.state)) return false;
  // Never asked about at all. Always due, and first in the queue.
  if (!parcel.lastReconciledAt) return true;

  const cutoffs = dueCutoffs(at);
  const limit = (URGENT_STATES as readonly string[]).includes(parcel.state)
    ? cutoffs.urgent
    : cutoffs.normal;

  return parcel.lastReconciledAt.getTime() < limit.getTime();
}

/* -------------------------------------------------------------------------- */

/** Live: not finished and not written off. The set the rule applies to. */
export function liveSql(): SQL {
  return raw`s.dropped_at IS NULL AND s.state NOT IN ('delivered', 'collected', 'returned')`;
}

/**
 * Live AND due, as one predicate the database can use an index for.
 *
 * The cutoffs arrive as two timestamps rather than as per-row interval
 * arithmetic, so this is an index-usable comparison on `last_reconciled_at`
 * rather than a calculation Postgres has to do thirty thousand times.
 */
export function dueSql(cutoffs: DueCutoffs): SQL {
  const urgent = raw.join(
    (URGENT_STATES as readonly string[]).map((state) => raw`${state}`),
    raw`, `,
  );

  return raw`
    ${liveSql()}
    AND (
      s.last_reconciled_at IS NULL
      OR (s.state IN (${urgent}) AND s.last_reconciled_at < ${ts(cutoffs.urgent)})
      OR (s.state NOT IN (${urgent}) AND s.last_reconciled_at < ${ts(cutoffs.normal)})
    )
  `;
}

/**
 * Past the rule, rather than merely due.
 *
 * Due means "it is time to ask". Overdue means the promise to the operator —
 * every parcel seen twice a day — has been broken, which is a different thing
 * and the one worth colouring red. A parcel is overdue when it has gone more
 * than its own window plus one hour, the hour being the gap between cron runs:
 * a parcel that came due four minutes ago has not been failed by anything.
 *
 * `COALESCE(last_reconciled_at, created_at)`, so a parcel nobody has asked
 * about yet is measured from when we first knew of it. A never-asked parcel is
 * always DUE — we want it in the next run — but it is not overdue until the
 * window has actually gone by, or the minute after an upload every new parcel
 * would be red.
 */
export function overdueSql(at: Date = now()): SQL {
  const grace = HOUR;
  const normal = new Date(at.getTime() - recheckHours() * HOUR - grace);
  const urgent = new Date(at.getTime() - urgentRecheckHours() * HOUR - grace);
  const urgentList = raw.join(
    (URGENT_STATES as readonly string[]).map((state) => raw`${state}`),
    raw`, `,
  );
  const since = raw`COALESCE(s.last_reconciled_at, s.created_at)`;

  return raw`
    ${liveSql()}
    AND (
      (s.state IN (${urgentList}) AND ${since} < ${ts(urgent)})
      OR (s.state NOT IN (${urgentList}) AND ${since} < ${ts(normal)})
    )
  `;
}

/* -------------------------------------------------------------------------- */

async function count(where: SQL): Promise<number> {
  const rows = rowsOf<{ n: number }>(await getDb().execute(
    raw`SELECT count(*)::int AS n FROM shipments s WHERE ${where}`,
  ));
  return rows[0]?.n ?? 0;
}

/** Parcels the rule applies to: not finished, not written off. */
export async function countLive(): Promise<number> {
  return count(liveSql());
}

/** Parcels it is time to ask about. What an hourly run will pick up. */
export async function countDue(at: Date = now()): Promise<number> {
  return count(dueSql(dueCutoffs(at)));
}

/**
 * Parcels the promise has been broken for. Red on the Settings screen, and a
 * line in the daily digest when there are any.
 */
export async function countOverdue(at: Date = now()): Promise<number> {
  return count(overdueSql(at));
}
