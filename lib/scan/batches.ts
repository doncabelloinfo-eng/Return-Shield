import { sql as raw } from 'drizzle-orm';
import { getDb, rowsOf } from '@/db';
import { now, HOUR } from '@/lib/clock';
import { parseCorreosCode } from './codes';
import {
  MATCH_COLUMNS, matchForCode, matchLateral, resolveMatch, type MatchColumns,
} from './match';
import {
  scanLabel, summarise, type Batch, type BatchSummary, type ScanItem,
} from './items';
import type { ScanDirection, ScanSource } from './model';

/**
 * A batch: one pile of parcels, worked through by one person in one direction.
 *
 * THE PHONE OWNS NOTHING IMPORTANT. Every scan is written to IndexedDB and then
 * sent here, and this is the list the worker sees when the app is opened again —
 * so a phone that runs out of battery mid-pile loses a screen, not a pile. The
 * resume is a plain read of the open batch.
 *
 * AND A RETRY IS FREE. Each read carries an id the phone made, and `read_ids`
 * records which of them have been counted, so sending the same read twice
 * changes nothing. Without that, the retry a weak warehouse signal forces would
 * turn an ordinary scan into "scanned twice" and the counts the operator reads
 * would be wrong. See db/schema.ts.
 */

interface ScanRow extends MatchColumns {
  id: string;
  code_as_read: string;
  base: string;
  parcel_no: string | null;
  postal_code: string | null;
  source: ScanSource;
  scanned_at: string;
  times_read: number | string;
}

interface BatchRow {
  id: string;
  direction: ScanDirection;
  started_at: string;
  finished_at: string | null;
}

function toItem(r: ScanRow): ScanItem {
  const answer = resolveMatch(r);
  return {
    id: r.id,
    codeAsRead: r.code_as_read,
    base: r.base,
    parcelNo: r.parcel_no,
    postalCode: r.postal_code,
    source: r.source,
    scannedAt: new Date(r.scanned_at).toISOString(),
    timesRead: Number(r.times_read),
    label: answer.match ? scanLabel(answer.match) : null,
    sharing: answer.sharing,
    shipmentId: answer.match?.shipmentId ?? null,
  };
}

/** Newest first, which is the order the phone draws them in. */
async function itemsOf(batchId: string): Promise<ScanItem[]> {
  const result = await getDb().execute(raw`
    SELECT sc.id, sc.code_as_read, sc.base, sc.parcel_no, sc.postal_code,
           sc.source, sc.scanned_at, sc.times_read,
           ${MATCH_COLUMNS}
      FROM scans sc
      ${matchLateral('sc')}
     WHERE sc.batch_id = ${batchId}
     ORDER BY sc.scanned_at DESC, sc.id DESC
  `);
  return rowsOf<ScanRow>(result).map(toItem);
}

/**
 * The open batch for this worker and direction, opened if there is not one.
 *
 * `ON CONFLICT` against the partial unique index rather than "select, then
 * insert if nothing": two phones, or one phone retrying, would otherwise both
 * see nothing and both insert, and the pile would be split across two batches
 * whose counts each look wrong.
 */
export async function openBatch(userId: string, direction: ScanDirection): Promise<Batch> {
  /*
   * Bounded rather than recursive. The conflict firing means a batch existed,
   * and it can only have gone if it was finished between the two statements —
   * once, in practice, never twice. A `while (true)` here would be one bad
   * predicate away from a request that never answers.
   */
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const inserted = await getDb().execute(raw`
      INSERT INTO scan_batches (direction, user_id, started_at)
      VALUES (${direction}, ${userId}, ${now().toISOString()}::timestamptz)
      ON CONFLICT (user_id, direction) WHERE finished_at IS NULL DO NOTHING
      RETURNING id, direction, started_at, finished_at
    `);

    const fresh = rowsOf<BatchRow>(inserted)[0];
    if (fresh) {
      return {
        id: fresh.id,
        direction: fresh.direction,
        startedAt: new Date(fresh.started_at).toISOString(),
        finishedAt: null,
        items: [],
      };
    }

    const existing = await currentBatch(userId, direction);
    if (existing) return existing;
  }

  throw new Error('Could not open a batch: one kept being finished underneath it.');
}

/** The open batch and everything in it, or null when there is none. */
export async function currentBatch(
  userId: string,
  direction: ScanDirection,
): Promise<Batch | null> {
  const result = await getDb().execute(raw`
    SELECT id, direction, started_at, finished_at
      FROM scan_batches
     WHERE user_id = ${userId} AND direction = ${direction} AND finished_at IS NULL
     LIMIT 1
  `);

  const row = rowsOf<BatchRow>(result)[0];
  if (!row) return null;

  return {
    id: row.id,
    direction: row.direction,
    startedAt: new Date(row.started_at).toISOString(),
    finishedAt: null,
    items: await itemsOf(row.id),
  };
}

/** Every open batch this worker has, so switching direction can warn. */
export interface OpenBatchLine {
  id: string;
  direction: ScanDirection;
  startedAt: string;
  scans: number;
}

export async function openBatches(userId: string): Promise<OpenBatchLine[]> {
  const result = await getDb().execute(raw`
    SELECT b.id, b.direction, b.started_at,
           (SELECT count(*)::int FROM scans s WHERE s.batch_id = b.id) AS scans
      FROM scan_batches b
     WHERE b.user_id = ${userId} AND b.finished_at IS NULL
     ORDER BY b.started_at
  `);

  type Row = { id: string; direction: ScanDirection; started_at: string; scans: number | string };
  return rowsOf<Row>(result).map((r) => ({
    id: r.id,
    direction: r.direction,
    startedAt: new Date(r.started_at).toISOString(),
    scans: Number(r.scans),
  }));
}

/**
 * When a scan happened, according to the phone, within reason.
 *
 * The phone's own time is used because it is what the worker saw and because
 * it keeps a pile in the order it was worked: a batch that sat in IndexedDB
 * waiting for a signal and then flushed all at once would otherwise arrive with
 * every scan stamped the same second, and "newest first" would mean nothing.
 *
 * Twelve hours of slack either way, and anything outside that is the server's
 * clock. A phone is wrong by seconds or by years — a factory-reset handset says
 * 1970 — and a scan stamped 1970 would be deleted by the ninety-day cleanup
 * before the worker put the parcel down.
 */
export const CLOCK_SLACK_MS = 12 * HOUR;

export function stampFor(sent: string | undefined, at: Date = now()): Date {
  if (!sent) return at;
  const when = new Date(sent);
  if (Number.isNaN(when.getTime())) return at;
  if (Math.abs(when.getTime() - at.getTime()) > CLOCK_SLACK_MS) return at;
  return when;
}

export interface AddScanInput {
  batchId: string;
  /** The id the phone gave this read. The same one on every retry. */
  readId: string;
  /** Whatever came off the camera or the keyboard. */
  code: string;
  source: ScanSource;
  /** The phone's clock, ISO. Clamped by `stampFor`. */
  at?: string;
}

export type AddScanResult =
  | {
    ok: true;
    item: ScanItem;
    /** True when this code was already in the batch. */
    duplicate: boolean;
    /** False when this exact read had already been counted — a retry. */
    counted: boolean;
  }
  | { ok: false; error: string };

/**
 * Store one read.
 *
 * ONE STATEMENT DOES THE WHOLE THING, including the duplicate and the retry.
 * The unique index on (batch_id, code_as_read) is what makes the same code
 * twice one row; `read_ids` is what makes the same READ twice no change at all.
 * Doing it in two statements — look, then write — would let two reads of the
 * same parcel from a phone with a stuttering connection both decide they were
 * the first.
 *
 * THE DUPLICATE RULE IS THE CODE EXACTLY AS READ. Not the 15-character base:
 * a multi-parcel shipment prints one EXPEDICIÓN and a Código de Bulto per box,
 * so two boxes of one shipment share a base and are two parcels. Treating them
 * as one would lose a parcel that really did leave the warehouse, which is
 * worse than the opposite mistake — scanning a label and then typing the other
 * number off the same label gives two rows, both visible in the list, either
 * removable with the ×.
 */
export async function addScan(
  userId: string,
  input: AddScanInput,
): Promise<AddScanResult> {
  const code = parseCorreosCode(input.code);
  if (!code) return { ok: false, error: 'That is not a Correos number.' };
  if (!input.readId) return { ok: false, error: 'This read has no id.' };

  const batch = await batchFor(userId, input.batchId);
  if (!batch) return { ok: false, error: 'No such batch.' };

  // At scan time, so the order number and shop are COPIED onto the scan and a
  // matched return stays "From Return Shield" after the thirty-day cleanup has
  // removed the parcel. The live match is worked out again on every read.
  const copy = await matchForCode(code);
  const stamp = stampFor(input.at);

  const result = await getDb().execute(raw`
    INSERT INTO scans (
      batch_id, direction, user_id, scanned_at,
      code_as_read, base, parcel_no, postal_code, source,
      read_ids, times_read, order_number, store_name
    )
    VALUES (
      ${batch.id}, ${batch.direction}, ${userId}, ${stamp.toISOString()}::timestamptz,
      ${code.raw}, ${code.base}, ${code.parcelNo}, ${code.postalCode}, ${input.source},
      ARRAY[${input.readId}]::text[], 1,
      ${copy.match?.orderNumber ?? null}, ${copy.match?.storeName ?? null}
    )
    ON CONFLICT (batch_id, code_as_read) DO UPDATE
       SET read_ids = scans.read_ids || ${input.readId}::text,
           times_read = cardinality(scans.read_ids) + 1
     WHERE NOT (${input.readId}::text = ANY (scans.read_ids))
    RETURNING id, (xmax = 0) AS inserted
  `);

  const written = rowsOf<{ id: string; inserted: boolean }>(result)[0];

  /*
   * No row came back, so the WHERE on the DO UPDATE refused it: this exact read
   * has already been counted. A retry, and the honest answer is the row as it
   * already stands.
   */
  if (!written) {
    const item = await itemByCode(batch.id, code.raw);
    if (!item) return { ok: false, error: 'That scan could not be read back.' };
    return { ok: true, item, duplicate: item.timesRead > 1, counted: false };
  }

  const item = await itemById(written.id);
  if (!item) return { ok: false, error: 'That scan could not be read back.' };
  return { ok: true, item, duplicate: !written.inserted, counted: true };
}

async function batchFor(userId: string, batchId: string): Promise<BatchRow | null> {
  /*
   * A FINISHED BATCH STILL ACCEPTS A SCAN, and that is deliberate.
   *
   * "Finish batch" waits until the queue is empty, so this should not happen —
   * but if the app was killed with a read still unsent and the batch was
   * finished from somewhere else, the read is a parcel that really was scanned.
   * It belongs in the batch it was taken in. A rejection here would be the one
   * way a scan gets lost, and "beep means it is saved" has to stay true.
   */
  const result = await getDb().execute(raw`
    SELECT id, direction, started_at, finished_at
      FROM scan_batches
     WHERE id = ${batchId} AND user_id = ${userId}
     LIMIT 1
  `);
  return rowsOf<BatchRow>(result)[0] ?? null;
}

async function itemById(id: string): Promise<ScanItem | null> {
  const result = await getDb().execute(raw`
    SELECT sc.id, sc.code_as_read, sc.base, sc.parcel_no, sc.postal_code,
           sc.source, sc.scanned_at, sc.times_read,
           ${MATCH_COLUMNS}
      FROM scans sc
      ${matchLateral('sc')}
     WHERE sc.id = ${id}
     LIMIT 1
  `);
  const row = rowsOf<ScanRow>(result)[0];
  return row ? toItem(row) : null;
}

async function itemByCode(batchId: string, code: string): Promise<ScanItem | null> {
  const result = await getDb().execute(raw`
    SELECT sc.id, sc.code_as_read, sc.base, sc.parcel_no, sc.postal_code,
           sc.source, sc.scanned_at, sc.times_read,
           ${MATCH_COLUMNS}
      FROM scans sc
      ${matchLateral('sc')}
     WHERE sc.batch_id = ${batchId} AND sc.code_as_read = ${code}
     LIMIT 1
  `);
  const row = rowsOf<ScanRow>(result)[0];
  return row ? toItem(row) : null;
}

/**
 * The × on a row. No dialog, by the operator's own instruction, so it has to be
 * cheap to undo — which it is: scan the parcel again.
 *
 * Fenced to the worker's own batches. Anyone who can reach this endpoint can
 * send any id, and without the fence one phone could empty another's pile.
 */
export async function removeScan(userId: string, scanId: string): Promise<boolean> {
  const result = await getDb().execute(raw`
    DELETE FROM scans
     WHERE id = ${scanId}
       AND batch_id IN (SELECT id FROM scan_batches WHERE user_id = ${userId})
    RETURNING id
  `);
  return rowsOf<{ id: string }>(result).length > 0;
}

export interface FinishedBatch {
  batch: Batch;
  summary: BatchSummary;
}

/**
 * Close the pile and give back the numbers.
 *
 * Idempotent: a batch already finished keeps the time it was finished and
 * answers with the same summary, because the button is on a phone and a phone
 * double-taps.
 */
export async function finishBatch(
  userId: string,
  batchId: string,
): Promise<FinishedBatch | null> {
  const result = await getDb().execute(raw`
    UPDATE scan_batches
       SET finished_at = ${now().toISOString()}::timestamptz
     WHERE id = ${batchId} AND user_id = ${userId} AND finished_at IS NULL
    RETURNING id, direction, started_at, finished_at
  `);

  const closed = rowsOf<BatchRow>(result)[0] ?? await batchFor(userId, batchId);
  if (!closed) return null;

  const items = await itemsOf(closed.id);
  return {
    batch: {
      id: closed.id,
      direction: closed.direction,
      startedAt: new Date(closed.started_at).toISOString(),
      finishedAt: closed.finished_at ? new Date(closed.finished_at).toISOString() : null,
      items,
    },
    summary: summarise(items),
  };
}

/** For image 8: the counts, without closing anything. */
export async function previewBatch(
  userId: string,
  batchId: string,
): Promise<FinishedBatch | null> {
  const batch = await batchFor(userId, batchId);
  if (!batch) return null;

  const items = await itemsOf(batch.id);
  return {
    batch: {
      id: batch.id,
      direction: batch.direction,
      startedAt: new Date(batch.started_at).toISOString(),
      finishedAt: batch.finished_at ? new Date(batch.finished_at).toISOString() : null,
      items,
    },
    summary: summarise(items),
  };
}
