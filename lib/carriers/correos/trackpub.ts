import { normalisePayload, type NormaliseOutcome } from './normalise';

/**
 * Asking Correos where a parcel is.
 *
 * Used for two things: an on-demand lookup when somebody is staring at a
 * parcel and wants to know now, and the nightly sweep that is the safety net
 * for push. Push has no guaranteed retry, so if the receiver was down for an
 * hour the only thing that ever notices is this.
 *
 * Rate limits are respected rather than discovered: the client backs off and
 * resumes, and a sweep that runs out of budget stops cleanly and picks up
 * where it left off tomorrow instead of getting the account blocked.
 */

const DEFAULT_BASE = 'https://api1.correos.es/support/trackpub/api/v2';

export interface TrackpubOptions {
  baseUrl?: string;
  clientId?: string;
  clientSecret?: string;
  jwt?: string;
  /** Requests per second. Correos' published limit, halved, by default. */
  ratePerSecond?: number;
  maxRetries?: number;
}

export type LookupResult =
  | { ok: true; outcome: NormaliseOutcome; raw: unknown }
  | { ok: false; status: number | null; error: string; retryable: boolean };

export class TrackpubClient {
  private readonly baseUrl: string;
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly jwt: string;
  private readonly minGapMs: number;
  private readonly maxRetries: number;
  private nextSlot = 0;

  constructor(opts: TrackpubOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? process.env.CORREOS_TRACKPUB_BASE_URL ?? DEFAULT_BASE).replace(/\/$/, '');
    this.clientId = opts.clientId ?? process.env.CORREOS_CLIENT_ID ?? '';
    this.clientSecret = opts.clientSecret ?? process.env.CORREOS_CLIENT_SECRET ?? '';
    this.jwt = opts.jwt ?? process.env.CORREOS_JWT ?? '';
    this.minGapMs = 1000 / Math.max(0.1, opts.ratePerSecond ?? 2);
    this.maxRetries = opts.maxRetries ?? 3;
  }

  get configured(): boolean {
    return Boolean(this.clientId && this.clientSecret && this.jwt);
  }

  async lookup(shippingCode: string): Promise<LookupResult> {
    if (!this.configured) {
      return { ok: false, status: null, error: 'Correos credentials are not configured', retryable: false };
    }

    const url = `${this.baseUrl}/search/${encodeURIComponent(shippingCode)}`;

    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      await this.waitForSlot();

      let res: Response;
      try {
        res = await fetch(url, {
          headers: {
            client_id: this.clientId,
            client_secret: this.clientSecret,
            Authorization: `Bearer ${this.jwt}`,
            Accept: 'application/json',
          },
          signal: AbortSignal.timeout(20_000),
        });
      } catch (err) {
        if (attempt === this.maxRetries) {
          return { ok: false, status: null, error: message(err), retryable: true };
        }
        await sleep(backoffMs(attempt));
        continue;
      }

      // Too many requests, or their side is unwell. Both mean: wait longer.
      if (res.status === 429 || res.status >= 500) {
        const retryAfter = Number(res.headers.get('retry-after'));
        const wait = Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000
          : backoffMs(attempt);

        if (attempt === this.maxRetries) {
          return { ok: false, status: res.status, error: `Correos returned ${res.status}`, retryable: true };
        }
        // Hold the whole client back, not just this call: hammering on behalf
        // of one parcel is how the next thousand get blocked.
        this.nextSlot = Date.now() + wait;
        await sleep(wait);
        continue;
      }

      if (res.status === 404) {
        return { ok: false, status: 404, error: 'Correos has never heard of this code', retryable: false };
      }

      if (!res.ok) {
        return { ok: false, status: res.status, error: `Correos returned ${res.status}`, retryable: false };
      }

      const raw = await res.json().catch(() => null);
      if (raw === null) {
        return { ok: false, status: res.status, error: 'Correos returned something that was not JSON', retryable: false };
      }

      return { ok: true, outcome: normalisePayload(raw, 'poll'), raw };
    }

    return { ok: false, status: null, error: 'gave up after retries', retryable: true };
  }

  private async waitForSlot(): Promise<void> {
    const wait = this.nextSlot - Date.now();
    if (wait > 0) await sleep(wait);
    this.nextSlot = Math.max(Date.now(), this.nextSlot) + this.minGapMs;
  }
}

function backoffMs(attempt: number): number {
  // 1s, 2s, 4s, with a little jitter so a sweep does not retry in lockstep.
  return Math.round((2 ** attempt) * 1000 * (0.75 + Math.random() * 0.5));
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, Math.max(0, ms)));
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

let cached: TrackpubClient | null = null;
export function trackpub(): TrackpubClient {
  cached ??= new TrackpubClient();
  return cached;
}
export function setTrackpub(c: TrackpubClient | null): void { cached = c; }
