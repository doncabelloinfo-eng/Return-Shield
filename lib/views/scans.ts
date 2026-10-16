import { sql as raw } from 'drizzle-orm';
import { getDb, retryableRead, rowsOf } from '@/db';
import { exact, shortDate } from '@/lib/time';
import { latestScanLateral } from '@/lib/scan/match';
import { DIRECTION_BADGE, type ScanDirection } from '@/lib/scan/model';

/**
 * What the warehouse did with a parcel, as the panel shows it.
 *
 * The formatter lives here rather than in either screen because both the
 * Parcels list and the parcel page draw the same badge, and a badge that says
 * "16 Oct · 12:20" in one place and "16/10 12:20" in the other is two features.
 */

export interface ScanMark {
  /** "Left the warehouse" or "Back in the warehouse". */
  label: string;
  /** "16 Oct · 12:20", Madrid. */
  when: string;
  exactWhen: string;
  /** The worker who scanned it. */
  worker: string;
}

/**
 * One scan, as a badge. Null when the warehouse never scanned it.
 *
 * THE LATEST SCAN WINS, which is decided by the `ORDER BY ... LIMIT 1` in
 * `latestScanLateral` rather than here: a parcel scanned out, carried back
 * inside and scanned out again left the warehouse at the second attempt, and
 * the first is of no interest to anybody.
 */
export function scanMark(
  at: string | Date | null,
  worker: string | null,
  direction: ScanDirection,
): ScanMark | null {
  if (!at) return null;
  const when = at instanceof Date ? at : new Date(at);
  if (!Number.isFinite(when.getTime())) return null;

  return {
    label: DIRECTION_BADGE[direction],
    // The same shape as the Correos event beside it, so the two read as one
    // timeline rather than as two different kinds of date.
    when: `${shortDate(when)} · ${exact(when).split(', ')[1] ?? ''}`,
    exactWhen: exact(when),
    worker: worker ?? '',
  };
}

export interface ParcelScans {
  left: ScanMark | null;
  back: ScanMark | null;
}

interface ScanRow {
  out_at: string | null;
  out_by: string | null;
  back_at: string | null;
  back_by: string | null;
}

/**
 * The two badges for ONE parcel.
 *
 * A query of its own rather than two more LATERALs inside `loadRows`, which
 * the parcel page uses and which reads every parcel in the window to show one.
 * Two index seeks for the parcel being looked at is the whole cost; adding them
 * to that loader would have been two per row of the entire table, on a screen
 * that needs one.
 */
export const parcelScans = retryableRead('parcel scans', async (
  shipmentId: string,
): Promise<ParcelScans> => {
  const result = await getDb().execute(raw`
    SELECT out_scan.scanned_at AS out_at, out_scan.worker AS out_by,
           back_scan.scanned_at AS back_at, back_scan.worker AS back_by
      FROM shipments s
      ${latestScanLateral('outgoing', 'out_scan')}
      ${latestScanLateral('incoming', 'back_scan')}
     WHERE s.id = ${shipmentId}
     LIMIT 1
  `);

  const row = rowsOf<ScanRow>(result)[0];
  if (!row) return { left: null, back: null };

  return {
    left: scanMark(row.out_at, row.out_by, 'outgoing'),
    back: scanMark(row.back_at, row.back_by, 'incoming'),
  };
});
