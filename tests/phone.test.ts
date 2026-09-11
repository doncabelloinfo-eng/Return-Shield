import { describe, it, expect } from 'vitest';
import { normalisePhone, displayPhone, isAcceptableFix } from '@/lib/import/phone';

/**
 * Every case the import screen promises to handle, and every case it promises
 * to hand back to a person. The line between the two is the whole point: a
 * number that can be fixed without guessing gets fixed, and a number that
 * cannot gets a human, never a guess.
 */
describe('phone normalisation', () => {
  describe('fixes silently', () => {
    it('adds +34 to a bare nine-digit Spanish mobile', () => {
      const r = normalisePhone('634118220');
      expect(r.e164).toBe('+34634118220');
      expect(r.status).toBe('ok');
      expect(r.fixes).toContain('added +34');
    });

    it('strips spaces', () => {
      expect(normalisePhone('+34 691 204 551').e164).toBe('+34691204551');
    });

    it('strips dashes and dots', () => {
      expect(normalisePhone('627-481-093').e164).toBe('+34627481093');
      expect(normalisePhone('627.481.093').e164).toBe('+34627481093');
    });

    it('strips brackets and slashes', () => {
      expect(normalisePhone('(+34) 627/481/093').e164).toBe('+34627481093');
    });

    it('turns a leading 0034 into +34', () => {
      const r = normalisePhone('0034622771004');
      expect(r.e164).toBe('+34622771004');
      expect(r.fixes).toContain('turned 0034 into +34');
    });

    it('turns a leading 34 into +34', () => {
      expect(normalisePhone('34622771004').e164).toBe('+34622771004');
    });

    it('handles the lot at once', () => {
      const r = normalisePhone('  00 34 6 91 204 55 1  ');
      expect(r.e164).toBe('+34691204551');
      expect(r.status).toBe('ok');
      expect(r.fixes.length).toBeGreaterThan(1);
    });

    it('accepts a number that needed no fixing, and says so', () => {
      const r = normalisePhone('+34627481093');
      expect(r.status).toBe('ok');
      expect(r.fixes).toEqual([]);
    });

    it('accepts mobiles starting 7 as well as 6', () => {
      expect(normalisePhone('711234567').status).toBe('ok');
    });
  });

  describe('raises for a human', () => {
    it('flags a landline — no WhatsApp, no SMS', () => {
      const r = normalisePhone('+34 913 224 118');
      expect(r.status).toBe('landline');
      expect(r.error).toBe('Landline — no WhatsApp, no SMS');
      // Still kept: it is dialable, just not messageable.
      expect(r.e164).toBe('+34913224118');
    });

    it('flags a number that is too short', () => {
      const r = normalisePhone('+34 60012');
      expect(r.status).toBe('invalid');
      expect(r.error).toBe('Too short — 5 digits');
    });

    it('flags a number that is too long', () => {
      expect(normalisePhone('+34 6270481093123').error).toBe('Too long — 13 digits');
    });

    it('flags an empty number', () => {
      const r = normalisePhone('');
      expect(r.status).toBe('missing');
      expect(r.error).toBe('No phone number');
    });

    it('flags whitespace as empty, not as invalid', () => {
      expect(normalisePhone('   ').status).toBe('missing');
    });

    it('flags text that is not a number at all', () => {
      expect(normalisePhone('no tiene').status).toBe('invalid');
    });

    it('never invents a country code for a nine-digit landline', () => {
      // Nine digits starting 9 is a Spanish landline, not a mobile to fix up.
      expect(normalisePhone('913224118').status).toBe('landline');
    });
  });

  it('passes a non-Spanish number through rather than mangling it', () => {
    const r = normalisePhone('+351 912 345 678');
    expect(r.status).toBe('ok');
    expect(r.e164).toBe('+351912345678');
  });

  it('formats for a screen without changing what is stored', () => {
    expect(displayPhone('+34627481093')).toBe('+34 627 481 093');
    expect(displayPhone(null)).toBe('—');
  });

  it('accepts an inline fix only when it is genuinely usable', () => {
    expect(isAcceptableFix('+34 622 771 004')).toBe(true);
    expect(isAcceptableFix('622771004')).toBe(true);
    expect(isAcceptableFix('+34 913 224 118')).toBe(false);
    expect(isAcceptableFix('60012')).toBe(false);
  });
});
