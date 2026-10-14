import { sql as raw } from 'drizzle-orm';
import { getDb, retryableRead, rowsOf } from '@/db';
import { now } from '@/lib/clock';
import { perRequest } from '@/lib/per-request';
import type { ShipmentState } from '@/lib/state-machine/states';
import { customerLabel } from '@/lib/orders/customer-label';
import {
  actionable, type DecidableShipment, type OpenTask, type TaskType,
} from '@/lib/escalation/decide';

/**
 * "N to do" in the top bar, without loading the whole table to count it.
 *
 * WHAT THIS REPLACED. The panel layout called `loadRows()`, which selects
 * EVERY shipment — delivered, returned, closed, all of it — with no WHERE,
 * then ran two more queries over every id it got back, and built the full row
 * for each: the Spanish office wording, the WhatsApp link, the mailto, the
 * contact line. All of that on every page view of every screen, to produce one
 * integer. It held connections for longer than any other query in the app and
 * it got slower every day the table grew, which is exactly the wrong shape
 * when the whole project has fifteen connections to share.
 *
 * WHAT IT ASKS INSTEAD. One statement, over parcels that could possibly need
 * something doing:
 *
 *   · not closed by hand — `nextAction` returns null for those;
 *   · and either coming back (the stock needs marking), or waiting on a
 *     redirection, or carrying an open task.
 *
 * That set is deliberately a SUPERSET of what counts. SQL prunes the rows that
 * provably cannot be actionable; `actionable()` still makes every decision,
 * including the snooze and the restock. Nothing about the rule lives in two
 * places — which is why the test for this compares it with what Today itself
 * lists rather than with a number somebody typed.
 */

interface RawTodoRow {
  id: string;
  state: string;
  office_arrived_at: string | null;
  muted_until: string | null;
  dropped_at: string | null;
  restocked_at: string | null;
  redirect_pending: boolean;
  customer_name: string;
  order_number: string;
  total_value_cents: number;
  payment_method: 'prepaid' | 'cod';
  city: string | null;
  store_platform: string;
  office_name: string | null;
  tasks: { type: string; reason: string | null; label: string | null }[] | null;
}

async function load(): Promise<DecidableShipment[]> {
  const result = await getDb().execute(raw`
    SELECT s.id, s.state, s.office_arrived_at, s.muted_until, s.dropped_at,
           s.restocked_at, s.redirect_pending,
           o.customer_name, o.order_number, o.total_value_cents, o.payment_method, o.city,
           st.platform AS store_platform,
           of.name AS office_name,
           t.tasks
      FROM shipments s
      JOIN orders o ON o.id = s.order_id
      JOIN stores st ON st.id = o.store_id
      LEFT JOIN offices of ON of.id = s.office_id
      LEFT JOIN LATERAL (
        SELECT json_agg(json_build_object(
                 'type', k.type, 'reason', k.reason, 'label', k.label
               )) AS tasks
          FROM tasks k
         WHERE k.shipment_id = s.id AND k.status = 'open'
      ) t ON true
     WHERE s.dropped_at IS NULL
       AND (
         s.state IN ('returning', 'returned', 'refused')
         OR s.redirect_pending
         OR t.tasks IS NOT NULL
       )
  `);

  return rowsOf<RawTodoRow>(result).map((r) => ({
    id: r.id,
    state: r.state as ShipmentState,
    officeArrivedAt: r.office_arrived_at ? new Date(r.office_arrived_at) : null,
    officeName: r.office_name,
    town: r.city ?? '',
    customerName: customerLabel({
      customerName: r.customer_name,
      orderNumber: r.order_number,
      platform: r.store_platform,
    }),
    valueCents: Number(r.total_value_cents),
    paymentMethod: r.payment_method,
    dropped: r.dropped_at !== null,
    restocked: r.restocked_at !== null,
    redirectPending: r.redirect_pending,
    mutedUntil: r.muted_until ? new Date(r.muted_until) : null,
    openTasks: (r.tasks ?? []).map((k) => ({
      type: k.type as TaskType,
      reason: k.reason ?? '',
      label: k.label ?? '',
    })) satisfies OpenTask[],
    // Only `priority` reads this, and a count does not need an order.
    lastContactOutcome: null,
  }));
}

/**
 * How many parcels are genuinely waiting on a person.
 *
 * Memoised for the length of one request, not longer. The expensive part was
 * loading the whole table, and that is gone; a cache that outlived the request
 * would trade a top-bar number that is right for one that is up to a minute
 * behind the action the operator just took.
 */
export const todoCount = perRequest(retryableRead('to-do count', async (
  opts: { at?: Date } = {},
): Promise<number> => {
  const at = opts.at ?? now();
  return actionable(await load(), at).length;
}));
