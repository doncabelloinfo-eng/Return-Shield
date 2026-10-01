/**
 * How we connect to Postgres, in one place, so the app and the migrator cannot
 * disagree about it.
 *
 * They connect to different things on purpose. The app uses Supabase's
 * TRANSACTION pooler (port 6543), which multiplexes many short-lived
 * serverless instances onto few backends. The migrator uses the SESSION pooler
 * (port 5432), because DDL and advisory locks need a session that stays put.
 * Both need TLS; only one of them can use prepared statements.
 */

export interface ConnectionShape {
  /** postgres.js `ssl` option. */
  ssl: false | 'require' | 'verify-full' | 'allow' | 'prefer';
  /** False for the transaction pooler, which cannot do prepared statements. */
  prepare: boolean;
  /** Why, in a sentence, for diagnostics and for the deploy docs. */
  note: string;
}

/**
 * Hosts that are genuinely local. Everything else is over the public internet
 * and gets TLS whether the URL asked for it or not — a connection string
 * copied without `?sslmode=require` should not silently downgrade a production
 * database to plaintext.
 */
function isLocalHost(host: string): boolean {
  return host === 'localhost'
    || host === '127.0.0.1'
    || host === '::1'
    || host === '[::1]'
    || host.endsWith('.localhost')
    // Docker and CI service containers.
    || host === 'postgres'
    || host === 'db'
    || host === 'host.docker.internal';
}

/**
 * Work out TLS and prepared-statement settings for a connection string.
 *
 * Rules, in order:
 *   1. An explicit `?sslmode=` in the URL always wins. If somebody wrote it,
 *      they meant it.
 *   2. Localhost and any database whose name ends in `_test` connect without
 *      TLS. Local Postgres is usually not configured for it, and requiring it
 *      would mean the test suite could not run on a plain `initdb`.
 *   3. Everything else gets `require`.
 *
 * `require` encrypts but does not verify the server's certificate chain.
 * `verify-full` does, and is better — it needs the provider's CA available to
 * Node, so it is opt-in through the URL rather than a default that would break
 * the first deploy with an unhelpful handshake error.
 */
export function connectionShape(url: string): ConnectionShape {
  let host = '';
  let database = '';
  let sslmode: string | null = null;

  try {
    const parsed = new URL(url);
    host = parsed.hostname;
    database = parsed.pathname.replace(/^\//, '');
    sslmode = parsed.searchParams.get('sslmode');
  } catch {
    // An unparseable URL is postgres.js's problem to report, not ours. Assume
    // the safe thing in the meantime.
    return { ssl: 'require', prepare: false, note: 'connection string could not be parsed; assuming TLS' };
  }

  // Prepared statements are off everywhere, not just on the pooler. The
  // alternative — on locally, off in production — means the test suite
  // exercises a protocol path production never takes, and this project has
  // already been bitten once by tests running in a configuration production
  // does not use. The cost at this volume is unmeasurable.
  const prepare = false;

  if (sslmode) {
    const mode = sslmode.toLowerCase();
    if (mode === 'disable') {
      return { ssl: false, prepare, note: 'TLS disabled by ?sslmode=disable in the URL' };
    }
    if (mode === 'verify-full' || mode === 'verify-ca') {
      return { ssl: 'verify-full', prepare, note: 'TLS with certificate verification, from ?sslmode in the URL' };
    }
    if (mode === 'allow' || mode === 'prefer') {
      return { ssl: mode, prepare, note: `TLS ${mode}, from ?sslmode in the URL` };
    }
    return { ssl: 'require', prepare, note: 'TLS required, from ?sslmode in the URL' };
  }

  if (isLocalHost(host) || database.endsWith('_test')) {
    return { ssl: false, prepare, note: 'local or test database, so no TLS' };
  }

  return { ssl: 'require', prepare, note: 'remote host and the URL did not say, so TLS is required' };
}
