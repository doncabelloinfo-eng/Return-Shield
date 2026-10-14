/**
 * When an error page tries again by itself.
 *
 * SEPARATE FROM THE COMPONENTS because this is the part that was wrong and the
 * part a test in this suite can reach: vitest runs in node, with no DOM, so a
 * `setTimeout` inside a client component is out of its reach while a schedule
 * in a plain function is not. Same reasoning as lib/poll-schedule.ts.
 *
 * WHAT WAS WRONG. The page said "Trying again…", tried once after three
 * seconds, and stopped. Measured in Chromium against a built server: with
 * Postgres stopped the page appeared, and with Postgres started again it sat
 * there — the single automatic attempt had already been and gone while the
 * database was still down, and only a browser reload brought the screen back.
 *
 * So it keeps trying, on a flat four seconds, which is what makes "the page
 * comes back on its own, shortly after the database does" true rather than a
 * claim in a heading. And it stops: eight attempts, about half a minute, after
 * which the page is still there with its button but is not asking any more. A
 * screen left open on a genuine failure must not retry for ever — each attempt
 * is a server render, and a full pooler is the last thing to hammer.
 */

/** The first wait, kept at the three seconds the heading implies. */
export const RETRY_FIRST_MS = 3_000;

/** And then every four, so recovery lands within about four seconds of the database's. */
export const RETRY_EVERY_MS = 4_000;

/** Eight in all: 3s, then 7, 11, 15, 19, 23, 27, 31. */
export const RETRY_ATTEMPTS = 8;

/**
 * A gap this long means a different incident.
 *
 * The attempt count has to live outside the component — the boundary re-renders
 * its fallback, and `global-error` reloads the document, so component state
 * does not survive. Module scope and `sessionStorage` do, which is why they
 * need telling when to start counting from zero again.
 */
export const NEW_INCIDENT_AFTER_MS = 60_000;

/** The wait before attempt number `attempt`, or null when it is time to stop. */
export function nextErrorRetryMs(attempt: number): number | null {
  if (!Number.isFinite(attempt) || attempt < 0) return null;
  if (attempt >= RETRY_ATTEMPTS) return null;
  return attempt === 0 ? RETRY_FIRST_MS : RETRY_EVERY_MS;
}

/** How many attempts to count as already made, given when the last one was. */
export function attemptsSoFar(attempts: number, lastAt: number, at: number): number {
  if (!lastAt || at - lastAt > NEW_INCIDENT_AFTER_MS) return 0;
  return Math.max(0, attempts);
}
