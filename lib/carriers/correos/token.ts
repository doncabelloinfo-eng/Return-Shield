/**
 * Getting a JWT for Correos' API gateway.
 *
 * trackpub needs three things on every call: the gateway's `client_id` and
 * `client_secret` from the developer-portal app, and a bearer token.
 *
 * CONFIRMED against production on 6 October:
 *
 *   POST https://apioauthcid.correos.es/Api/Authorize/Token
 *   form-encoded: grant_type=client_credentials, client_id, client_secret,
 *                 scope=TPB
 *   → { idToken: "<jwt>", tokenType: "Bearer", expiresIn: 1800 }
 *
 * The JWT carries `aud=TPB`, `iss=CID` and `oid=<CorreosID client id>`, and
 * lasts thirty minutes.
 *
 * THE SCOPE IS `TPB`, and the scope is the whole thing. `TPB` is trackpub's
 * application code in CorreosID; Correos support confirmed it. Two
 * open-source SDKs use `AP3 LBS RCG`, which is what this file shipped with,
 * and a token minted with that scope is issued perfectly happily and then
 * rejected by trackpub with `401 {"error": "Invalid token."}`. Nothing about
 * the failure points at the scope, which is why it cost a day. The URL, the
 * scope and the field read are all still overridable by environment variable.
 *
 * NOTHING IN THIS FILE LOGS A TOKEN OR A SECRET. Not in an error message, not
 * in a debug line, not on a failure path. A token in a log is a token in
 * whatever ships logs, and this one is good for thirty minutes against a live
 * carrier account.
 */

import { env, envOr } from '@/lib/env';

const DEFAULT_TOKEN_URL = 'https://apioauthcid.correos.es/Api/Authorize/Token';

/**
 * trackpub's application code in CorreosID. Confirmed by Correos support and
 * by a working production token. Do not replace this with the `AP3 LBS RCG`
 * the open-source SDKs use: that mints a token trackpub will not accept.
 */
const DEFAULT_SCOPE = 'TPB';

/** Renew this long before `exp`, so an in-flight request cannot expire mid-call. */
const RENEW_MARGIN_MS = 60_000;

/** Used when the token carries no readable `exp`. Production lifetime is ~30 min. */
const ASSUMED_LIFETIME_MS = 25 * 60_000;

export interface TokenOptions {
  tokenUrl?: string;
  clientId?: string;
  clientSecret?: string;
  scope?: string;
  /** Which response field holds the JWT. Tried in order. */
  responseFields?: string[];
  /** A token supplied by hand, for testing. Bypasses the endpoint entirely. */
  staticToken?: string;
  /** Injected for tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

export type TokenResult =
  | { ok: true; token: string; expiresAt: Date; source: 'cache' | 'fetched' | 'override' }
  | { ok: false; status: number | null; error: string };

interface CachedToken {
  token: string;
  /** When we stop using it — already includes the renewal margin. */
  renewAfterMs: number;
  /** The real expiry, for the Settings screen to show. */
  expiresAtMs: number;
}

/**
 * One cache per instance, parked on globalThis so Next's hot reload and
 * repeated module evaluation inside one serverless instance share it. There is
 * no point caching across instances: a token is cheap to mint and a shared
 * cache would need a round trip to read anyway.
 */
const globalForToken = globalThis as unknown as { __rsCorreosToken?: CachedToken };

export class CorreosTokenProvider {
  private readonly tokenUrl: string;
  private readonly scope: string;
  private readonly responseFields: string[];
  private readonly fetchImpl: typeof fetch;
  private readonly staticTokenOverride?: string;
  private readonly explicitId?: string;
  private readonly explicitSecret?: string;

  /** Collapses concurrent callers onto one request. */
  private inFlight: Promise<TokenResult> | null = null;

  constructor(opts: TokenOptions = {}) {
    // `env`, not `??`, on every one of these: a variable added with no value
    // is the empty string, not undefined, so `??` would hand us an empty token
    // URL and an empty scope. See lib/env.ts.
    this.tokenUrl = opts.tokenUrl ?? envOr('CORREOS_TOKEN_URL', DEFAULT_TOKEN_URL);
    this.scope = opts.scope ?? envOr('CORREOS_OAUTH_SCOPE', DEFAULT_SCOPE);
    this.responseFields = opts.responseFields
      ?? splitFields(env('CORREOS_OAUTH_RESPONSE_FIELD'))
      ?? ['idToken', 'access_token'];
    this.fetchImpl = opts.fetchImpl ?? ((...args) => fetch(...args));
    this.staticTokenOverride = opts.staticToken;
    this.explicitId = opts.clientId;
    this.explicitSecret = opts.clientSecret;
  }

  private get clientId(): string {
    return this.explicitId?.trim() ?? env('CORREOS_OAUTH_CLIENT_ID') ?? '';
  }

  private get clientSecret(): string {
    return this.explicitSecret?.trim() ?? env('CORREOS_OAUTH_CLIENT_SECRET') ?? '';
  }

  /** A hand-supplied token, for testing against pre-production. */
  private get override(): string {
    return this.staticTokenOverride?.trim() ?? env('CORREOS_JWT') ?? '';
  }

  /** Can we mint a token at all? */
  get configured(): boolean {
    return Boolean(this.override) || Boolean(this.clientId && this.clientSecret);
  }

  /**
   * A usable token. Cached until `exp` minus a minute; concurrent callers share
   * one request rather than each minting their own.
   */
  async get(nowMs: number): Promise<TokenResult> {
    const override = this.override;
    if (override) {
      // A manual token is taken at face value: if it carries an `exp` we report
      // it, and if it has expired that is the operator's problem to see on the
      // Settings screen rather than something to silently work around.
      const exp = expiryOf(override);
      return {
        ok: true,
        token: override,
        expiresAt: new Date(exp ?? nowMs + ASSUMED_LIFETIME_MS),
        source: 'override',
      };
    }

    const cached = globalForToken.__rsCorreosToken;
    if (cached && cached.renewAfterMs > nowMs) {
      return { ok: true, token: cached.token, expiresAt: new Date(cached.expiresAtMs), source: 'cache' };
    }

    if (this.inFlight) return this.inFlight;

    this.inFlight = this.fetchToken(nowMs).finally(() => { this.inFlight = null; });
    return this.inFlight;
  }

  /** Throw the cached token away. Called when Correos answers 401. */
  invalidate(): void {
    globalForToken.__rsCorreosToken = undefined;
  }

  private async fetchToken(nowMs: number): Promise<TokenResult> {
    if (!this.clientId || !this.clientSecret) {
      return {
        ok: false,
        status: null,
        error: 'CORREOS_OAUTH_CLIENT_ID and CORREOS_OAUTH_CLIENT_SECRET are not set',
      };
    }

    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: this.clientId,
      client_secret: this.clientSecret,
      scope: this.scope,
    });

    let res: Response;
    try {
      res = await this.fetchImpl(this.tokenUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        body: body.toString(),
        // A POST is not cacheable, so this is belt and braces rather than a
        // fix — but a token is the last thing that should ever be served from
        // a cache, and the guard test holds every outbound call to one rule
        // rather than asking each reader to work out which ones are exempt.
        cache: 'no-store',
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      return { ok: false, status: null, error: `could not reach the token endpoint: ${reason(err)}` };
    }

    const text = await res.text().catch(() => '');

    if (!res.ok) {
      // The body of a failed token request is the only thing that explains why,
      // so it is worth surfacing — but it is also the one place a secret could
      // be echoed back. Redact anything that looks like our own credentials,
      // and cap the length.
      return {
        ok: false,
        status: res.status,
        error: `the token endpoint returned ${res.status}: ${this.redact(text).slice(0, 300)}`,
      };
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(text) as Record<string, unknown>;
    } catch {
      return { ok: false, status: res.status, error: 'the token endpoint did not return JSON' };
    }

    const token = this.readToken(parsed);
    if (!token) {
      // Name the fields we looked in and the ones we got, so a change on their
      // side is diagnosable. The VALUES are never printed.
      return {
        ok: false,
        status: res.status,
        error: `no token in the response — looked for ${this.responseFields.join(' or ')}, `
          + `got ${Object.keys(parsed).join(', ') || 'an empty object'}`,
      };
    }

    const expiresAtMs = expiryOf(token)
      ?? expiresInOf(parsed, nowMs)
      ?? nowMs + ASSUMED_LIFETIME_MS;

    globalForToken.__rsCorreosToken = {
      token,
      // Never renew in the past: a token that is already expired would
      // otherwise be re-fetched on every single call.
      renewAfterMs: Math.max(nowMs + 1_000, expiresAtMs - RENEW_MARGIN_MS),
      expiresAtMs,
    };

    return { ok: true, token, expiresAt: new Date(expiresAtMs), source: 'fetched' };
  }

  private readToken(parsed: Record<string, unknown>): string | null {
    for (const field of this.responseFields) {
      const value = parsed[field];
      if (typeof value === 'string' && value.trim()) return value.trim();
    }
    return null;
  }

  private redact(text: string): string {
    let out = text;
    for (const secret of [this.clientSecret, this.clientId]) {
      if (secret && secret.length >= 6) out = out.split(secret).join('[redacted]');
    }
    return out;
  }
}

/* -------------------------------------------------------------------------- */

/**
 * The `exp` claim, in milliseconds, or null.
 *
 * Deliberately total: a token we cannot read is not an error, it just means we
 * fall back to assuming the documented lifetime. Throwing here would turn a
 * cosmetic surprise in their JWT into an outage in our sweep.
 */
export function expiryOf(jwt: string): number | null {
  const parts = jwt.split('.');
  if (parts.length < 2) return null;

  try {
    const payload = Buffer.from(padBase64(parts[1]), 'base64').toString('utf8');
    const claims = JSON.parse(payload) as { exp?: unknown };
    if (typeof claims.exp !== 'number' || !Number.isFinite(claims.exp)) return null;
    // `exp` is seconds since the epoch. A value that looks like milliseconds
    // already is a bug on their side; treating it as seconds would park the
    // expiry 50,000 years out and we would never renew.
    if (claims.exp > 1e12) return null;
    return claims.exp * 1000;
  } catch {
    return null;
  }
}

/** OAuth's own `expires_in`, as a fallback when the JWT has no readable `exp`. */
function expiresInOf(parsed: Record<string, unknown>, nowMs: number): number | null {
  const raw = parsed.expires_in ?? parsed.expiresIn;
  const seconds = typeof raw === 'string' ? Number(raw) : raw;
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) return null;
  return nowMs + seconds * 1000;
}

function padBase64(s: string): string {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  return b64 + '='.repeat((4 - (b64.length % 4)) % 4);
}

function splitFields(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  const fields = value.split(',').map((f) => f.trim()).filter(Boolean);
  return fields.length ? fields : undefined;
}

function reason(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/* -------------------------------------------------------------------------- */

let cached: CorreosTokenProvider | null = null;

export function correosToken(): CorreosTokenProvider {
  cached ??= new CorreosTokenProvider();
  return cached;
}

/** Tests swap the provider; nothing else should. */
export function setCorreosToken(p: CorreosTokenProvider | null): void {
  cached = p;
  globalForToken.__rsCorreosToken = undefined;
}

/** Tests clearing state between cases. */
export function clearTokenCache(): void {
  globalForToken.__rsCorreosToken = undefined;
}
