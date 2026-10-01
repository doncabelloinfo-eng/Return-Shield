import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    /**
     * Production runs in UTC and `TZ` is a reserved variable on Vercel that
     * cannot be set there, so the suite runs in UTC too. Pinning it here rather
     * than in setup.ts matters: this is applied before the worker starts, so it
     * beats both V8's timezone caching and the TZ that `dotenv` loads out of a
     * developer's .env.
     */
    env: { TZ: 'UTC' },
    globals: false,
    setupFiles: ['./tests/setup.ts'],
    // The database tests share one Postgres and truncate between files.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
  resolve: {
    alias: { '@': import.meta.dirname },
  },
});
