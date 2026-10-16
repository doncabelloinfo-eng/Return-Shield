import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * A scanner session can never use the panel, and an operator session can never
 * use the Scanner.
 *
 * TWO HALVES, AND THE FIRST IS THE ONE THAT MATTERS. A warehouse phone is the
 * account most likely to be lost — left on a shelf, shared between shifts,
 * carried out of the building — and the panel holds every customer's name,
 * phone, address and order value. The Scanner is deliberately built to know a
 * code, an order number and a shop name and nothing else; a phone that could
 * open /parcels would undo that in one tap.
 *
 * SO THIS TEST WALKS THE TREE rather than checking the places somebody
 * remembered. It is the same shape as the `maxDuration` guard in
 * tests/db-connections.test.ts: read every page, every server action and every
 * route handler on disk, and fail on the one that is not covered. A page added
 * next year is covered by `requireUser` being operator-only, and this is what
 * proves it stayed that way.
 */

/* ============================================================ walking the tree */

function filesNamed(dir: string, name: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) filesNamed(full, name, out);
    else if (entry.name === name) out.push(relative(process.cwd(), full));
  }
  return out;
}

/** Comments explain these rules at length; a grep must not read them. */
function code(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^\s*\/\/.*$/gm, ' ');
}

const PAGES = filesNamed('app', 'page.tsx').sort();
const ROUTES = filesNamed('app', 'route.ts').sort();
const ACTIONS = readdirSync('app/actions').filter((f) => f.endsWith('.ts')).map((f) => `app/actions/${f}`).sort();

/* ======================================================================= pages */

/**
 * Pages outside the panel, and why each one may be reached without an operator
 * session. Anything not on this list must be under app/(panel), which is behind
 * the layout's `requireUser`.
 */
const OPEN_PAGES: Record<string, string> = {
  'app/page.tsx': 'the root, which only redirects',
  'app/login/page.tsx': 'the office sign-in',
  'app/scan/login/page.tsx': 'the warehouse sign-in',
  'app/e/[token]/page.tsx': 'the customer page, behind a signed token',
  'app/scan/page.tsx': 'the Scanner, behind requireScanner',
  'app/scan/[direction]/page.tsx': 'the Scanner, behind requireScanner',
};

describe('every page', () => {
  it('is actually being looked at', () => {
    expect(PAGES).toContain('app/(panel)/parcels/page.tsx');
    expect(PAGES).toContain('app/scan/page.tsx');
    expect(PAGES.length).toBeGreaterThanOrEqual(10);
  });

  it('is either in the panel, in the Scanner, or on the open list', () => {
    const loose = PAGES.filter((f) => !f.startsWith('app/(panel)/') && !(f in OPEN_PAGES));

    expect(
      loose,
      'a page outside app/(panel) is not behind the panel layout\'s requireUser. '
      + 'Guard it, or add it to OPEN_PAGES with the reason it may be open.',
    ).toEqual([]);
  });

  it('is behind requireUser when it is a panel page', () => {
    // One layout guards them all, so this is the single line everything under
    // app/(panel) depends on. If it ever goes, every panel page is open.
    expect(code('app/(panel)/layout.tsx')).toContain('requireUser(');
  });

  it('is behind requireScanner when it is a Scanner page', () => {
    const unguarded = PAGES
      .filter((f) => f.startsWith('app/scan/') && f !== 'app/scan/login/page.tsx')
      .filter((f) => !code(f).includes('requireScanner('));

    expect(unguarded).toEqual([]);
  });
});

/* ===================================================================== actions */

describe('every server action', () => {
  it('is actually being looked at', () => {
    expect(ACTIONS).toContain('app/actions/parcel.ts');
    expect(ACTIONS).toContain('app/actions/scanner.ts');
    expect(ACTIONS.length).toBeGreaterThanOrEqual(7);
  });

  it('calls requireUser, which is operator-only', () => {
    /*
     * Per exported function, not per file. A file where six of seven actions
     * are guarded passes a file-level grep and is still a hole — and
     * `toggleTheme` was exactly that: one unguarded action in a file full of
     * guarded ones, on the reasoning that it only set a cookie.
     */
    const open: string[] = [];

    for (const file of ACTIONS) {
      const source = code(file);
      const starts = [...source.matchAll(/export\s+async\s+function\s+(\w+)/g)];

      starts.forEach((match, i) => {
        const from = match.index ?? 0;
        const to = i + 1 < starts.length ? starts[i + 1].index ?? source.length : source.length;
        const body = source.slice(from, to);
        if (!body.includes('requireUser(')) open.push(`${file}: ${match[1]}`);
      });
    }

    expect(
      open,
      'a server action is a public endpoint whatever the page around it looks '
      + 'like. Every one of them calls requireUser(), which refuses a scanner.',
    ).toEqual([]);
  });
});

/* ====================================================================== routes */

/**
 * Routes that are not behind a session, and what guards each instead.
 *
 * Every one of these is a real door, so the reason has to be a mechanism and
 * not a hope. The two static files are the only entries with no guard at all,
 * and they hold nothing: a manifest Chrome fetches WITHOUT credentials (so a
 * guarded one would simply never load and the install prompt would never
 * appear), and a service worker whose source is public by definition.
 */
const OPEN_ROUTES: Record<string, string> = {
  'app/api/logout/route.ts': 'ends your own session and nothing else',
  'app/api/actions/[token]/route.ts': 'the customer action page, behind a signed token',
  'app/api/webhooks/correos/track/route.ts': "Correos' own clientId and clientSecret headers",
  'app/api/webhooks/shopify/[store]/route.ts': "Shopify's HMAC over the raw body",
  'app/scan/manifest.webmanifest/route.ts': 'a static manifest, fetched without credentials',
  'app/scan-sw.js/route.ts': 'a static service worker, public by definition',
};

describe('every route handler', () => {
  it('is actually being looked at', () => {
    expect(ROUTES).toContain('app/api/sweep-progress/route.ts');
    expect(ROUTES).toContain('app/api/scan/scan/route.ts');
    expect(ROUTES).toContain('app/api/parcels/export/route.ts');
    expect(ROUTES.length).toBeGreaterThanOrEqual(16);
  });

  it('refuses a scanner session, or has a guard of its own', () => {
    const open: string[] = [];

    for (const file of ROUTES) {
      if (file in OPEN_ROUTES) continue;
      const source = code(file);

      // The cron routes carry their own secret, checked by `cronRoute`.
      if (file.startsWith('app/api/cron/')) {
        if (!source.includes('cronRoute(')) open.push(`${file} — a cron route without cronRoute()`);
        continue;
      }

      // The Scanner's own API. Refuses an operator as well as a signed-out
      // request; see lib/scan/api.ts.
      if (file.startsWith('app/api/scan/')) {
        if (!source.includes('requireScannerApi(')) open.push(`${file} — no requireScannerApi()`);
        continue;
      }

      // Everything else is panel work and must say so explicitly. A redirect
      // would be wrong here: these answer a fetch, and a 302 to /login arrives
      // as an HTML body the caller then fails to parse.
      const guarded = source.includes("role !== 'operator'") || source.includes('requireUser(');
      if (!guarded) open.push(`${file} — no operator check`);
    }

    expect(
      open,
      'a route handler is reachable by anyone with a session, including a '
      + 'warehouse phone. Check the role, or add it to OPEN_ROUTES with the '
      + 'mechanism that guards it instead.',
    ).toEqual([]);
  });

  it('gives every Scanner route a maxDuration above the connection hold', () => {
    // The same rule as tests/db-connections.test.ts, restated for the routes
    // added with the Scanner: the release window holds an invocation six
    // seconds past its last query.
    const tight = ROUTES
      .filter((f) => f.startsWith('app/api/scan/'))
      .filter((f) => {
        const m = /export const maxDuration = (\d+);/.exec(readFileSync(f, 'utf8'));
        return !m || Number(m[1]) < 8;
      });

    expect(tight).toEqual([]);
  });
});

/* ============================================================ and the behaviour */

// The static sweep above proves the guards are CALLED. These prove they REFUSE.
vi.mock('next/navigation', () => ({
  redirect: (to: string) => { throw new Error(`REDIRECT:${to}`); },
}));

const currentUser = vi.fn();
vi.mock('@/lib/auth/session', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/session')>()),
  currentUser,
}));

const { requireUser, requireScanner } = await import('@/lib/auth/guard');
const { attemptSignIn } = await import('@/lib/auth/sign-in');
const { setScannerActive, addScanner } = await import('@/lib/scan/accounts');
const { createSession } = await import('@/lib/auth/session');
const { getDb } = await import('@/db');
const { sessions } = await import('@/db/schema');
const { eq } = await import('drizzle-orm');
const { resetDb, closeDb } = await import('./helpers/db');
const { makeUser } = await import('./helpers/fixtures');

async function redirectFrom(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.startsWith('REDIRECT:')) return message.slice('REDIRECT:'.length);
    throw err;
  }
  return '';
}

beforeEach(async () => {
  await resetDb();
  currentUser.mockReset();
});

afterAll(async () => { await closeDb(); });

describe('the guards themselves', () => {
  it('sends a scanner away from the panel, to the Scanner', async () => {
    currentUser.mockResolvedValue({ id: 'u', email: 'w@example.com', name: 'W', role: 'scanner' });
    expect(await redirectFrom(requireUser)).toBe('/scan');
  });

  it('sends an operator away from the Scanner, to the panel', async () => {
    currentUser.mockResolvedValue({ id: 'u', email: 'o@example.com', name: 'O', role: 'operator' });
    expect(await redirectFrom(requireScanner)).toBe('/today');
  });

  it('sends each kind of signed-out request to its own sign-in', async () => {
    currentUser.mockResolvedValue(null);
    expect(await redirectFrom(requireUser)).toBe('/login');
    expect(await redirectFrom(requireScanner)).toBe('/scan/login');
  });

  it('lets each kind through its own door', async () => {
    currentUser.mockResolvedValue({ id: 'u', email: 'o@example.com', name: 'O', role: 'operator' });
    expect((await requireUser()).role).toBe('operator');

    currentUser.mockResolvedValue({ id: 'u', email: 'w@example.com', name: 'W', role: 'scanner' });
    expect((await requireScanner()).role).toBe('scanner');
  });

  it('treats a role it does not recognise as an operator, never as a scanner', async () => {
    // The failure that locks the office out of its own panel is visible in a
    // second. The one that hands a warehouse phone the panel is not.
    currentUser.mockResolvedValue({ id: 'u', email: 'x@example.com', name: 'X', role: 'wat' });
    expect((await requireUser()).role).toBe('operator');
    expect(await redirectFrom(requireScanner)).toBe('/today');
  });
});

describe('each sign-in form', () => {
  it('refuses the other kind of account, after checking the password', async () => {
    await makeUser({ email: 'office@example.com', role: 'operator', password: 'office-pass-1' });
    await makeUser({ email: 'warehouse@example.com', role: 'scanner', password: 'warehouse-pass-1' });

    const atScanner = await attemptSignIn('office@example.com', 'office-pass-1', 'scanner');
    expect(atScanner).toEqual({ ok: false, reason: 'wrong-form', has: 'operator' });

    const atPanel = await attemptSignIn('warehouse@example.com', 'warehouse-pass-1', 'operator');
    expect(atPanel).toEqual({ ok: false, reason: 'wrong-form', has: 'scanner' });
  });

  it('lets each kind in at its own form', async () => {
    const office = await makeUser({ email: 'o2@example.com', role: 'operator', password: 'office-pass-2' });
    const shed = await makeUser({ email: 'w2@example.com', role: 'scanner', password: 'shed-pass-2' });

    expect(await attemptSignIn('o2@example.com', 'office-pass-2', 'operator'))
      .toEqual({ ok: true, userId: office.id, role: 'operator' });
    expect(await attemptSignIn('W2@EXAMPLE.COM ', 'shed-pass-2', 'scanner'))
      .toEqual({ ok: true, userId: shed.id, role: 'scanner' });
  });

  it('says only "no match" for a wrong password or an address with no account', async () => {
    await makeUser({ email: 'o3@example.com', role: 'operator', password: 'office-pass-3' });

    // Identical answers, so this cannot be used to ask which addresses exist.
    expect(await attemptSignIn('o3@example.com', 'wrong', 'operator'))
      .toEqual({ ok: false, reason: 'no-match' });
    expect(await attemptSignIn('nobody@example.com', 'wrong', 'operator'))
      .toEqual({ ok: false, reason: 'no-match' });
  });
});

describe('a disabled worker', () => {
  it('cannot sign in, and their phones are signed out at once', async () => {
    const added = await addScanner({
      name: 'Warehouse', email: 'shed@example.com', password: 'shed-pass-4',
    });
    expect(added.ok).toBe(true);
    if (!added.ok) return;

    // Two phones, both signed in.
    await createSession(added.id);
    await createSession(added.id);
    expect(await sessionCount(added.id)).toBe(2);

    expect(await attemptSignIn('shed@example.com', 'shed-pass-4', 'scanner'))
      .toEqual({ ok: true, userId: added.id, role: 'scanner' });

    expect(await setScannerActive(added.id, false)).toEqual({ ok: true });

    expect(await attemptSignIn('shed@example.com', 'shed-pass-4', 'scanner'))
      .toEqual({ ok: false, reason: 'disabled' });
    expect(await sessionCount(added.id)).toBe(0);
  });

  it('can be let back in', async () => {
    const added = await addScanner({
      name: 'Warehouse', email: 'shed5@example.com', password: 'shed-pass-5',
    });
    if (!added.ok) throw new Error(added.error);

    await setScannerActive(added.id, false);
    await setScannerActive(added.id, true);

    expect(await attemptSignIn('shed5@example.com', 'shed-pass-5', 'scanner'))
      .toMatchObject({ ok: true });
  });

});

async function sessionCount(userId: string): Promise<number> {
  const rows = await getDb().select({ id: sessions.id }).from(sessions)
    .where(eq(sessions.userId, userId));
  return rows.length;
}
