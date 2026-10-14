/**
 * How often the browser asks what the sweep is doing.
 *
 * SEPARATE FROM THE COMPONENT ON PURPOSE. The numbers here turned out to be a
 * database problem, not a cosmetic one: every open tab polled every twenty
 * seconds whether or not anything was running, and whether or not anybody was
 * looking at it, and each poll opened a connection out of the fifteen the
 * whole project has. 45 invocations of that route in twelve hours, 17.8% of
 * them failing, against 31 views of the screen it decorates.
 *
 * So the rule lives in a plain function that a test can ask questions of,
 * rather than inside a `setTimeout` in a component that the suite — which runs
 * in node, with no DOM — cannot reach.
 */

/** While a sweep is running. Fast enough that the bar looks live. */
export const SWEEP_POLL_MS = 1_500;

/**
 * While nothing is running: a minute, not twenty seconds.
 *
 * The polling cannot stop altogether, because the hourly cron has to be able
 * to appear on a screen somebody is already looking at — that is how the
 * operator sees the engine working without reading a job table. But a run
 * lasts a minute or two, so a minute between looks still catches it, at a
 * third of the cost.
 */
export const IDLE_POLL_MS = 60_000;

/**
 * The delay before the next poll, or null to stop polling.
 *
 * Null for a hidden tab: a background tab draws nothing, so its polls were
 * pure cost — and this is the case that actually mattered, because tabs get
 * left open for days. The component starts again on `visibilitychange`.
 */
export function nextPollDelay(opts: { sweeping: boolean; hidden: boolean }): number | null {
  if (opts.hidden) return null;
  return opts.sweeping ? SWEEP_POLL_MS : IDLE_POLL_MS;
}
