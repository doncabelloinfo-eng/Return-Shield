import { describe, it, expect } from 'vitest';
import { connectionShape, poolerOf } from '@/db/connection';

/**
 * A connection string copied without `?sslmode=require` must not silently
 * downgrade a production database to plaintext, and a local `initdb` that has
 * never heard of TLS must still run the test suite. That is the whole job.
 */

const SUPABASE_TXN = 'postgres://postgres.abcdefgh:pw@aws-0-eu-central-1.pooler.supabase.com:6543/postgres';
const SUPABASE_SESSION = 'postgres://postgres.abcdefgh:pw@aws-0-eu-central-1.pooler.supabase.com:5432/postgres';

describe('TLS', () => {
  it('requires it for a remote host that did not ask', () => {
    const s = connectionShape(SUPABASE_TXN);
    expect(s.ssl).toBe('require');
    expect(s.note).toContain('the URL did not say');
  });

  it('honours an explicit sslmode=require', () => {
    expect(connectionShape(`${SUPABASE_SESSION}?sslmode=require`).ssl).toBe('require');
  });

  it('honours sslmode=verify-full, which is stronger than our default', () => {
    expect(connectionShape(`${SUPABASE_TXN}?sslmode=verify-full`).ssl).toBe('verify-full');
    expect(connectionShape(`${SUPABASE_TXN}?sslmode=verify-ca`).ssl).toBe('verify-full');
  });

  it('honours sslmode=disable, because somebody who wrote that meant it', () => {
    expect(connectionShape(`${SUPABASE_TXN}?sslmode=disable`).ssl).toBe(false);
  });

  it('honours allow and prefer', () => {
    expect(connectionShape(`${SUPABASE_TXN}?sslmode=allow`).ssl).toBe('allow');
    expect(connectionShape(`${SUPABASE_TXN}?sslmode=prefer`).ssl).toBe('prefer');
  });

  it('is case-insensitive about the mode', () => {
    expect(connectionShape(`${SUPABASE_TXN}?sslmode=REQUIRE`).ssl).toBe('require');
    expect(connectionShape(`${SUPABASE_TXN}?sslmode=Disable`).ssl).toBe(false);
  });

  it('skips it for localhost', () => {
    for (const host of ['localhost', '127.0.0.1', 'host.docker.internal', 'postgres', 'db']) {
      expect(connectionShape(`postgres://postgres@${host}:5432/return_shield`).ssl, host).toBe(false);
    }
  });

  it('skips it for a test database, wherever it lives', () => {
    // The suite has to be able to run against a plain initdb, and against a
    // throwaway database on a CI service container.
    expect(connectionShape('postgres://u:p@some-ci-host:5432/return_shield_test').ssl).toBe(false);
  });

  it('still requires it for a remote database whose name merely contains "test"', () => {
    expect(connectionShape('postgres://u:p@aws-0-eu-central-1.pooler.supabase.com:6543/testing').ssl).toBe('require');
  });

  it('assumes TLS when the URL cannot be parsed at all', () => {
    // Guessing wrong in the safe direction. postgres.js will report the real
    // problem; we should not have downgraded the connection on the way there.
    expect(connectionShape('not a url').ssl).toBe('require');
  });
});

describe('prepared statements', () => {
  it('are off, everywhere', () => {
    // Supabase's transaction pooler cannot do them: it multiplexes connections,
    // so a statement named on one backend does not exist on the next. Off
    // locally too, so the suite exercises the configuration production uses —
    // this project has already been bitten once by the opposite.
    for (const url of [SUPABASE_TXN, SUPABASE_SESSION, 'postgres://postgres@127.0.0.1:55432/return_shield']) {
      expect(connectionShape(url).prepare).toBe(false);
    }
  });
});

describe('which pooler a URL points at', () => {
  it('names them by port', () => {
    expect(poolerOf(SUPABASE_TXN)).toBe('transaction');
    expect(poolerOf(SUPABASE_SESSION)).toBe('session');
  });

  it('does not guess for anything else', () => {
    expect(poolerOf('postgres://postgres@127.0.0.1:55432/return_shield')).toBe('direct-or-other');
    // No port at all, which is a direct connection on the default.
    expect(poolerOf('postgres://postgres@db.abcdefgh.supabase.co/postgres')).toBe('direct-or-other');
    expect(poolerOf('not a url')).toBe('direct-or-other');
  });

  it('changes nothing about how we connect', () => {
    // Worth stating: the port is reported for logs and for the migrator's
    // warning, and that is all. TLS and `prepare` are decided by the host and
    // the database name, so moving between poolers cannot silently change the
    // protocol as well as the routing.
    const txn = connectionShape(SUPABASE_TXN);
    const session = connectionShape(SUPABASE_SESSION);
    expect(txn).toEqual(session);
  });
});
