import { now, SECOND } from '@/lib/clock';
import { getSetting, setSetting, type SweepProgress } from '@/lib/settings';

export type { SweepProgress };

/**
 * What the sweep running right now has got through.
 *
 * The operator wanted to watch a refresh happen rather than look at a button
 * that says "Asking Correos…" for two minutes. So the sweep writes a row as it
 * goes, a small authenticated route reads it, and the browser polls that route
 * every second and a half.
 *
 * IN `settings`, NOT A TABLE OF ITS OWN. It is one row, overwritten in place,
 * never queried across and never kept — so a table would buy nothing and cost
 * a migration run against a fork somebody has to click Sync on. If a second
 * sweep ever needed its own row this would have to change; it cannot, because
 * the `job_locks` row means only one sweep exists at a time.
 *
 * It is also what makes the HOURLY CRON visible. The cron writes the same row
 * from a different serverless instance, so anyone with the app open sees the
 * automatic check happen — which is the only way the operator can tell the
 * difference between "the engine is quiet" and "the engine is dead", without
 * reading a job_runs table.
 */

/** Two seconds, so a two-minute sweep writes about sixty rows, not six thousand. */
export const PROGRESS_WRITE_EVERY_MS = 2 * SECOND;

/**
 * How long a finished run stays on screen.
 *
 * The final line is the answer to "what did that do", and a bar that vanishes
 * the instant it completes never gets read.
 */
export const PROGRESS_LINGER_MS = 90 * SECOND;

/**
 * A row this old is from a run that died rather than one still going.
 *
 * Serverless instances are killed. A sweep cut off mid-flight leaves a row
 * saying `done: false` for ever, and a progress bar that sits at 54% until
 * somebody restarts something is worse than no progress bar. Three write
 * intervals, so an ordinary slow write does not read as death.
 */
export const PROGRESS_STALE_AFTER_MS = 6 * PROGRESS_WRITE_EVERY_MS;

export type ProgressState = 'running' | 'finished' | 'abandoned' | 'none';

export interface ProgressView extends SweepProgress {
  state: ProgressState;
  /** Still worth drawing. False once a finished run has been on screen a while. */
  show: boolean;
  /** Parcels still to check. */
  left: number;
  /** Whole seconds the run has been going, or took. */
  seconds: number;
  /** Rough seconds remaining, or null when there is nothing to go on. */
  secondsLeft: number | null;
  /** "Checking with Correos" / "Automatic check". */
  label: string;
}

/**
 * Start a run's progress row.
 *
 * Written before the first request so the bar appears at 0 of 201 rather than
 * materialising a third of the way through.
 */
export async function startProgress(
  opts: { total: number; manual: boolean; at?: Date },
): Promise<SweepProgress> {
  const iso = (opts.at ?? now()).toISOString();
  const row: SweepProgress = {
    total: opts.total,
    checked: 0,
    changed: 0,
    startedAt: iso,
    updatedAt: iso,
    manual: opts.manual,
    done: false,
  };
  await setSetting('sweepProgress', row);
  return row;
}

/**
 * A throttled writer, so the sweep's own progress does not become its cost.
 *
 * Returns a function the loop calls as often as it likes; it writes at most
 * every `PROGRESS_WRITE_EVERY_MS`, and `{ force: true }` makes it write
 * regardless — which the final line always does.
 *
 * `Date.now()`, not the injectable clock, for the throttle: this is about how
 * often a database write happens, and a test that moves the clock forward a
 * fortnight must not make every call a write.
 */
export function progressWriter(row: SweepProgress) {
  let lastWrite = 0;

  return async function write(
    update: { checked: number; changed: number; done?: boolean; stoppedEarly?: string; tookMs?: number },
    opts: { force?: boolean; at?: Date } = {},
  ): Promise<void> {
    /*
     * `updatedAt` is the moment of THIS write, not the run's start.
     *
     * It is read for two things and both break if it never moves: how fast the
     * sweep is going, which is what "about a minute left" comes from, and
     * whether the run is still alive — a row nobody has written to for twelve
     * seconds is a killed instance, and a stamp frozen at the start would make
     * every sweep longer than that read as dead.
     */
    const elapsed = Date.now() - lastWrite;
    if (!opts.force && elapsed < PROGRESS_WRITE_EVERY_MS) return;
    lastWrite = Date.now();

    await setSetting('sweepProgress', {
      ...row,
      checked: update.checked,
      changed: update.changed,
      done: update.done ?? false,
      updatedAt: (opts.at ?? now()).toISOString(),
      ...(update.stoppedEarly ? { stoppedEarly: update.stoppedEarly } : {}),
      ...(update.tookMs !== undefined ? { tookMs: update.tookMs } : {}),
    });
  };
}

/** The row, or null when nothing has ever run. One read, by design. */
export async function readProgress(): Promise<SweepProgress | null> {
  return getSetting('sweepProgress');
}

/**
 * The row turned into everything the bar needs, so the client does no
 * arithmetic and the two callers cannot disagree about what "left" means.
 */
export function viewProgress(row: SweepProgress | null, at: Date = now()): ProgressView | null {
  if (!row) return null;

  const started = Date.parse(row.startedAt);
  const updated = Date.parse(row.updatedAt);
  if (!Number.isFinite(started) || !Number.isFinite(updated)) return null;

  const sinceUpdate = at.getTime() - updated;
  const state: ProgressState = row.done
    ? 'finished'
    : (sinceUpdate > PROGRESS_STALE_AFTER_MS ? 'abandoned' : 'running');

  const elapsedMs = row.done && row.tookMs !== undefined
    ? row.tookMs
    : Math.max(0, updated - started);

  const left = Math.max(0, row.total - row.checked);
  const perSecond = elapsedMs > 0 ? row.checked / (elapsedMs / 1000) : 0;

  return {
    ...row,
    state,
    // A finished run lingers; an abandoned one is dropped rather than left
    // sitting at 54% for ever.
    show: state === 'running'
      || (state === 'finished' && at.getTime() - updated < PROGRESS_LINGER_MS),
    left,
    seconds: Math.round(elapsedMs / 1000),
    secondsLeft: state === 'running' && perSecond > 0 && left > 0
      ? Math.round(left / perSecond)
      : null,
    label: row.manual ? 'Checking with Correos' : 'Automatic check',
  };
}

/**
 * The sentence under the bar.
 *
 * "Checking with Correos: 87 of 201 · 12 changed · 114 left · about 1 minute
 * left" while it runs, and the final count once it stops.
 */
export function progressLine(v: ProgressView): string {
  if (v.state === 'finished') {
    const parts = [`Checked ${v.checked.toLocaleString('en-GB')}`];
    if (v.stoppedEarly) parts[0] = `Checked ${v.checked.toLocaleString('en-GB')} of ${v.total.toLocaleString('en-GB')}`;
    parts.push(`${v.changed.toLocaleString('en-GB')} changed`);
    parts.push(`${v.left.toLocaleString('en-GB')} left`);
    if (v.stoppedEarly) parts.push('the next check continues from here');
    else parts.push(duration(v.seconds));
    return parts.join(' · ');
  }

  const parts = [
    `${v.label}: ${v.checked.toLocaleString('en-GB')} of ${v.total.toLocaleString('en-GB')}`,
    `${v.changed.toLocaleString('en-GB')} changed`,
    `${v.left.toLocaleString('en-GB')} left`,
  ];
  if (v.secondsLeft !== null) parts.push(`about ${roughly(v.secondsLeft)} left`);
  return parts.join(' · ');
}

/** "1 min 54 s" — a duration somebody reads once and does not need precision from. */
export function duration(seconds: number): string {
  if (seconds < 60) return `${seconds} s`;
  const mins = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest ? `${mins} min ${rest} s` : `${mins} min`;
}

/** "about 1 minute left" — rounded, because a precise estimate is a lie. */
export function roughly(seconds: number): string {
  if (seconds < 20) return 'a few seconds';
  if (seconds < 90) return 'a minute';
  const mins = Math.round(seconds / 60);
  return `${mins} minutes`;
}
