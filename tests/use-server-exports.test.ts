import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * A `'use server'` file may export nothing but async functions.
 *
 * This test exists because of a crash that every other test was blind to. One
 * line in `app/actions/refresh.ts`:
 *
 *     export const MANUAL_SWEEP_GAP_MS = 5 * MINUTE;
 *
 * and Next refused to load the module at all:
 *
 *     Error: A "use server" file can only export async functions, found number.
 *
 * Not that one export — the whole module. So every action in the file went down
 * with it: the Refresh button, the Correos check after an upload, and the
 * Correos check after a thirty-day pull, each answering 500 and showing
 * "Application error: a server-side exception has occurred".
 *
 * Nothing caught it, and could not have: the unit tests import those actions
 * directly, Vitest loads them as ordinary ES modules, and the rule is Next's,
 * applied by its compiler. Only a real build or a real request meets it — and
 * only at the moment the module is first loaded, which is when somebody presses
 * the button in production.
 *
 * So this test READS the files instead of importing them. It is deliberately a
 * text check rather than a parse: it has to hold for a file that will not even
 * load, and a regex over the export lines is the whole of what the rule is
 * about. The one thing it must not do is flag a type-only export — `export
 * interface` and `export type` vanish at compile time, so they are allowed and
 * every action file has them.
 */

/* ------------------------------------------------------------------ the rule */

/** Lines that export a VALUE which is not an async function. */
const FORBIDDEN: readonly { pattern: RegExp; what: string }[] = [
  { pattern: /^\s*export\s+(const|let|var)\s/, what: 'a constant or variable' },
  { pattern: /^\s*export\s+class\s/, what: 'a class' },
  { pattern: /^\s*export\s+enum\s/, what: 'an enum' },
  { pattern: /^\s*export\s+(abstract\s+)?declare\s/, what: 'a declaration' },
  // A plain `export function` is not async. `export default` cannot be relied
  // on to be one either, and Next rejects it in an actions file regardless.
  { pattern: /^\s*export\s+function\s/, what: 'a synchronous function' },
  { pattern: /^\s*export\s+default\s/, what: 'a default export' },
  // `export { x }` and `export { x } from './y'` re-export values. The
  // `export type { … }` form is type-only and allowed, so it is excluded.
  { pattern: /^\s*export\s*\{(?![^}]*\btype\b)/, what: 'a re-exported value' },
  { pattern: /^\s*export\s+\*\s/, what: 'a star re-export' },
];

/** `export type { … }` and `export interface`/`export type` are fine. */
const TYPE_ONLY = /^\s*export\s+(type|interface)\s|^\s*export\s+type\s*\{/;

export interface Offence {
  file: string;
  line: number;
  what: string;
  text: string;
}

/**
 * Every line of `source` that Next would refuse, with what it found.
 *
 * Block comments are stripped first: these files explain at length what used to
 * be exported from them and why it is gone, and a grep that failed on the
 * explanation of the very bug it guards against would teach people to delete
 * the explanation.
 */
function offences(file: string, source: string): Offence[] {
  const withoutBlocks = source.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
  const out: Offence[] = [];

  withoutBlocks.split('\n').forEach((raw, i) => {
    const line = raw.replace(/\/\/.*$/, '');
    if (TYPE_ONLY.test(line)) return;

    for (const { pattern, what } of FORBIDDEN) {
      if (pattern.test(line)) {
        out.push({ file, line: i + 1, what, text: raw.trim() });
        return;
      }
    }
  });

  return out;
}

/** True for a file whose first real statement is the 'use server' directive. */
function isUseServer(source: string): boolean {
  // The directive has to be the first statement, so anything before it is
  // whitespace or comments. Strip those and look at what is left.
  const head = source
    .replace(/^﻿/, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .trimStart();

  return /^(['"])use server\1\s*;?/.test(head);
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.next' || entry.name.startsWith('.')) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full);
  }
  return out;
}

const SERVER_FILES = walk(process.cwd())
  .filter((f) => isUseServer(readFileSync(f, 'utf8')))
  .map((f) => relative(process.cwd(), f))
  .sort();

/* ------------------------------------------------------------------- the test */

describe("every 'use server' file", () => {
  it('is found at all — an empty sweep would pass by accident', () => {
    // Without this, a broken `isUseServer` makes the whole file green while
    // checking nothing. These are the action files as of this change.
    expect(SERVER_FILES).toContain('app/actions/refresh.ts');
    expect(SERVER_FILES.length).toBeGreaterThanOrEqual(7);
  });

  it('exports nothing but async functions and types', () => {
    const found = SERVER_FILES.flatMap((f) => offences(f, readFileSync(f, 'utf8')));

    expect(
      found.map((o) => `${o.file}:${o.line} exports ${o.what} — ${o.text}`),
      'a "use server" file can only export async functions; move this to lib/',
    ).toEqual([]);
  });

  it('still exports the actions the screens call', async () => {
    // The flip side: a file that exports nothing is not the fix.
    const refresh = await import('@/app/actions/refresh');
    expect(typeof refresh.refreshFromCorreos).toBe('function');
    expect(typeof refresh.sweepNewParcels).toBe('function');
  });
});

describe('the check itself', () => {
  it('catches a file that exports a number', () => {
    // The exact shape of the crash: `export const X = 5 * MINUTE`.
    const bad = "'use server';\n\nimport { MINUTE } from '@/lib/clock';\n\nexport const GAP = 5 * MINUTE;\n\nexport async function go() {}\n";
    expect(isUseServer(bad)).toBe(true);

    const found = offences('bad.ts', bad);
    expect(found).toHaveLength(1);
    expect(found[0].line).toBe(5);
    expect(found[0].what).toBe('a constant or variable');
  });

  it.each([
    ['export class Thing {}', 'a class'],
    ['export enum Kind { A }', 'an enum'],
    ['export function sync() {}', 'a synchronous function'],
    ['export default async function x() {}', 'a default export'],
    ["export { helper } from './helper';", 'a re-exported value'],
    ['export { helper };', 'a re-exported value'],
    ["export * from './helper';", 'a star re-export'],
    ['export let counter = 0;', 'a constant or variable'],
  ])('catches %s', (line, what) => {
    const found = offences('bad.ts', `'use server';\n${line}\n`);
    expect(found.map((o) => o.what)).toEqual([what]);
  });

  it.each([
    'export async function go() {}',
    'export interface Result { ok: boolean }',
    'export type Kind = "a" | "b";',
    "export type { Kind } from './types';",
  ])('allows %s', (line) => {
    expect(offences('ok.ts', `'use server';\n${line}\n`)).toEqual([]);
  });

  it('ignores an export inside a comment', () => {
    const source = [
      "'use server';",
      '',
      '/**',
      ' * This used to be `export const MANUAL_SWEEP_GAP_MS = 5 * MINUTE;` and',
      ' * taking it out is what fixed the crash.',
      ' */',
      '// export const GAP = 1;',
      'export async function go() {}',
    ].join('\n');

    expect(offences('ok.ts', source)).toEqual([]);
  });

  it('does not mistake an ordinary module for a server one', () => {
    expect(isUseServer("import { x } from 'y';\nexport const GAP = 1;\n")).toBe(false);
    // 'use client' is a different directive with none of this rule.
    expect(isUseServer("'use client';\nexport const GAP = 1;\n")).toBe(false);
  });

  it('finds the directive behind a licence header or a comment', () => {
    expect(isUseServer("// a note\n'use server';\n")).toBe(true);
    expect(isUseServer('/* a header */\n"use server";\n')).toBe(true);
  });

  it('sweeps a real directory tree', () => {
    // `walk` + `isUseServer` together, against files on disk — the part that
    // decides whether the check above looks at anything at all.
    const dir = mkdtempSync(join(tmpdir(), 'use-server-'));
    try {
      writeFileSync(join(dir, 'action.ts'), "'use server';\nexport const BAD = 1;\n");
      writeFileSync(join(dir, 'plain.ts'), 'export const FINE = 1;\n');

      const found = walk(dir)
        .filter((f) => isUseServer(readFileSync(f, 'utf8')))
        .flatMap((f) => offences(relative(dir, f), readFileSync(f, 'utf8')));

      expect(found.map((o) => `${o.file}:${o.what}`)).toEqual(['action.ts:a constant or variable']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
