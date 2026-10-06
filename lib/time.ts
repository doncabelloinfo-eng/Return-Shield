import { now, DAY } from './clock';

/**
 * Everything the business reasons about happens in Spanish local time. A
 * deadline is a *day*, not an instant: "last day to pick it up is 16 Sep"
 * means the whole of the 16th in Madrid, whatever the server's TZ is set to.
 *
 * These helpers are the only place that knows that. They are all pure apart
 * from reading the clock, which itself is injectable — so a test can ask what
 * "tomorrow" means on any date, including the two days a year the clocks move.
 */

export const MADRID = 'Europe/Madrid';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
const LONGDAY = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;
/** For messages that go to a Spanish customer. See DECISIONS.md. */
const MONTHS_ES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'] as const;

const partsFmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: MADRID,
  year: 'numeric', month: 'numeric', day: 'numeric',
  hour: '2-digit', minute: '2-digit', weekday: 'short', hour12: false,
});

export interface MadridParts {
  year: number; month: number; day: number;
  hour: number; minute: number; weekday: number;
}

/** Wall-clock fields as a person in Madrid would read them off a clock. */
export function madridParts(at: Date): MadridParts {
  const p = Object.fromEntries(
    partsFmt.formatToParts(at).filter((x) => x.type !== 'literal').map((x) => [x.type, x.value]),
  ) as Record<string, string>;
  const weekday = DAYS.indexOf(p.weekday.slice(0, 3) as typeof DAYS[number]);
  return {
    year: Number(p.year),
    month: Number(p.month),
    day: Number(p.day),
    // 24:00 is midnight at the start of the day in some ICU versions.
    hour: Number(p.hour) % 24,
    minute: Number(p.minute),
    weekday: weekday < 0 ? 0 : weekday,
  };
}

/** "2026-09-16" in Madrid. The identity of a calendar day. */
export function madridDateKey(at: Date): string {
  const p = madridParts(at);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

/**
 * Whole days between two instants, counted as calendar days in Madrid rather
 * than as 86,400,000ms steps. On the night the clocks change, one of those
 * "days" is 23 or 25 hours long and a deadline must not drift by one.
 */
export function madridDaysBetween(from: Date, to: Date): number {
  const a = Date.UTC(...dayTuple(from));
  const b = Date.UTC(...dayTuple(to));
  return Math.round((b - a) / DAY);
}

function dayTuple(at: Date): [number, number, number] {
  const p = madridParts(at);
  return [p.year, p.month - 1, p.day];
}

/**
 * The instant a deposit window runs out: `days` calendar days after arrival,
 * at the end of that day in Madrid. Correos does not send a parcel back at
 * 13:47 because that is when it arrived a fortnight ago — it goes back at the
 * end of its last day. Treating the deadline as an instant would have us
 * warning a customer a day early and marking a live parcel as lost.
 */
export function deadlineFrom(arrivedAt: Date, depositDays: number): Date {
  const p = madridParts(arrivedAt);
  // Add the days to the calendar day itself, not to the instant. Adding
  // 15 x 86,400,000ms across the October clock change lands an hour short and
  // reads as the day before — a parcel written off with a day still on it.
  // Date.UTC normalises the overflow, so day 35 of October is 4 November.
  return endOfMadridDay(p.year, p.month, p.day + depositDays);
}

/** The UTC instant of 00:00 on a given Madrid calendar day. */
export function madridMidnightUtc(year: number, month: number, day: number): Date {
  // Madrid is UTC+1 or UTC+2. Probe both and keep the one that lands on 00:00.
  for (const offsetHours of [1, 2]) {
    const guess = new Date(Date.UTC(year, month - 1, day, 0 - offsetHours, 0, 0, 0));
    const p = madridParts(guess);
    if (p.year === year && p.month === month && p.day === day && p.hour === 0 && p.minute === 0) {
      return guess;
    }
  }
  // The hour 00:00 does not exist on a spring-forward day; take 01:00 instead.
  return new Date(Date.UTC(year, month - 1, day, -1, 0, 0, 0));
}

/** The last instant of a Madrid calendar day (23:59:59.999 local). */
export function endOfMadridDay(year: number, month: number, day: number): Date {
  const nextMidnight = madridMidnightUtc(year, month, day + 1);
  return new Date(nextMidnight.getTime() - 1);
}

/** The instant of hh:mm on a Madrid calendar day. Used to schedule jobs. */
export function madridTimeOnDay(at: Date, hour: number, minute = 0): Date {
  const p = madridParts(at);
  const midnight = madridMidnightUtc(p.year, p.month, p.day);
  return new Date(midnight.getTime() + hour * 3_600_000 + minute * 60_000);
}

/* --------------------------------------------------------------------------
 * Formatting. The operator's screens are in English; the customer's messages
 * and their own page are in Spanish.
 * ------------------------------------------------------------------------ */

export interface Formatted {
  dow: number; day: string; date: string; year: number; time: string;
}

export function fmt(at: Date): Formatted {
  const p = madridParts(at);
  const pad = (n: number) => String(n).padStart(2, '0');
  return {
    dow: p.weekday,
    day: DAYS[p.weekday],
    date: `${pad(p.day)} ${MONTHS[p.month - 1]}`,
    year: p.year,
    time: `${pad(p.hour)}:${pad(p.minute)}`,
  };
}

/** "Mon 16 Sep 2026, 14:05" — the exact time, shown on hover. */
export function exact(at: Date): string {
  const f = fmt(at);
  return `${f.day} ${f.date} ${f.year}, ${f.time}`;
}

/** "16 Sep" — a date a person can read at a glance. */
export function shortDate(at: Date): string {
  return fmt(at).date;
}

/** "16 sep" — the same date for a Spanish reader. */
export function shortDateEs(at: Date): string {
  const p = madridParts(at);
  return `${String(p.day).padStart(2, '0')} ${MONTHS_ES[p.month - 1]}`;
}

/**
 * "today", "tomorrow", "this Thursday", "in 9 days", "3 days ago".
 * Counted in whole Madrid days from the current clock, so a deadline at 23:59
 * tonight reads "today" and not "in 0 days".
 */
export function human(at: Date, from: Date = now()): string {
  const d = madridDaysBetween(from, at);
  if (d === 0) return 'today';
  if (d === 1) return 'tomorrow';
  if (d === -1) return 'yesterday';
  if (d > 1 && d < 7) return `this ${LONGDAY[madridParts(at).weekday]}`;
  if (d >= 7) return `in ${d} days`;
  return `${Math.abs(d)} days ago`;
}

/**
 * Days left before the post office sends it back. Counted in calendar days:
 * a deadline at the end of today is 0 days left, not "0.4".
 */
export function daysLeft(deadline: Date | null | undefined, from: Date = now()): number | null {
  if (!deadline) return null;
  return madridDaysBetween(from, deadline);
}

/**
 * "4 minutes ago", "2 hours ago", "3 days ago".
 *
 * `human()` above answers a different question: it counts whole Madrid
 * calendar days, which is right for a deadline ("goes back this Thursday") and
 * useless for an outage — a 47-minute silence and a 47-second one both come
 * back as "today". This one is for durations.
 */
export function agoInWords(at: Date, from: Date = now()): string {
  const seconds = Math.round((from.getTime() - at.getTime()) / 1000);
  if (seconds < 0) return 'just now';
  if (seconds < 60) return 'less than a minute ago';

  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;

  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;

  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

/* ---------------------------------------------------------------- working days */

/**
 * Working days, for "how long has this been stuck".
 *
 * Correos does not admit parcels at the weekend and the warehouse does not
 * hand them over, so a label printed on Friday afternoon is not late on
 * Monday morning — nothing could have happened in between. Counting in hours
 * would flag it, the operator would look, find nothing wrong, and learn to
 * ignore the badge. A badge that cries wolf is worse than no badge.
 *
 * HOLIDAYS ARE NOT HERE YET, on purpose: Spain has national, regional and
 * local ones, and a half-built list is worse than an honest Monday-to-Friday.
 * Everything below goes through `isWorkingDay`, so adding them later is one
 * function.
 */

/** Monday to Friday in Madrid. The only place the rule is written down. */
export function isWorkingDay(at: Date): boolean {
  const weekday = madridParts(at).weekday;
  // DAYS in this file starts at Sunday, so 1–5 is Monday to Friday.
  return weekday >= 1 && weekday <= 5;
}

/** Madrid midnight at the start of `at`'s own calendar day. */
function startOfMadridDay(at: Date): Date {
  const p = madridParts(at);
  return madridMidnightUtc(p.year, p.month, p.day);
}

/** Madrid midnight `days` calendar days after `at`'s day. */
function addMadridDays(at: Date, days: number): Date {
  const p = madridParts(at);
  return madridMidnightUtc(p.year, p.month, p.day + days);
}

/**
 * How many whole working days have passed since `from`, as at `to`.
 *
 * The day `from` falls on counts as the first working day when it is one, so a
 * label printed at 23:55 on a Friday has used up its Friday. A day only counts
 * once it is over, so the count is of working days strictly before `to`'s day:
 * on Friday itself the answer is 0.
 *
 *   Friday event  → 0 on Friday, 1 on Monday, 2 on Tuesday
 *   Monday event  → 1 on Tuesday, 2 on Wednesday
 *   Saturday event → counting starts Monday: 1 on Tuesday, 2 on Wednesday
 */
export function workingDaysSince(from: Date, to: Date): number {
  if (to.getTime() < from.getTime()) return 0;

  let cursor = startOfMadridDay(from);
  const end = startOfMadridDay(to);
  let count = 0;

  // A guard rather than a `while (true)`: a clock set years wrong should give
  // a silly number, not spin.
  for (let step = 0; step < 4000 && cursor.getTime() < end.getTime(); step += 1) {
    if (isWorkingDay(cursor)) count += 1;
    cursor = addMadridDays(cursor, 1);
  }

  return count;
}

/**
 * The newest reference time that still counts as `workingDays` working days
 * old, as at `at`. Anything strictly before it is stuck.
 *
 * This exists so the database can do the filtering. `workingDaysSince` answers
 * the question one row at a time, which is fine for a badge and useless for
 * "show me the stuck ones" across a table — the screen pages at a hundred
 * rows out of a thousand a day, so the predicate has to be a single comparison
 * SQL can run against an index.
 *
 * It works because the rule is monotonic: an earlier label is always at least
 * as stuck as a later one, so there is exactly one cutoff instant. Walk back
 * from today over `workingDays` working days and take the midnight after the
 * last of them.
 */
export function workingDayCutoff(at: Date, workingDays = 2): Date {
  let cursor = startOfMadridDay(at);
  let found = 0;

  for (let step = 0; step < 4000 && found < workingDays; step += 1) {
    cursor = addMadridDays(cursor, -1);
    if (isWorkingDay(cursor)) found += 1;
  }

  // `cursor` is now the oldest of the working days that have fully passed.
  // A reference time before the END of that day has had all of them.
  return addMadridDays(cursor, 1);
}
