import { sql as raw } from 'drizzle-orm';
import { getDb, rowsOf, at as ts } from '@/db';
import { matchCorreosEvent } from '@/lib/carriers/correos/state-map';
import { now } from '@/lib/clock';
import { say } from '@/lib/activity';
import { reproject } from './repo';
import { settleHistory } from './ingest';

/**
 * Re-apply the state map to events that are already stored.
 *
 * Every payload Correos ever sent is kept exactly as it arrived, and the
 * projection is pure — which is what makes "fix the mapping and replay" a real
 * option rather than a hope. This is that replay, and it runs at the start of
 * every sweep so a mapping added in a deploy takes effect on the parcels that
 * are already sitting in the wrong place, rather than at their next event.
 *
 * Without it, adding "Finalizado plazo retirada" would move only the parcels
 * that happen to get another event afterwards — and a parcel whose window has
 * closed is precisely one Correos has nothing more to say about.
 *
 * THE WORK IS KEYED ON DISTINCT (code, wording, phase) TRIPLES, not on rows.
 * Correos sends a few dozen distinct events across tens of thousands of rows,
 * so one grouped scan finds everything that could possibly change, and the
 * normal case — nothing changed since the last sweep — costs one query.
 *
 * It only ever writes a mapping it can derive. A triple that now matches
 * nothing leaves its stored `mapped_state` alone: deleting a mapping is not
 * something anybody has done, and un-mapping live parcels on the strength of
 * an edit nobody intended is a worse failure than a stale label.
 */

export interface RemapOutcome {
  /** Distinct (code, wording, phase) triples examined. */
  triples: number;
  /** Event rows whose mapped state changed. */
  events: number;
  /** Parcels re-projected because one of their events changed meaning. */
  parcels: number;
  /** Parcels that came out of the re-projection in a different state. */
  moved: number;
  /** Review-queue rows the current map now answers, as "CODE → state". */
  resolved: string[];
}

interface TripleRow {
  event_code: string;
  event_desc: string;
  phase: string | null;
  mapped_state: string | null;
}

export async function remapKnownEvents(): Promise<RemapOutcome> {
  const out: RemapOutcome = { triples: 0, events: 0, parcels: 0, moved: 0, resolved: [] };

  // `phaseDes` is trackpub v2's spelling and `phase` the push feed's; neither
  // is a column, because nothing but the mapper has ever needed it. They live
  // on the stored payload, which is the whole point of storing it.
  const groups = await getDb().execute(raw`
    SELECT event_code,
           event_desc,
           COALESCE(raw_payload->>'phaseDes', raw_payload->>'phase') AS phase,
           mapped_state
      FROM shipment_events
     GROUP BY 1, 2, 3, 4
  `);

  const triples = rowsOf<TripleRow>(groups);
  out.triples = triples.length;

  /** Parcels to re-project once, however many of their events changed. */
  const touched = new Set<string>();

  for (const t of triples) {
    const match = matchCorreosEvent(t.event_code, t.event_desc, t.phase);
    if (!match) continue;
    if (match.state === t.mapped_state) continue;

    // `IS NOT DISTINCT FROM` on both the phase and the old state: a null phase
    // and a null mapping are ordinary values here, and `= NULL` would match no
    // rows at all and silently do nothing.
    const updated = await getDb().execute(raw`
      UPDATE shipment_events
         SET mapped_state = ${match.state}
       WHERE event_code = ${t.event_code}
         AND event_desc = ${t.event_desc}
         AND COALESCE(raw_payload->>'phaseDes', raw_payload->>'phase')
               IS NOT DISTINCT FROM ${t.phase}
         AND mapped_state IS NOT DISTINCT FROM ${t.mapped_state}
      RETURNING shipment_id
    `);

    const rows = rowsOf<{ shipment_id: string }>(updated);
    out.events += rows.length;
    for (const r of rows) touched.add(r.shipment_id);

    // Only a code or a wording answers the review queue. A phase match is
    // still a parcel moving on a guess, which is exactly what the queue is
    // for, so those rows stay open.
    if (match.via !== 'phase') {
      const resolved = await resolveReview(t.event_code, t.event_desc, match.state);
      if (resolved) out.resolved.push(`${t.event_code} → ${match.state}`);
    }
  }

  for (const id of touched) {
    const before = rowsOf<{ state: string }>(await getDb().execute(raw`
      SELECT state FROM shipments WHERE id = ${id}
    `))[0];

    const after = await reproject(id);
    out.parcels += 1;
    if (!before || after.state === before.state) continue;

    out.moved += 1;
    /*
     * The parcel's past just arrived, even though the event did not: we have
     * had the row for days and only now understand it. `settleHistory` is
     * written for exactly that — it gives a parcel that still needs a person
     * the step it needs today and marks the reminders that were due while we
     * were not looking as fired, and gives a parcel that turns out to have
     * finished nothing at all.
     *
     * Firing the whole ladder instead would send a customer four reminders at
     * once about a parcel Correos has already sent back.
     */
    await settleHistory(id);
  }

  if (out.moved > 0) {
    await say(
      `Correos wordings updated — ${out.moved} ${out.moved === 1 ? 'parcel' : 'parcels'} moved to where they belong`,
    );
  }

  return out;
}

/**
 * Mark a review-queue row answered, and record what answered it.
 *
 * `resolved_as` carries the state rather than a tick, so the Settings screen
 * can show which wording became which state — and, for a wording mapped
 * without its code, the row keeps the real code Correos sent. That is how the
 * code gets into `BY_CODE` next time: read off a resolved row, not guessed.
 */
async function resolveReview(
  eventCode: string, eventDesc: string, state: string,
): Promise<boolean> {
  const rows = await getDb().execute(raw`
    UPDATE event_review_queue
       SET resolved_at = ${ts(now())},
           resolved_as = ${state}
     WHERE event_code = ${eventCode}
       AND event_desc = ${eventDesc}
       AND resolved_at IS NULL
    RETURNING id
  `);
  return rowsOf<{ id: string }>(rows).length > 0;
}
