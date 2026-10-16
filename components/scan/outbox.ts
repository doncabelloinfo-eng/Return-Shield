import type { ScanDirection, ScanSource } from '@/lib/scan/model';

/**
 * The phone's own copy of every read, in IndexedDB.
 *
 * THIS IS WHY "BEEP MEANS IT IS SAVED" IS TRUE. The warehouse signal is weak in
 * places, and a worker holding a parcel cannot be asked to watch a spinner. So
 * the order is: write the read here, THEN beep, THEN send it — and keep sending
 * it until the server says it has it. A read that is on the phone is a read
 * that is not lost, whatever the wifi does, and whatever happens to the app:
 * the queue is still there when it is opened again.
 *
 * Each read carries an id made here. The server records which ids it has
 * counted, so sending the same read ten times is the same as sending it once —
 * which is what makes retrying safe enough to do blindly. See
 * lib/scan/batches.ts.
 *
 * EVERY CALL IS WRAPPED. IndexedDB throws rather than returning null in a
 * private window, with site data blocked, and on some Android webviews; and it
 * is the kind of thing that fails on one phone in a warehouse of five. When it
 * is not there the queue falls back to memory for the session, so the app still
 * works and the only thing lost is surviving a reload — never a beep that lied.
 */

const DB_NAME = 'return-shield-scanner';
const DB_VERSION = 1;
const STORE = 'outbox';

export interface Outgoing {
  /** The id of this READ. The same on every retry. Primary key. */
  readId: string;
  /** Null until the server has given this phone a batch to put it in. */
  batchId: string | null;
  direction: ScanDirection;
  /** The code as the camera or the keyboard gave it. */
  code: string;
  source: ScanSource;
  /** The phone's clock when it was read, ISO. */
  at: string;
  /** How many times we have tried to send it. Shown to nobody; used to back off. */
  tries: number;
}

/** The fallback when IndexedDB is not usable. Per-tab, and that is understood. */
const memory = new Map<string, Outgoing>();
let useMemory = false;

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
  });
}

let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  if (useMemory) return Promise.resolve(null);
  if (dbPromise) return dbPromise;

  dbPromise = new Promise<IDBDatabase | null>((resolve) => {
    try {
      if (typeof indexedDB === 'undefined') {
        useMemory = true;
        resolve(null);
        return;
      }

      const open = indexedDB.open(DB_NAME, DB_VERSION);
      open.onupgradeneeded = () => {
        const db = open.result;
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE, { keyPath: 'readId' }).createIndex('direction', 'direction');
        }
      };
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => {
        useMemory = true;
        resolve(null);
      };
      // Safari in a private window can leave the request pending for ever
      // rather than erroring. Five seconds, then memory.
      setTimeout(() => {
        if (open.readyState !== 'done') {
          useMemory = true;
          resolve(null);
        }
      }, 5_000);
    } catch {
      useMemory = true;
      resolve(null);
    }
  });

  return dbPromise;
}

async function withStore<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => Promise<T>,
): Promise<T | null> {
  const db = await openDb();
  if (!db) return null;
  try {
    return await run(db.transaction(STORE, mode).objectStore(STORE));
  } catch {
    return null;
  }
}

/** Put a read in the queue. Called BEFORE the beep. */
export async function queueRead(item: Outgoing): Promise<void> {
  memory.set(item.readId, item);
  await withStore('readwrite', (store) => request(store.put(item)));
}

/** The server has it. Forget it. */
export async function forgetRead(readId: string): Promise<void> {
  memory.delete(readId);
  await withStore('readwrite', (store) => request(store.delete(readId)));
}

/** Everything still unsent, for this direction, oldest first. */
export async function pendingReads(direction: ScanDirection): Promise<Outgoing[]> {
  const stored = await withStore('readonly', (store) => request(store.getAll() as IDBRequest<Outgoing[]>));
  const rows = stored ?? [...memory.values()];
  return rows
    .filter((r) => r.direction === direction)
    .sort((a, b) => a.at.localeCompare(b.at));
}

/** One more try recorded, so a read that keeps failing can be backed off. */
export async function countTry(item: Outgoing): Promise<Outgoing> {
  const next = { ...item, tries: item.tries + 1 };
  await queueRead(next);
  return next;
}

/**
 * A read that was queued before the server had given this phone a batch.
 *
 * It happens on the first scan of a session: the camera is quicker than the
 * round trip that opens the batch, and the beep must not wait for it.
 */
export async function adoptBatch(direction: ScanDirection, batchId: string): Promise<void> {
  for (const item of await pendingReads(direction)) {
    if (item.batchId === null) await queueRead({ ...item, batchId });
  }
}

/** True when IndexedDB was not usable and the queue is memory-only. */
export function queueIsMemoryOnly(): boolean {
  return useMemory;
}
