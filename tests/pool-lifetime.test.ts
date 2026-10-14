import { describe, it, expect, afterAll } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { sql } from 'drizzle-orm';
import { getDb, getSql } from '@/db';
import { closeDb } from './helpers/db';

/**
 * No request ever shuts the connection pool down.
 *
 * THIS IS THE GUARD FOR "Application error: a server-side exception has
 * occurred", the one that appeared on a screen now and then and never twice in
 * the same place.
 *
 * WHAT HAPPENED. The pool in db/index.ts is a module-level singleton parked on
 * `globalThis`, so every request running inside one Vercel instance shares it.
 * `closeDb()` ends that pool and clears the singleton — which is right for a
 * script that is about to exit and wrong for anything serving traffic.
 *
 * Two places called it from a request. The progress-poll route
 * (app/api/sweep-progress/route.ts) called it in a `finally`, and that route is
 * polled by the Refresh button, which the panel layout renders on EVERY screen:
 * every twenty seconds idle, every second and a half during a sweep. And the
 * cron wrapper (lib/cron.ts) called it at the end of every scheduled run. So
 * roughly three times a minute per open tab, the pool went away underneath
 * whatever page render happened to be in flight next to it, and that render
 * threw. Intermittent by construction: it needed a poll and a render to overlap
 * on one instance, which is why reloading the same URL usually worked.
 *
 * The reasoning behind those calls — a frozen serverless instance should not
 * sit on connections — was answering a real question with the wrong tool.
 * `idle_timeout: 20` in db/index.ts is the mechanism for that, and it does the
 * job without taking the pool away from anybody.
 *
 * The rule is already written down in db/index.ts: "Scripts and tests only; a
 * request must never call it." This test is what makes it bite.
 */

/**
 * Comments taken out, so the long note above — which names the very call it
 * forbids — cannot trip its own check.
 *
 * Block comments are blanked rather than deleted so a failure's line number
 * still points at the real line. Same helper, same reason, as
 * tests/no-store.test.ts.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\s\/\/.*$/gm, '');
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.next' || entry.name.startsWith('.')) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry.name)) out.push(relative(process.cwd(), full));
  }
  return out;
}

/**
 * Everything that runs while somebody is waiting for a response: the routes and
 * pages under `app`, the server components under `components`, the view and
 * action modules under `lib`, and the job bodies under `jobs` — which run
 * inside the cron routes.
 *
 * `jobs/run-once.ts` is the one file under `jobs` that is a command-line
 * script, and it is a legitimate caller: it closes the pool so the process can
 * exit. `scripts/`, `db/seed.ts` and the tests are out of scope for the same
 * reason.
 */
const SCOPE = ['app', 'components', 'lib', 'jobs'];
const ALLOWED = ['jobs/run-once.ts'];

const FILES = SCOPE.flatMap((dir) => walk(dir)).filter((f) => !ALLOWED.includes(f));

/** A call, not a mention: `closeDb(`, with or without an await in front. */
const CALL = /\bcloseDb\s*\(/;

describe('the request-handling code', () => {
  it('is actually being looked at — an empty sweep would pass by accident', () => {
    expect(FILES).toContain('app/api/sweep-progress/route.ts');
    expect(FILES).toContain('lib/cron.ts');
    expect(FILES).toContain('app/(panel)/layout.tsx');
    expect(FILES.length).toBeGreaterThan(50);
  });

  it('never shuts the pool down', () => {
    const offenders = FILES.filter((f) => CALL.test(stripComments(readFileSync(f, 'utf8'))));

    expect(
      offenders,
      'The pool is shared by every concurrent request in the instance (db/index.ts). '
      + 'Closing it from a request takes it away from whatever else is mid-render. '
      + "Let `idle_timeout` hand the connections back instead.",
    ).toEqual([]);
  });

  it('does not even import it', () => {
    // Belt and braces: an import with no call today is the call tomorrow.
    const importers = FILES.filter((f) => /\bcloseDb\b/.test(stripComments(readFileSync(f, 'utf8'))));
    expect(importers).toEqual([]);
  });
});

describe('the check itself', () => {
  it('catches the call that caused this', () => {
    const bad = [
      'export async function GET() {',
      '  try {',
      '    return NextResponse.json(await read());',
      '  } finally {',
      '    await closeDb().catch(() => {});',
      '  }',
      '}',
    ].join('\n');
    expect(CALL.test(stripComments(bad))).toBe(true);
  });

  it('is not tripped by a comment explaining why the call is gone', () => {
    const good = [
      '// This used to call closeDb() here, which was the bug.',
      '/* closeDb() belongs to scripts. */',
      'return NextResponse.json(await read());',
    ].join('\n');
    expect(CALL.test(stripComments(good))).toBe(false);
  });
});

describe('what closing the pool mid-request actually does', () => {
  afterAll(async () => { await closeDb(); });

  it('breaks a caller that was already holding it', async () => {
    // Every view function starts by taking a handle, exactly like this, and
    // then runs several queries against it over the life of the render.
    const db = getDb();
    const before = getSql();
    await db.execute(sql`SELECT 1`);

    // Meanwhile, on the same instance, the progress poll finishes and tidies
    // up after itself.
    await closeDb();

    // And the render that was half way through loses the floor underneath it.
    // This is the server-side exception, reproduced in four lines.
    await expect(db.execute(sql`SELECT 1`)).rejects.toThrow();

    // The next request gets a healthy new pool, which is why the error never
    // reproduced on a reload — and why it took this long to pin down.
    expect(getSql()).not.toBe(before);
    await expect(getDb().execute(sql`SELECT 1`)).resolves.toBeDefined();
  });
});
