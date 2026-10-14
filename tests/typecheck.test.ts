import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

/**
 * THE SUITE NOW COMPILES THE PROJECT.
 *
 * `be756c9` shipped a commit that could not deploy. 934 tests passed and
 * `next build` failed:
 *
 *   ./app/api/parcels/export/route.ts:88:27
 *   Type error: Argument of type 'Buffer<ArrayBufferLike>' is not assignable
 *   to parameter of type 'BodyInit | null | undefined'.
 *
 * Nothing in the suite could have caught it, because nothing in the suite ran
 * the compiler: the export route's own tests call `GET` and read the bytes
 * back, and at RUNTIME a Buffer is a perfectly good response body. It is only
 * a type error, and a type error is exactly what stops a Vercel deployment.
 *
 * So this is the slowest test in the suite on purpose, and the one that stands
 * in for `next build` — which does this same check first, and which needs a
 * database to get past it. It runs TypeScript's own compiler over the whole
 * project with the project's own tsconfig, which is `npm run typecheck`.
 *
 * If it fails, read its output: it is the compiler's, not this file's.
 */

const require_ = createRequire(import.meta.url);

describe('the whole project', () => {
  it('compiles, which is what next build checks before it builds anything', () => {
    // TypeScript's own entry point, run with this node: no npx, no PATH, and
    // no network — the same compiler `npm run typecheck` uses.
    const tsc = require_.resolve('typescript/bin/tsc');

    let output = '';
    let failed = false;
    try {
      output = execFileSync(process.execPath, [tsc, '--noEmit'], {
        cwd: process.cwd(),
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      failed = true;
      const e = err as { stdout?: string; stderr?: string; message?: string };
      output = `${e.stdout ?? ''}${e.stderr ?? ''}` || e.message || 'tsc failed with no output';
    }

    expect(failed, `tsc --noEmit reported errors:\n\n${output}`).toBe(false);
  }, 240_000);
});
