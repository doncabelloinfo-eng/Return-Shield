import { and, eq, inArray, sql as raw } from 'drizzle-orm';
import { getDb } from '@/db';
import { tasks } from '@/db/schema';
import { now } from '@/lib/clock';
import type { TaskType } from './decide';

/**
 * Tasks are the system's way of saying "this one needs a person".
 *
 * There is at most one open task of each type per shipment, enforced by a
 * partial unique index. Two "call them" rows are not more information, they
 * are the same job listed twice — and a call list that double-counts is a call
 * list nobody trusts.
 */

export interface OpenTaskSpec {
  shipmentId: string;
  type: TaskType;
  reason: string;
  label: string;
  dueAt?: Date | null;
  priority?: number;
}

/**
 * Open a task, or refresh the one already open. Idempotent by design.
 *
 * Returns whether this call actually opened something new, so a caller that
 * announces the task in the activity feed can announce it once rather than on
 * every tick that finds the same work still outstanding.
 */
export async function openTask(spec: OpenTaskSpec): Promise<'opened' | 'refreshed'> {
  const [row] = await getDb().insert(tasks)
    .values({
      shipmentId: spec.shipmentId,
      type: spec.type,
      reason: spec.reason,
      label: spec.label,
      dueAt: spec.dueAt ?? null,
      priority: spec.priority ?? 0,
      status: 'open',
      createdAt: now(),
    })
    .onConflictDoUpdate({
      target: [tasks.shipmentId, tasks.type],
      targetWhere: eq(tasks.status, 'open'),
      // The newest reason for the task wins: "no answer yesterday" replaces
      // "a day since nobody was home" rather than sitting alongside it.
      set: { reason: spec.reason, label: spec.label, dueAt: spec.dueAt ?? null },
    })
    // `xmax = 0` is true only for a row this statement INSERTed; an upsert that
    // took the UPDATE path leaves the previous transaction's id there. It is
    // the only way to learn which path a single upsert took.
    //
    // This used to be a SELECT taken before the write, which under concurrency
    // meant two runs could both read "nothing open" and both report that they
    // had opened it. The index already stopped the duplicate ROW; what it could
    // not stop was two runs each announcing it in the activity feed and each
    // counting it in the job's tally.
    .returning({ fresh: raw<boolean>`(xmax = 0)` });

  return row?.fresh ? 'opened' : 'refreshed';
}

/** Close every open task of the given types. No types means all of them. */
export async function closeTasks(
  shipmentId: string,
  types?: readonly TaskType[],
  outcome?: { outcome?: string; note?: string; userId?: string },
): Promise<void> {
  const where = types && types.length
    ? and(eq(tasks.shipmentId, shipmentId), eq(tasks.status, 'open'), inArray(tasks.type, types as TaskType[]))
    : and(eq(tasks.shipmentId, shipmentId), eq(tasks.status, 'open'));

  await getDb().update(tasks).set({
    status: 'done',
    closedAt: now(),
    outcome: outcome?.outcome ?? null,
    outcomeNote: outcome?.note ?? null,
    closedBy: outcome?.userId ?? null,
  }).where(where);
}

export async function openTasksFor(shipmentId: string) {
  return getDb().select().from(tasks)
    .where(and(eq(tasks.shipmentId, shipmentId), eq(tasks.status, 'open')));
}
