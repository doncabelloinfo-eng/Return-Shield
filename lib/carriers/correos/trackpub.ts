import { normalisePayload, type NormaliseOutcome, type ShipmentError } from './normalise';
import { CorreosTokenProvider, correosToken } from './token';
import { env, envOr } from '@/lib/env';

/**
 * Asking Correos where a parcel is.
 *
 * Push (Track&TracePush) is not configured, so this is not a safety net — it is
 * the only way tracking reaches the system at all. About a thousand parcels a
 * day are shipped, so roughly five thousand are live at any moment and every
 * one has to be refreshed at least twice a day. One request per parcel would be
 * 10,000 calls a day against a gateway that rate-limits and publishes no
 * numbers, so batching is not an optimisation here, it is the only way the
 * volume fits.
 *
 * Every call carries three things: the gateway's `client_id` and
 * `client_secret` headers, and a bearer token from CorreosID (see ./token.ts).
 *
 * The batch format is the awkward part. The /search documentation says "Se
 * permite consultar un máximo de 100 envíos por petición" and then does not say
 * how to send more than one. So this guesses comma-separated, checks whether
 * the answer actually covered the codes it asked about, and NARROWS when it
 * did not.
 *
 * Narrowing, not giving up. A refused batch used to drop straight to one
 * request per code, permanently — and on production a batch of 75 was refused
 * with an HTML 403, so all 201 parcels got their own request and nobody knew
 * whether 37 would have worked. Now a refusal halves the size and tries again:
 * 75 → 37 → 18 → 9 → 4 → 2, and only a refused batch of two means one parcel
 * per request. The largest size that worked is remembered in settings, and
 * once a day the sweep tries double it, because a gateway's limit is not a law
 * of nature and a number written down for good would never be revisited.
 *
 * Why it is worth the trouble when the operator has said one-per-request is
 * acceptable: Vercel bills memory for the whole time a function is alive, and
 * this sweep spends nearly all of its life waiting on Correos. Batches do not
 * make it cheaper per parcel, they make the run SHORTER — which is the thing
 * being billed.
 *
 * The thing that must never happen: a batch that returns 200 while covering
 * three of the hundred codes sent, read as "97 parcels have no news". That
 * would stamp 97 parcels as freshly checked without checking them, and their
 * countdowns would go stale invisibly. Coverage is therefore checked per code,
 * and anything not covered is either looked up singly or reported as an error.
 */

const DEFAULT_BASE = 'https://api1.correos.es/support/trackpub/api/v2';

/** Correos' documented ceiling. */
export const MAX_BATCH = 100;

/**
 * A ceiling on the path, as well as on the count.
 *
 * Nothing documents a URL limit, and a gateway that has one answers 414 or 400
 * — which the format check would read as "comma-separated does not work" and
 * downgrade on, permanently. A hundred ordinary 14-character codes is about
 * 1,500 bytes, so this changes nothing today and catches the case where the
 * codes are longer than the ones we have seen.
 */
const MAX_PATH_BYTES = 1800;

/**
 * The smallest batch worth asking for.
 *
 * Below this there is nothing left to halve: a "batch" of one IS one request
 * per parcel, so a refused two means single. Named rather than inlined because
 * the halving ladder and the test that walks it both have to agree on where it
 * stops.
 */
export const MIN_BATCH = 2;

/**
 * Halve a refused size, never below one.
 *
 * `Math.floor`, so 75 → 37 → 18 → 9 → 4 → 2 → 1, and 1 is the single path.
 */
export function halve(size: number): number {
  return Math.max(1, Math.floor(size / 2));
}

/**
 * Double a known-good size, for the once-a-day probe. Capped at the documented
 * ceiling, and 0 (nothing known) means try the ceiling itself.
 */
export function nextSizeUp(known: number): number {
  if (known <= 0) return MAX_BATCH;
  return Math.min(MAX_BATCH, Math.max(MIN_BATCH, known * 2));
}

/**
 * Is it time to try a larger batch again?
 *
 * Once a day, and on the first run after a deploy (an empty stamp). A gateway
 * limit is not a law of nature — Correos can change it, and a size written
 * down for good would never be revisited — but probing costs a refused request
 * on every run if it is not rationed, so it is rationed.
 */
export function shouldProbeLargerBatch(probedAt: string, at: Date): boolean {
  if (!probedAt) return true;
  const last = Date.parse(probedAt);
  if (!Number.isFinite(last)) return true;
  return at.getTime() - last >= 24 * 60 * 60 * 1000;
}

export interface TrackpubOptions {
  baseUrl?: string;
  clientId?: string;
  clientSecret?: string;
  /** Requests per second. No published limit, so this is a guess, kept low. */
  ratePerSecond?: number;
  maxRetries?: number;
  tokenProvider?: CorreosTokenProvider;
  /** What we already know about the batch format, from settings. */
  batchMode?: BatchMode;
  /**
   * The largest size Correos has been seen to accept, from settings. 0 means
   * nothing is known and the full `MAX_BATCH` is worth trying; 1 means one
   * request per parcel.
   */
  batchSize?: number;
  /** Injected for tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

/**
 * What one HTTP GET came back with.
 *
 * The failure half is `LookupResult`'s, by construction rather than by being
 * written out again: it was written out again, the two drifted, and a
 * `definitive` flag added to one of them was silently dropped by the other.
 */
type GetResult =
  | { ok: true; body: unknown }
  | Extract<LookupResult, { ok: false }>;

export type LookupResult =
  | { ok: true; outcome: NormaliseOutcome; raw: unknown }
  | {
    ok: false;
    status: number | null;
    error: string;
    /** Worth trying again shortly: a 429, a 5xx, a dropped connection. */
    retryable: boolean;
    /**
     * Correos has given a final answer ABOUT THIS CODE, and the answer is bad.
     * A 404, or an `error` block naming it. Asking again in three hours will
     * say the same thing, so the sweep counts the parcel as checked.
     *
     * Deliberately not the same as `!retryable`, and this is the distinction
     * that matters most in this file. A 401, a 403 and missing credentials are
     * all non-retryable too — and they are about the ACCOUNT, not the parcel.
     * Treating those as final would stamp every live parcel as freshly checked
     * on the strength of an authentication failure, which is precisely the
     * silent-stale-countdown failure the whole design is built to prevent.
     */
    definitive?: boolean;
  };

/**
 * `unknown` — we have not tried a batch yet and will probe.
 * `comma`   — comma-separated works; keep using it.
 * `single`  — it does not; one request per code.
 */
export type BatchMode = 'unknown' | 'comma' | 'single';

export interface BatchLookupResult {
  /**
   * One outcome per code we got to. Together with `notReached` this always
   * covers every code that was passed in — a code in neither is a bug here,
   * not a parcel with no news.
   */
  byCode: Map<string, LookupResult>;
  /**
   * Codes the deadline arrived before we could ask about. Not errors: nothing
   * was learnt about them, so the caller must leave them exactly as they were
   * and come back to them.
   */
  notReached: string[];
  /**
   * What the client now knows about the format — which may still be 'unknown'.
   *
   * Four paths learn nothing: not configured, nothing to look up, the deadline
   * arriving before the first request, and a one-code call (which short-cuts
   * to the single path without testing anything). Reporting those as 'single'
   * would let a caller persist a verdict that was never reached and disable
   * batching for good.
   */
  mode: BatchMode;
  /** HTTP requests actually made, for the job's detail line. */
  requests: number;
  /** Why the batch format was rejected, when it was. Null when it worked. */
  batchDiagnosis: string | null;
  /**
   * The largest size that actually worked in this run, for settings to keep.
   *
   * 1 means one request per parcel. 0 means nothing was learnt — not
   * configured, nothing to look up, or the deadline arrived first — and the
   * caller must leave the stored size alone rather than write a verdict that
   * was never reached.
   */
  batchSize: number;
}

export class TrackpubClient {
  private readonly baseUrl: string;
  private readonly explicitId?: string;
  private readonly explicitSecret?: string;
  private readonly minGapMs: number;
  private readonly maxRetries: number;
  private readonly tokens: CorreosTokenProvider;
  private readonly fetchImpl: typeof fetch;
  private nextSlot = 0;
  private batchMode: BatchMode;
  private lastDiagnosis: string | null = null;
  /**
   * The size to try next, and the largest that has worked.
   *
   * `batchLimit` only ever comes DOWN during a run: the ladder halves it on a
   * refusal, so once 37 has been refused this run does not go back to asking
   * for 75 on the next chunk. `provenSize` only ever goes UP, and is what gets
   * written back to settings.
   */
  private batchLimit: number;
  private provenSize = 0;
  /**
   * A refusal happened, so the size came DOWN in this run.
   *
   * It decides whether the caller may lower the remembered size. Without it, a
   * quiet run that only had six parcels to ask about would write 6 back as the
   * largest size that works and undo everything the ladder learnt.
   */
  private narrowedDown = false;

  constructor(opts: TrackpubOptions = {}) {
    // `envOr`, not `??`: an empty CORREOS_TRACKPUB_BASE_URL made this `''`,
    // every lookup fetched the bare path as a relative URL, and production
    // answered "Failed to parse URL from /search/PK…" — which names no
    // variable at all. See lib/env.ts.
    this.baseUrl = (opts.baseUrl ?? envOr('CORREOS_TRACKPUB_BASE_URL', DEFAULT_BASE)).replace(/\/$/, '');
    this.explicitId = opts.clientId;
    this.explicitSecret = opts.clientSecret;
    this.minGapMs = 1000 / Math.max(0.1, opts.ratePerSecond ?? 2);
    this.maxRetries = opts.maxRetries ?? 3;
    this.tokens = opts.tokenProvider ?? correosToken();
    this.fetchImpl = opts.fetchImpl ?? ((...args) => fetch(...args));
    this.batchMode = opts.batchMode ?? 'unknown';
    // A remembered size of 1 is a real answer — one request per parcel — and
    // has to survive, so the fallback is on 0/undefined rather than on falsy.
    //
    // `provenSize` is deliberately NOT seeded from it. It means "a size this
    // run demonstrated", and a size handed in has not been demonstrated by
    // anything yet — least of all on the daily probe, where the whole point is
    // that it might be refused.
    const remembered = opts.batchSize ?? 0;
    this.batchLimit = remembered > 0 ? Math.min(MAX_BATCH, remembered) : MAX_BATCH;
    if (this.batchLimit === 1) this.batchMode = 'single';
  }

  private get clientId(): string {
    return this.explicitId ?? env('CORREOS_CLIENT_ID') ?? '';
  }

  private get clientSecret(): string {
    return this.explicitSecret ?? env('CORREOS_CLIENT_SECRET') ?? '';
  }

  /**
   * Both credential pairs have to be present: the gateway headers AND something
   * that can mint a token. Three out of four is not configured, it is a
   * configuration half-finished, and reporting it as ready would mean the sweep
   * silently does nothing while the Settings screen says everything is fine.
   */
  get configured(): boolean {
    return Boolean(this.clientId && this.clientSecret) && this.tokens.configured;
  }

  get mode(): BatchMode { return this.batchMode; }
  get diagnosis(): string | null { return this.lastDiagnosis; }
  /**
   * The largest size this run actually demonstrated, or 0 if nothing was.
   *
   * It is a floor, not a ceiling: a run with six parcels to ask about proves
   * six works and says nothing about eighteen. Only `narrowed` licenses the
   * caller to lower a remembered size.
   */
  get batchSize(): number { return this.provenSize; }
  /** A refusal lowered the size in this run, so a smaller size is the truth. */
  get narrowed(): boolean { return this.narrowedDown; }
  /** The size the next request will ask for. Exposed for the tests. */
  get limit(): number { return this.batchLimit; }

  /**
   * Take a mode from stored settings.
   *
   * An operator resetting the setting to 'unknown' is asking for the format to
   * be probed again, so that always applies. Anything else only fills a gap:
   * what this instance has learnt by actually trying beats what was written
   * down before it started.
   */
  adoptMode(mode: BatchMode): void {
    if (mode === 'unknown') {
      this.batchMode = 'unknown';
      this.lastDiagnosis = null;
      return;
    }
    if (this.batchMode === 'unknown') this.batchMode = mode;
  }

  /* ---------------------------------------------------------------- single */

  async lookup(shippingCode: string): Promise<LookupResult> {
    if (!this.configured) return notConfigured();

    const code = shippingCode.trim().toUpperCase();
    const res = await this.get(`/search/${encodeURIComponent(code)}`);
    if (!res.ok) return res;

    const outcome = normalisePayload(res.body, 'poll');

    // Correos reports a bad code inside a 200, in the shipment's own `error`
    // block. Returning ok here would have the sweep stamp the parcel as
    // freshly checked on the strength of an error message.
    const failed = shipmentErrorFor(outcome, code);
    if (failed) return failed;

    return { ok: true, outcome, raw: res.body };
  }

  /* ----------------------------------------------------------------- batch */

  /**
   * Look up many codes, in requests of at most 100.
   *
   * Every code passed in comes back in `byCode`, with either a result or an
   * error. A code the caller does not find in the map is a bug in this method,
   * not a parcel with no news.
   */
  async lookupMany(
    codes: readonly string[],
    opts: {
      deadline?: number;
      /**
       * Called with the running count of codes answered, after each request.
       *
       * This exists for the progress bar, and it has to be here rather than in
       * the caller's loop: the caller cannot report anything until
       * `lookupMany` returns, and `lookupMany` is where all the time goes. The
       * bar sat at "0 of 12" for eight seconds and then jumped to 100%,
       * because that is exactly when the caller found out.
       *
       * Deliberately a count of codes ANSWERED rather than of requests made —
       * one request can answer eighteen parcels, and the bar is about parcels.
       */
      onAnswered?: (answered: number) => void | Promise<void>;
    } = {},
  ): Promise<BatchLookupResult> {
    const wanted = [...new Set(codes.map((c) => c.trim().toUpperCase()).filter(Boolean))];
    const byCode = new Map<string, LookupResult>();
    const settled = (): BatchLookupResult => ({
      byCode,
      notReached: wanted.filter((c) => !byCode.has(c)),
      mode: this.batchMode,
      requests,
      batchDiagnosis: this.lastDiagnosis,
      batchSize: this.provenSize,
    });

    let requests = 0;

    if (!this.configured) {
      for (const code of wanted) byCode.set(code, notConfigured());
      return settled();
    }

    // A caller with a time budget hands us its deadline so we can stop between
    // requests rather than only between batches. It matters: a batch of a
    // hundred that falls back to one-request-per-parcel is a hundred requests,
    // and a budget that can only be checked after all of them is not a budget.
    const outOfTime = () => opts.deadline !== undefined && Date.now() >= opts.deadline;

    /*
     * Re-chunked on every pass, because the batch limit can come DOWN mid-run.
     *
     * When Correos refuses a batch, `runCommaChunk` halves the limit and
     * returns WITHOUT answering those codes; this loop then re-splits whatever
     * is still unanswered at the new, smaller size and tries again. That is
     * the ladder: 75 → 37 → 18 → 9 → 4 → 2, and a refused 2 means one request
     * per parcel.
     *
     * It terminates because each pass either answers a code or lowers the
     * limit, and the limit is halved from the length of a chunk that was
     * refused — so it strictly decreases and bottoms out at the single path.
     * The `progress` check below is the belt to that braces: a pass that does
     * neither stops, rather than spinning against a gateway that is down.
     */
    for (;;) {
      if (outOfTime()) break;

      const left = wanted.filter((c) => !byCode.has(c));
      if (!left.length) break;

      const limitBefore = this.batchLimit;
      const answeredBefore = byCode.size;

      for (const chunk of chunksOf(left, this.batchLimit)) {
        if (outOfTime()) break;

        if (this.batchMode === 'single' || chunk.length === 1) {
          requests += await this.runSingles(chunk, byCode, outOfTime, opts.onAnswered);
          continue;
        }

        requests += await this.runCommaChunk(chunk, byCode, outOfTime, opts.onAnswered);
        await opts.onAnswered?.(byCode.size);

        // The limit just fell. Stop splitting at a size already known to be
        // refused and come round again at the smaller one.
        if (this.batchLimit < limitBefore) break;
      }

      const progress = byCode.size > answeredBefore || this.batchLimit < limitBefore;
      if (!progress) break;
    }

    return settled();
  }

  /**
   * One comma-separated attempt at a chunk, narrowing rather than giving up.
   *
   * Each code is encoded on its own and then joined: encoding the joined string
   * would turn the commas into %2C and ask Correos about one parcel with a very
   * strange name.
   *
   * On a refusal this does NOT answer the codes. It halves the limit and
   * returns, and `lookupMany` re-splits them at the smaller size — which is
   * what turns one refusal into a ladder instead of a permanent downgrade.
   */
  private async runCommaChunk(
    chunk: string[],
    byCode: Map<string, LookupResult>,
    outOfTime: () => boolean,
    onAnswered?: (answered: number) => void | Promise<void>,
  ): Promise<number> {
    const path = `/search/${chunk.map((c) => encodeURIComponent(c)).join(',')}`;
    const proven = this.batchMode === 'comma';

    const res = await this.get(path);
    let requests = 1;

    if (!res.ok) {
      // Rate limited or their side is unwell: nothing to do with the format.
      // Report it for the whole chunk and leave the limit alone, so the next
      // run still gets to use batches.
      if (res.retryable) {
        for (const code of chunk) byCode.set(code, res);
        return requests;
      }

      // 400 means the URL shape was rejected. 404 is ambiguous: on a format we
      // have already proved works it means "none of these codes are known",
      // but on the very first probe it much more likely means the shape is
      // wrong. Treating those two the same is how every parcel in a batch gets
      // written off as unknown to Correos.
      if (res.status === 404 && proven) {
        for (const code of chunk) {
          byCode.set(code, {
            ok: false, status: 404, error: NEVER_HEARD_OF_IT, retryable: false, definitive: true,
          });
        }
        return requests;
      }

      return requests + await this.narrow(
        chunk,
        byCode,
        outOfTime,
        `a batch of ${chunk.length} was refused with ${res.status ?? 'a transport error'}`
          + ` (${res.error})`,
        onAnswered,
      );
    }

    const outcome = normalisePayload(res.body, 'poll');
    const covered = new Set(outcome.codesSeen);
    const missing = chunk.filter((c) => !covered.has(c));

    if (missing.length === chunk.length) {
      // A 200 that mentions none of the codes we asked about is not an answer
      // about those parcels, whatever else it contains.
      //
      // But do NOT conclude the format is broken if we have already seen it
      // work. A whole chunk can legitimately come back empty: the sweep queues
      // parcels in `created`, which is a run of freshly printed labels Correos
      // has not scanned yet, and none of those codes exists on their side.
      // Narrowing on that would turn fifty requests a run into five thousand,
      // and the trigger would be a perfectly normal import.
      if (proven) return requests + await this.runSingles(chunk, byCode, outOfTime, onAnswered);

      return requests + await this.narrow(
        chunk,
        byCode,
        outOfTime,
        `a batch of ${chunk.length} came back without any of the codes it asked about`,
        onAnswered,
      );
    }

    // At least one code came back keyed correctly, so this size works.
    if (this.batchMode !== 'comma') {
      this.batchMode = 'comma';
      this.lastDiagnosis = null;
    }
    this.provenSize = Math.max(this.provenSize, chunk.length);

    // Keep what the batch did tell us, whatever we decide about the size.
    for (const code of chunk) {
      if (!covered.has(code)) continue;
      // Same as the single path: a code Correos answered with a non-zero
      // codError was answered, so it is not re-asked, but it is not a result.
      byCode.set(code, shipmentErrorFor(outcome, code)
        ?? { ok: true, outcome: forCode(outcome, code), raw: res.body });
    }

    // More than half missing from a format we trust is a regression, not a
    // handful of unknown codes. Narrow for the rest of the run — but only
    // re-ask the ones we did not get, not the whole chunk.
    if (missing.length > chunk.length / 2) {
      return requests + await this.narrow(
        missing,
        byCode,
        outOfTime,
        `a batch of ${chunk.length} covered only ${chunk.length - missing.length} of them`,
        onAnswered,
      );
    }

    // The few that were left out get asked about individually. That is what
    // distinguishes "Correos has never heard of it" from "the response dropped
    // it", and it is the difference between a correct 404 and a parcel quietly
    // marked as checked.
    if (missing.length) requests += await this.runSingles(missing, byCode, outOfTime, onAnswered);

    return requests;
  }

  /**
   * A refused size: halve it and leave these codes for the next pass.
   *
   * The one case that cannot be halved is a refused `MIN_BATCH`, because the
   * next size down IS one request per parcel — so that, and only that, is what
   * sets the single mode the old code reached on the first refusal.
   *
   * Returns the requests it made, which is none unless it went single.
   */
  private async narrow(
    codes: string[],
    byCode: Map<string, LookupResult>,
    outOfTime: () => boolean,
    why: string,
    onAnswered?: (answered: number) => void | Promise<void>,
  ): Promise<number> {
    const next = halve(codes.length);

    this.narrowedDown = true;

    if (next >= MIN_BATCH) {
      this.batchLimit = Math.min(this.batchLimit, next);
      this.lastDiagnosis = `${why} — trying ${next} per request`;
      // Deliberately answers nothing: `lookupMany` re-splits these at `next`.
      return 0;
    }

    this.batchMode = 'single';
    this.batchLimit = 1;
    this.provenSize = 1;
    this.lastDiagnosis = `${why} — falling back to one request per parcel`;
    return this.runSingles(codes, byCode, outOfTime, onAnswered);
  }

  private async runSingles(
    codes: string[],
    byCode: Map<string, LookupResult>,
    outOfTime: () => boolean,
    onAnswered?: (answered: number) => void | Promise<void>,
  ): Promise<number> {
    let requests = 0;
    for (const code of codes) {
      if (outOfTime()) break;
      byCode.set(code, await this.lookup(code));
      requests += 1;
      // Per code, because on this path one code IS one request — and this is
      // the path production is on.
      await onAnswered?.(byCode.size);
    }
    return requests;
  }

  /* ------------------------------------------------------------------ http */

  /**
   * One GET, with the token, the rate limit, the 429/5xx backoff, and exactly
   * one retry after a 401.
   */
  private async get(path: string): Promise<GetResult> {
    const url = `${this.baseUrl}${path}`;
    let refreshedToken = false;

    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      const token = await this.tokens.get(Date.now());
      if (!token.ok) {
        return { ok: false, status: token.status, error: token.error, retryable: true };
      }

      await this.waitForSlot();

      let res: Response;
      try {
        res = await this.fetchImpl(url, {
          headers: {
            client_id: this.clientId,
            client_secret: this.clientSecret,
            Authorization: `Bearer ${token.token}`,
            Accept: 'application/json',
          },
          /*
           * `cache: 'no-store'` IS LOAD-BEARING, AND THIS IS THE LINE WHOSE
           * ABSENCE BROKE TRACKING FOR A DAY.
           *
           * Next's App Router patches global `fetch`. A GET with no cache
           * option, called from inside a route handler, goes into the
           * on-disk Data Cache — and Next stamped this one
           * `revalidate: 31536000`, a year. So the three-hourly cron asked
           * Correos once, and every run after that read
           * `.next/cache/fetch-cache/<hash>` instead of making a request at
           * all. Six runs in a row reported "asked 201, stored 0" while
           * Correos had hundreds of events nobody could see.
           *
           * Two details made it hard to spot. The route already exports
           * `dynamic = 'force-dynamic'`, which governs rendering and did NOT
           * stop the fetch being cached. And the bearer token is part of the
           * cache key, so a run that happened to mint a fresh token missed
           * the cache and did get real data — which is why it looked
           * intermittent rather than broken.
           *
           * Manual Refresh was never affected: it is a POST server action,
           * and Next does not cache those. That is the whole of why the
           * button worked while the cron did not.
           *
           * There is no case in which a cached answer from Correos is wanted.
           * Asking where a parcel is and being handed yesterday's answer is
           * not an optimisation.
           */
          cache: 'no-store',
          signal: AbortSignal.timeout(30_000),
        });
      } catch (err) {
        if (attempt === this.maxRetries) {
          return { ok: false, status: null, error: reason(err), retryable: true };
        }
        await sleep(backoffMs(attempt));
        continue;
      }

      // The token expired, or was revoked. Throw it away, mint exactly one new
      // one and try again once. Retrying forever on 401 would hammer the token
      // endpoint with credentials that are simply wrong.
      if (res.status === 401 || res.status === 403) {
        if (!refreshedToken && token.source !== 'override') {
          refreshedToken = true;
          this.tokens.invalidate();
          continue;
        }
        // Correos' own status and body, not our interpretation of them.
        //
        // This used to replace both with a guess that named
        // CORREOS_OAUTH_CLIENT_ID. The real cause was the OAuth *scope*: a
        // token minted with `AP3 LBS RCG` gets `401 {"error": "Invalid
        // token."}` from trackpub, and the credentials were right all along.
        // The guess cost a day of looking at the wrong variable, and their
        // three-word body would have ended it immediately.
        return {
          ok: false,
          status: res.status,
          error: await describe(res, res.status === 401
            ? 'the token was rejected — check CORREOS_OAUTH_SCOPE (trackpub wants TPB), then the OAuth credentials'
            : 'the request was refused — check CORREOS_CLIENT_ID / _SECRET and the trackpub contract'),
          retryable: false,
        };
      }

      if (res.status === 429 || res.status >= 500) {
        const retryAfter = Number(res.headers.get('retry-after'));
        const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : backoffMs(attempt);

        if (attempt === this.maxRetries) {
          return { ok: false, status: res.status, error: `Correos returned ${res.status}`, retryable: true };
        }
        // Hold the whole client back, not just this call: hammering on behalf
        // of one parcel is how the next thousand get blocked.
        this.nextSlot = Date.now() + wait;
        await sleep(wait);
        continue;
      }

      // The one non-2xx whose body is not surfaced, because we already know
      // what it means and say it better than they do. The status still reaches
      // the caller, so the test button shows `404` next to this.
      if (res.status === 404) {
        return { ok: false, status: 404, error: NEVER_HEARD_OF_IT, retryable: false, definitive: true };
      }

      if (!res.ok) {
        return { ok: false, status: res.status, error: await describe(res), retryable: false };
      }

      const body = await res.json().catch(() => undefined);
      if (body === undefined) {
        return { ok: false, status: res.status, error: 'Correos returned something that was not JSON', retryable: false };
      }

      return { ok: true, body };
    }

    return { ok: false, status: null, error: 'gave up after retries', retryable: true };
  }

  private async waitForSlot(): Promise<void> {
    const wait = this.nextSlot - Date.now();
    if (wait > 0) await sleep(wait);
    this.nextSlot = Math.max(Date.now(), this.nextSlot) + this.minGapMs;
  }
}

/* -------------------------------------------------------------------------- */

export const NEVER_HEARD_OF_IT = 'Correos has never heard of this code';

/**
 * Split codes into requests: at most `limit` of them, and at most
 * MAX_PATH_BYTES of path. A single code always gets its own chunk even if it
 * is longer than the budget — refusing to ask about a parcel because its code
 * is long would be worse than a long URL.
 *
 * `limit` is what the halving ladder lowers. It is not the same thing as the
 * path cap, and on production it was the path cap that decided the size: 1,800
 * bytes of 24-byte codes is about 75, which is why a batch of 75 — not 100 —
 * is the one Correos refused.
 */
export function chunksOf(codes: readonly string[], limit: number = MAX_BATCH): string[][] {
  const out: string[][] = [];
  let chunk: string[] = [];
  let bytes = 0;
  const cap = Math.max(1, Math.min(MAX_BATCH, Math.floor(limit)));

  for (const code of codes) {
    const cost = encodeURIComponent(code).length + 1; // +1 for the comma
    const full = chunk.length >= cap || (chunk.length > 0 && bytes + cost > MAX_PATH_BYTES);
    if (full) { out.push(chunk); chunk = []; bytes = 0; }
    chunk.push(code);
    bytes += cost;
  }

  if (chunk.length) out.push(chunk);
  return out;
}

/**
 * Correos' own words for a non-2xx answer: the status, their body trimmed, and
 * a hint after it rather than instead of it.
 *
 * Reading the body can fail — a connection that dies mid-response — and that
 * must not turn a diagnosable HTTP error into a thrown exception, so it
 * degrades to the status alone.
 */
async function describe(res: Response, hint?: string): Promise<string> {
  const body = (await res.text().catch(() => '')).trim();
  const head = `Correos returned ${res.status}${body ? `: ${body.slice(0, 300)}` : ''}`;
  return hint ? `${head} — ${hint}` : head;
}

/** The slice of a batch response that belongs to one parcel. */
function forCode(outcome: NormaliseOutcome, code: string): NormaliseOutcome {
  return {
    events: outcome.events.filter((e) => e.shippingCode === code),
    // normalise.ts tags per-shipment problems `${code}: …`. Without the colon
    // a code also collects the problems of every code it is a prefix of.
    problems: outcome.problems.filter((p) => p.startsWith(`${code}:`)),
    errors: outcome.errors.filter((e) => e.code === code),
    codesSeen: [code],
  };
}

/**
 * One code's `error` block, as a failed lookup.
 *
 * `codError` is Correos' own numbering and we have only ever seen 0. So the
 * message leads with their `desError` and carries the number for the cases we
 * have not met yet, and the result is non-retryable: whatever is wrong with
 * the code will still be wrong in three hours.
 */
function shipmentErrorFor(outcome: NormaliseOutcome, code: string): LookupResult | null {
  const failure: ShipmentError | undefined = outcome.errors.find((e) => e.code === code);
  if (!failure) return null;

  return {
    ok: false,
    // HTTP was fine; this came back inside a 200, and saying otherwise would
    // send somebody looking at the gateway.
    status: 200,
    error: `Correos reported error ${failure.codError} for this code`
      + `${failure.desError ? `: ${failure.desError}` : ''}`,
    retryable: false,
    // About this code, and it will not change. Without this the sweep would
    // never stamp the parcel, so it would lead the queue for ever — and ten
    // such codes would trip the "Correos is refusing requests" guard on every
    // single run and stop the sweep before it reached anything else.
    definitive: true,
  };
}

function notConfigured(): LookupResult {
  return {
    ok: false,
    status: null,
    error: 'Correos credentials are not configured',
    retryable: false,
  };
}

function backoffMs(attempt: number): number {
  // 1s, 2s, 4s, with a little jitter so a sweep does not retry in lockstep.
  return Math.round((2 ** attempt) * 1000 * (0.75 + Math.random() * 0.5));
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, Math.max(0, ms)));
}

function reason(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

let cached: TrackpubClient | null = null;

/**
 * The shared client.
 *
 * `cached ??= new TrackpubClient(opts)` would quietly drop the options on
 * every warm call, which matters for exactly one of them: the stored batch
 * mode. An operator who resets `correosBatchMode` to 'unknown' to make the
 * sweep probe the format again would be overruled by whatever the warm client
 * already believed — and the next sweep would write the stale verdict straight
 * back over the reset. So a known mode is applied even to an existing client.
 */
export function trackpub(opts?: TrackpubOptions): TrackpubClient {
  if (!cached) {
    cached = new TrackpubClient(opts);
    return cached;
  }
  if (opts?.batchMode !== undefined) cached.adoptMode(opts.batchMode);
  return cached;
}

export function setTrackpub(c: TrackpubClient | null): void { cached = c; }
