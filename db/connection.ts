/**
 * How we connect to Postgres, in one place, so the app and the migrator cannot
 * disagree about it.
 *
 * BOTH CURRENTLY USE SUPABASE'S SESSION POOLER, PORT 5432.
 *
 * That is not what was designed. The app was meant to use the TRANSACTION
 * pooler on 6543 — it multiplexes many short-lived serverless instances onto
 * few backends, which is exactly this workload's shape — and `prepare: false`
 * below is there for it. On 6543 production broke within minutes, in three
 * ways, on 6 October:
 *
 *   1. Hangs. `/today` ran until the 300-second function limit and returned
 *      504, repeatedly.
 *
 *   2. Crossed parameters, which is the frightening one. This query
 *
 *        select "shipment_id", "at", "outcome", "note" from "contact_log"
 *         where "contact_log"."shipment_id" in ($1, $2, $3)
 *
 *      was executed with ['PAQ ESTÁNDAR', 'PAQ 48', 'PAQ PREMIUM'] — another
 *      query's parameters, from a product-rules lookup running concurrently.
 *      It failed with `22P02 invalid input syntax for type uuid`, and the
 *      error named `unnamed portal parameter $1`. The stack ran through
 *      `Promise.all`.
 *
 *   3. `57014 canceling statement due to statement timeout` on push-drain's
 *      `INSERT INTO job_locks … ON CONFLICT`.
 *
 * The likely cause: postgres.js pipelines concurrent queries down one
 * connection, and Supavisor's transaction mode can route those statements to
 * different backends, so one query's Bind lands on another's unnamed portal.
 * `prepare: false` does not prevent it — the problem is the unnamed portals
 * and the pipelining, not named prepared statements.
 *
 * Two things follow. The parameter crossing is a CORRECTNESS failure, not a
 * performance one: it was caught here only because a uuid column rejected a
 * product code. Two queries whose parameters are type-compatible would have
 * crossed silently and returned one parcel's contact log under another
 * parcel's name. And `prepare` stays `false` regardless, because it is also
 * the right setting for any pooler and costs nothing at this volume.
 *
 * On 5432 the same pages and jobs work. The cost is in `db/index.ts`.
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
  //
  // Keep it off even though the app is on the session pooler, where prepared
  // statements would work: if transaction mode is ever made safe, this must
  // not be a second thing to remember.
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

/**
 * Which Supabase pooler a URL points at, by port, for logs and diagnostics.
 *
 * Worth naming because the two behave differently in ways that do not look
 * like a connection problem — see the note at the top of this file — and
 * because `6543` and `5432` are one transposition apart.
 */
export function poolerOf(url: string): 'transaction' | 'session' | 'direct-or-other' {
  try {
    const port = new URL(url).port;
    if (port === '6543') return 'transaction';
    if (port === '5432') return 'session';
    return 'direct-or-other';
  } catch {
    return 'direct-or-other';
  }
}
