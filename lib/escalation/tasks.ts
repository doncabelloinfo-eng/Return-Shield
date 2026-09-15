import { and, eq, inArray } from 'drizzle-orm';
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
  const before = await getDb().select({ id: tasks.id }).from(tasks)
    .where(and(eq(tasks.shipmentId, spec.shipmentId), eq(tasks.type, spec.type), eq(tasks.status, 'open')))
    .limit(1);

  await getDb().insert(tasks)
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
    });

  return before.length ? 'refreshed' : 'opened';
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
