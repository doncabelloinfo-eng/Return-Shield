import * as React from 'react';

/**
 * Memoise a function for the length of one request, where that concept exists.
 *
 * React's `cache()` is what we want and what this uses — but in React 18 it is
 * only exported under the `react-server` condition. Next.js resolves that for
 * server components, and nothing else does: a test, a script or the standalone
 * worker importing a module that calls `cache` at the top level gets
 * `TypeError: cache is not a function` before a single line of it runs.
 *
 * So the import is conditional and the fallback is a pass-through. Outside a
 * request there is no request to scope a cache to, and a long-lived process
 * holding memoised database answers for ever is worse than an extra query:
 * that is how the worker ends up reporting an engine that stopped an hour ago
 * as healthy.
 */
type AnyFn<A extends unknown[], R> = (...args: A) => R;

const reactCache = (React as { cache?: <A extends unknown[], R>(fn: AnyFn<A, R>) => AnyFn<A, R> }).cache;

export function perRequest<A extends unknown[], R>(fn: AnyFn<A, R>): AnyFn<A, R> {
  return reactCache ? reactCache(fn) : fn;
}

/** True in the server-component runtime, where per-request caching is real. */
export const perRequestCachingAvailable = Boolean(reactCache);
