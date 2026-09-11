/**
 * Spanish phone numbers, cleaned up on the way in.
 *
 * The rule that matters: fix silently and say what you fixed; raise only what
 * nobody could guess. A number with spaces in it is not a decision, it is
 * whitespace. A landline is a decision, because it changes what the system can
 * do — no WhatsApp, no SMS, only a voice call — and somebody has to know.
 */

export type PhoneStatus = 'ok' | 'landline' | 'invalid' | 'missing';

export interface PhoneResult {
  e164: string | null;
  status: PhoneStatus;
  /** What we changed, in plain English. Shown next to the row. */
  fixes: string[];
  /** Why it needs a human. Null when it doesn't. */
  error: string | null;
  raw: string;
}

/** Spanish mobiles start 6 or 7. Landlines start 8 or 9. */
const MOBILE_FIRST_DIGITS = /^[67]/;

export function normalisePhone(input: string | null | undefined): PhoneResult {
  const raw = (input ?? '').toString();
  const fixes: string[] = [];

  if (!raw.trim()) {
    return { e164: null, status: 'missing', fixes, error: 'No phone number', raw };
  }

  // Spaces, dashes, dots, brackets, non-breaking spaces — all noise.
  let s = raw.trim();
  const stripped = s.replace(/[\s .\-()/]/g, '');
  if (stripped !== s) fixes.push('removed spaces and punctuation');
  s = stripped;

  // 0034 and 00 34 are the old international prefix.
  if (s.startsWith('0034')) {
    s = `+${s.slice(2)}`;
    fixes.push('turned 0034 into +34');
  } else if (s.startsWith('+0034')) {
    s = `+${s.slice(3)}`;
    fixes.push('turned 0034 into +34');
  } else if (s.startsWith('34') && s.length === 11) {
    s = `+${s}`;
    fixes.push('added the + to 34');
  }

  // A bare national number. Spain is the only country we ship to.
  if (/^\d{9}$/.test(s)) {
    s = `+34${s}`;
    fixes.push('added +34');
  }

  if (!s.startsWith('+')) {
    return {
      e164: null, status: 'invalid', fixes,
      error: digitsOnly(s).length
        ? `Not a number we recognise — ${digitsOnly(s).length} digits`
        : 'Not a phone number',
      raw,
    };
  }

  const digits = digitsOnly(s);

  if (!digits.startsWith('34')) {
    // A non-Spanish number is not an error — it is just not one we can reason
    // about, so it goes through untouched and the operator decides.
    return { e164: `+${digits}`, status: 'ok', fixes, error: null, raw };
  }

  const national = digits.slice(2);

  if (national.length !== 9) {
    return {
      e164: null, status: 'invalid', fixes,
      error: national.length < 9
        ? `Too short — ${national.length} digit${national.length === 1 ? '' : 's'}`
        : `Too long — ${national.length} digits`,
      raw,
    };
  }

  if (!MOBILE_FIRST_DIGITS.test(national)) {
    return {
      e164: `+34${national}`, status: 'landline', fixes,
      error: 'Landline — no WhatsApp, no SMS',
      raw,
    };
  }

  return { e164: `+34${national}`, status: 'ok', fixes, error: null, raw };
}

function digitsOnly(s: string): string {
  return s.replace(/\D/g, '');
}

/** Pretty for a screen: +34 627 481 093. Never used for storage or links. */
export function displayPhone(e164: string | null): string {
  if (!e164) return '—';
  const d = e164.replace(/\D/g, '');
  if (d.startsWith('34') && d.length === 11) {
    const n = d.slice(2);
    return `+34 ${n.slice(0, 3)} ${n.slice(3, 6)} ${n.slice(6)}`;
  }
  return e164;
}

/** The shape the inline fix box accepts. Mirrors the prototype's check. */
export function isAcceptableFix(value: string): boolean {
  return normalisePhone(value).status === 'ok';
}
