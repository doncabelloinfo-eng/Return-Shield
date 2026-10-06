'use server';

import { requireUser } from '@/lib/auth/guard';
import { correosToken } from '@/lib/carriers/correos/token';
import { TrackpubClient } from '@/lib/carriers/correos/trackpub';
import { getSetting, setSetting } from '@/lib/settings';
import { STATE_LABEL, matchCorreosEvent } from '@/lib/carriers/correos/state-map';
import { exact } from '@/lib/time';

/**
 * "Test Correos connection."
 *
 * Four variables from two different places have to be right before a single
 * parcel gets tracked, and the only other way to find out is to wait up to
 * three hours for a sweep and then read a job_runs row. This answers it in two
 * seconds, in two steps, so a wrong value is attributable to the step it broke.
 *
 * It never returns the token. Not the first characters, not the length — a
 * thirty-minute bearer token for a live carrier account has no business in a
 * browser, a server log or a screenshot.
 */

export interface TokenCheck {
  ok: boolean;
  /** "token OK, expires in 28 minutes" — or what went wrong. */
  message: string;
  expiresInMinutes?: number;
  /** Set when a hand-pasted CORREOS_JWT was used instead of the OAuth pair. */
  manual?: boolean;
}

export interface LookupCheck {
  ok: boolean;
  code: string;
  message: string;
  /** What we made of it, when it worked. */
  state?: string;
  events?: number;
  latestEvent?: string;
  /** Correos' own status, when it did not. */
  status?: number | null;
}

export interface CorreosTestResult {
  token: TokenCheck;
  lookup?: LookupCheck;
  /** What the client knows about the undocumented multi-parcel format. */
  batchMode: 'unknown' | 'comma' | 'single';
  batchNote: string | null;
}

export async function testCorreosConnection(shippingCode: string): Promise<CorreosTestResult> {
  await requireUser();

  const storedMode = await getSetting('correosBatchMode');

  /* --- Step 1: can we get a token at all? ------------------------------- */

  const tokens = correosToken();
  if (!tokens.configured) {
    return {
      token: {
        ok: false,
        message: 'No credentials. Set CORREOS_OAUTH_CLIENT_ID and CORREOS_OAUTH_CLIENT_SECRET '
          + '(the CorreosID system-user application, not the developer-portal app).',
      },
      batchMode: storedMode,
      batchNote: null,
    };
  }

  // Always mint a fresh one: a cached token proves only that it worked earlier.
  tokens.invalidate();
  const token = await tokens.get(Date.now());

  if (!token.ok) {
    return {
      token: { ok: false, message: token.error },
      batchMode: storedMode,
      batchNote: null,
    };
  }

  const minutes = Math.max(0, Math.round((token.expiresAt.getTime() - Date.now()) / 60_000));
  const tokenCheck: TokenCheck = {
    ok: true,
    expiresInMinutes: minutes,
    manual: token.source === 'override',
    message: token.source === 'override'
      ? `Using the token pasted into CORREOS_JWT. It expires in ${minutes} minutes and `
        + 'cannot be renewed — set the OAuth pair before relying on this.'
      : `Token OK, expires in ${minutes} minutes.`,
  };

  const code = shippingCode.trim().toUpperCase();
  if (!code) {
    return { token: tokenCheck, batchMode: storedMode, batchNote: null };
  }

  /* --- Step 2: does a real lookup work? --------------------------------- */

  // A client of its own, so a test cannot change what the sweep believes about
  // the batch format — and so the test is not answered from a warm instance's
  // state.
  const client = new TrackpubClient({ batchMode: storedMode });
  const result = await client.lookup(code);

  if (!result.ok) {
    return {
      token: tokenCheck,
      lookup: { ok: false, code, message: result.error, status: result.status },
      batchMode: client.mode,
      batchNote: client.diagnosis,
    };
  }

  const events = result.outcome.events;
  // Newest first, the way the parcel page shows them.
  const newest = [...events].sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime())[0];
  const match = newest ? matchCorreosEvent(newest.eventCode, newest.eventDesc, newest.phase) : null;
  const mapped = match?.state ?? null;

  return {
    token: tokenCheck,
    lookup: {
      ok: true,
      code,
      events: events.length,
      state: mapped ? (STATE_LABEL[mapped] ?? mapped) : undefined,
      // The newest event in Correos' own words, with its date and time, so the
      // operator can check it against what Mi Oficina shows them.
      latestEvent: newest
        ? `"${newest.eventDesc}" at ${exact(newest.occurredAt)}`
          + `${newest.phase ? ` · ${newest.phase}` : ''}`
        : undefined,
      message: events.length === 0
        ? 'Correos knows the code but has no events for it yet.'
        : mapped === null
          ? `${events.length} events. The newest one is wording we have no mapping for — it is `
            + 'kept, shown on the parcel, and listed below for review.'
          : match?.via === 'phase'
            ? `${events.length} events. The newest one we only recognise from its phase `
              + `(${newest?.phase}), so it is listed below for review as well.`
            : `${events.length} events.`,
    },
    batchMode: client.mode,
    batchNote: client.diagnosis,
  };
}

/**
 * Forget what we learnt about the batch format, so the next sweep probes again.
 *
 * Needed because the verdict is sticky by design: one bad answer pins the sweep
 * to one request per parcel, which at five thousand live parcels is the
 * difference between fifty requests and five thousand.
 */
export async function resetCorreosBatchMode(): Promise<void> {
  await requireUser();
  await setSetting('correosBatchMode', 'unknown');
}
