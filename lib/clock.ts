/**
 * Every escalation decision reads the time from here and nowhere else.
 *
 * That buys two things the prototype had and production must keep:
 *   · the whole fifteen-day ladder can be driven end to end in a test, in
 *     milliseconds, instead of waiting fifteen real days;
 *   · the demo survives, so the system can still be shown to someone without
 *     pointing it at real customers.
 *
 * In production the provider is the system clock and nothing can change it.
 * `setClock` throws unless we are in a test or DEMO_MODE is on, so a stray
 * import can never hand a running business a time machine.
 */

export type NowFn = () => Date;

const systemNow: NowFn = () => new Date();
let provider: NowFn = systemNow;

function mayOverride(): boolean {
  return process.env.NODE_ENV === 'test'
    || process.env.VITEST === 'true'
    || process.env.DEMO_MODE === '1';
}

export function now(): Date {
  return provider();
}

/** Milliseconds since the epoch, for arithmetic that does not need a Date. */
export function nowMs(): number {
  return provider().getTime();
}

export function setClock(fn: NowFn): void {
  if (!mayOverride()) {
    throw new Error(
      'lib/clock: the clock can only be moved in tests or with DEMO_MODE=1. '
      + 'Something in production tried to change what time it is.',
    );
  }
  provider = fn;
}

export function resetClock(): void {
  provider = systemNow;
}

export function isClockOverridden(): boolean {
  return provider !== systemNow;
}

/**
 * A clock a test can drive. `advance` moves it and returns the new time, so a
 * test reads as a sequence of "and then, two days later...".
 */
export class TestClock {
  private t: number;

  constructor(start: Date | string | number = '2026-09-01T06:00:00.000Z') {
    this.t = new Date(start).getTime();
  }

  now = (): Date => new Date(this.t);

  advanceMs(ms: number): Date {
    this.t += ms;
    return this.now();
  }

  advanceMinutes(m: number): Date { return this.advanceMs(m * 60_000); }
  advanceHours(h: number): Date { return this.advanceMs(h * 3_600_000); }
  advanceDays(d: number): Date { return this.advanceMs(d * 86_400_000); }
  set(at: Date | string | number): Date { this.t = new Date(at).getTime(); return this.now(); }

  /** Install as the global provider and hand back the undo. */
  install(): () => void {
    setClock(this.now);
    return () => resetClock();
  }
}

export const MINUTE = 60_000;
export const HOUR = 3_600_000;
export const DAY = 86_400_000;
