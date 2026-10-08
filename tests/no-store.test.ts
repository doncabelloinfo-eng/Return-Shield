import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * Every outbound call says `cache: 'no-store'`, and every cron route says
 * `fetchCache = 'force-no-store'`.
 *
 * THIS IS THE GUARD FOR THE DAY TRACKING SILENTLY STOPPED.
 *
 * Next's App Router patches global `fetch`. A GET with no cache option, called
 * from inside a route handler, goes into the on-disk Data Cache — and Next
 * stamps it `revalidate: 31536000`, a year. So the reconcile cron asked Correos
 * once and then read `.next/cache/fetch-cache/<hash>` on every run after that.
 * Six hourly runs in a row reported "asked 201, stored 0" while Correos had
 * hundreds of events nobody could see.
 *
 * Reproduced on a built server before any of it was changed: three cron runs
 * against a stub that answered differently each time produced ONE outbound
 * request, and the cache file on disk held the first answer with a one-year
 * revalidate. With the fix: three runs, three requests, three answers, and an
 * empty cache directory.
 *
 * Two things made it invisible, and both are why this test reads the files
 * rather than running anything:
 *
 *   · `export const dynamic = 'force-dynamic'` is already on every cron route
 *     and does NOT stop it. It governs rendering; the fetch cache decision
 *     never consults it. Worse, taking that branch skips the request proxy
 *     that would otherwise have marked the route dynamic.
 *   · the bearer token is part of the cache key, so a run that happened to
 *     mint a fresh token missed the cache and did get real data — which made
 *     it look intermittent rather than broken.
 *
 * And `npm run build` passes either way: the rule is applied when the module
 * runs, not when it compiles. See tests/stale-data.test.ts for the behavioural
 * half of this.
 */

/**
 * Comments taken out, so the long notes above — which quote the very thing
 * they guard against — cannot satisfy the check.
 *
 * Block comments are blanked rather than deleted, so the line numbers in a
 * failure still point at the real line.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\s\/\/.*$/gm, '');
}

function codeOf(path: string): string {
  return stripComments(readFileSync(path, 'utf8'));
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.next' || entry.name.startsWith('.')) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.ts$/.test(entry.name)) out.push(relative(process.cwd(), full));
  }
  return out;
}

/**
 * Where an outbound call must carry the option.
 *
 * `lib/carriers` is Correos and Shopify — the two that broke and the one that
 * would have broken next. `jobs` is included because that is where a new
 * integration would most plausibly be called from.
 */
const SCOPE = ['lib/carriers', 'jobs'];

/**
 * Every `fetch`-shaped call and whether its options object says `no-store`.
 *
 * Matching the call and then reading forward to the balanced closing brace,
 * rather than a single regex over the whole call: these calls span ten lines
 * and carry nested objects, and a regex that tried to span them would either
 * miss them or match the next one.
 */
function callsIn(source: string): { at: number; text: string; noStore: boolean }[] {
  const out: { at: number; text: string; noStore: boolean }[] = [];
  // `fetch(`, `fetchImpl(`, `this.fetchImpl(` — anything that ends in fetch
  // and is being called. The declarations (`fetchImpl?: typeof fetch`) are not
  // calls and do not match, because they are not followed by `(`.
  const pattern = /\b(?:[A-Za-z_$][\w$]*\.)?fetch(?:Impl)?\(/g;

  for (let m = pattern.exec(source); m; m = pattern.exec(source)) {
    let depth = 0;
    let end = m.index + m[0].length - 1;
    for (; end < source.length; end += 1) {
      if (source[end] === '(') depth += 1;
      else if (source[end] === ')') { depth -= 1; if (depth === 0) break; }
    }
    const text = source.slice(m.index, end + 1);
    // A pass-through wrapper — `(...args) => fetch(...args)` — has no options
    // object of its own and is not where the rule belongs.
    if (/^\s*\(?\s*\.\.\./.test(text.slice(m[0].length))) continue;
    out.push({
      at: source.slice(0, m.index).split('\n').length,
      text,
      noStore: /cache:\s*'no-store'/.test(text),
    });
  }

  return out;
}

const FILES = SCOPE.flatMap((dir) => walk(dir));

describe('every outbound call in lib/carriers and jobs', () => {
  it('is actually being looked at — an empty sweep would pass by accident', () => {
    expect(FILES).toContain('lib/carriers/correos/trackpub.ts');
    expect(FILES).toContain('lib/carriers/correos/token.ts');
    expect(FILES).toContain('lib/carriers/shopify/pull.ts');

    const found = FILES.flatMap((f) => callsIn(codeOf(f)).map((c) => `${f}:${c.at}`));
    // Correos' tracking, the CorreosID token, and the Shopify Admin API.
    expect(found.length).toBeGreaterThanOrEqual(3);
  });

  it("passes cache: 'no-store'", () => {
    const offenders = FILES.flatMap((f) =>
      callsIn(codeOf(f))
        .filter((c) => !c.noStore)
        .map((c) => `${f}:${c.at} — ${c.text.split('\n')[0].trim()}`));

    expect(
      offenders,
      "Next caches a GET with no cache option for a year. See lib/carriers/correos/trackpub.ts",
    ).toEqual([]);
  });
});

describe('the check itself', () => {
  it('finds a call that is missing the option', () => {
    const bad = [
      'async function go() {',
      '  const res = await fetch(url, {',
      "    headers: { Accept: 'application/json' },",
      '    signal: AbortSignal.timeout(30_000),',
      '  });',
      '}',
    ].join('\n');

    const calls = callsIn(bad);
    expect(calls).toHaveLength(1);
    expect(calls[0].noStore).toBe(false);
  });

  it('accepts one that has it', () => {
    const good = "await this.fetchImpl(url, {\n  cache: 'no-store',\n  signal: s,\n});";
    expect(callsIn(good)[0].noStore).toBe(true);
  });

  it('is not satisfied by the option appearing in a comment', () => {
    const commented = [
      '/* this used to say cache: no-store and should again */',
      'await fetch(url, {',
      "  // cache: 'no-store',",
      '  headers: h,',
      '});',
    ].join('\n');
    expect(callsIn(stripComments(commented))[0].noStore).toBe(false);
  });

  it('ignores a pass-through wrapper, which has no options of its own', () => {
    expect(callsIn('this.fetchImpl = opts.fetchImpl ?? ((...args) => fetch(...args));')).toEqual([]);
  });

  it('ignores a type declaration, which is not a call', () => {
    expect(callsIn('  fetchImpl?: typeof fetch;')).toEqual([]);
  });
});

describe('every cron route', () => {
  const ROUTES = readdirSync('app/api/cron', { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => `app/api/cron/${d.name}/route.ts`);

  it('is found at all', () => {
    expect(ROUTES.length).toBeGreaterThanOrEqual(10);
  });

  it("declares fetchCache = 'force-no-store'", () => {
    const missing = ROUTES.filter((f) =>
      !/export const fetchCache = 'force-no-store';/.test(codeOf(f)));
    expect(missing).toEqual([]);
  });

  it('still declares the rest of its segment config', () => {
    // `fetchCache` is in addition to these, not instead of them: `dynamic`
    // keeps the route out of the build's static render pass, which is what
    // stops every build needing a live production database.
    for (const f of ROUTES) {
      const src = codeOf(f);
      expect(src, f).toContain("export const dynamic = 'force-dynamic';");
      expect(src, f).toContain("export const runtime = 'nodejs';");
      expect(src, f).toMatch(/export const maxDuration = \d+;/);
    }
  });
});

describe('the progress poll route', () => {
  it('is no-store too, in both of the ways that matter', () => {
    // A cached progress bar is a progress bar that never moves — and this one
    // is polled every second and a half, so a CDN would be only too happy to
    // hold on to it.
    const src = codeOf('app/api/sweep-progress/route.ts');
    expect(src).toContain("export const fetchCache = 'force-no-store';");
    expect(src).toContain("'Cache-Control': 'no-store");
  });
});
