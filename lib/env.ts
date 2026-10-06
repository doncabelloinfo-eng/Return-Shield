/**
 * Reading environment variables, where empty means unset.
 *
 * `process.env.X ?? fallback` looks like it applies the fallback when X is not
 * configured. It does not: `??` only fires on `undefined`, and a variable
 * present-but-empty is the empty string. Vercel's UI makes that easy to
 * produce — add the key, leave the value for later, deploy — and every hosting
 * dashboard behaves the same way.
 *
 * It cost us a day. `CORREOS_TRACKPUB_BASE_URL` was added with no value, so the
 * base URL became `''`, every lookup fetched `/search/PK…` as a relative URL,
 * and production answered `Failed to parse URL from /search/…`: a message that
 * says nothing about which variable is wrong.
 *
 * So: blank is unset, everywhere. The whitespace trim matters for the same
 * reason — a value pasted with a trailing newline is a credential that does not
 * match and a URL that 404s, and neither says why.
 */

/** The value of `name`, or undefined if it is missing, empty or whitespace. */
export function env(name: string): string | undefined {
  const raw = process.env[name];
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  return trimmed === '' ? undefined : trimmed;
}

/** The value of `name`, or `fallback` if it is missing, empty or whitespace. */
export function envOr(name: string, fallback: string): string {
  return env(name) ?? fallback;
}

/** Is `name` set to something? Use this rather than `!process.env[name]`. */
export function envSet(name: string): boolean {
  return env(name) !== undefined;
}

/**
 * A positive number from `name`, or `fallback`.
 *
 * `Number(process.env.X ?? 6000)` has the same hole plus a worse one:
 * `Number('')` is 0, so an empty value does not fall back to the default, it
 * silently becomes a batch size of nothing and a sweep that checks no parcels
 * while reporting success. `Number('abc')` is NaN, which compares false against
 * everything and is just as quiet.
 */
export function envNumber(name: string, fallback: number): number {
  const raw = env(name);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** A comma-separated list from `name`, with blank entries dropped. */
export function envList(name: string): string[] {
  const raw = env(name);
  if (raw === undefined) return [];
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}
