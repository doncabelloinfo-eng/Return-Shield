import { describe, it, expect } from 'vitest';
import {
  CODE_BASE_LENGTH, baseOf, normaliseCode, parseCorreosCode, readsAs,
} from '@/lib/scan/codes';
import { scanLabel, summarise, unmatchedNote, type ScanItem } from '@/lib/scan/items';

/**
 * Reading the number off a Correos label.
 *
 * The rules came from the operator's own scanner component, checked against 61
 * real labels from Amazon, Shopify and TikTok Shop. These tests are here
 * because the parser is now in one place and used by three — the camera, the
 * typed-entry sheet and the API that stores a scan — so a change to it changes
 * all three, and because the one thing worse than refusing a good code is
 * accepting a bad one.
 *
 *   Código de Bulto  PKA6TP980010152 01 08320 G   (23)
 *   EXPEDICIÓN       PKA6TP980010152 E            (16)
 */

describe('parsing a Correos code', () => {
  it('reads the 23-character Código de Bulto', () => {
    const code = parseCorreosCode('PKA6TP9800101520108320G');

    expect(code).not.toBeNull();
    expect(code?.kind).toBe('bulto');
    expect(code?.base).toBe('PKA6TP980010152');
    expect(code?.parcelNo).toBe('01');
    expect(code?.postalCode).toBe('08320');
    expect(code?.checkLetter).toBe('G');
  });

  it('reads the 16-character EXPEDICIÓN', () => {
    const code = parseCorreosCode('PKA6TP980010152E');

    expect(code?.kind).toBe('expedicion');
    expect(code?.base).toBe('PKA6TP980010152');
    expect(code?.checkLetter).toBe('E');
    // Only the bulto carries these. An expedición names the shipment, not a box.
    expect(code?.parcelNo).toBeNull();
    expect(code?.postalCode).toBeNull();
  });

  it('reads the 15-character base on its own', () => {
    const code = parseCorreosCode('PKA6TP980010152');

    expect(code?.kind).toBe('expedicion');
    expect(code?.base).toBe('PKA6TP980010152');
    expect(code?.checkLetter).toBeNull();
  });

  it('reads it lowercase, with spaces and punctuation', () => {
    // A phone keyboard with autocapitalise half on, and a thumb.
    expect(parseCorreosCode('pka6tp980010152 e')?.raw).toBe('PKA6TP980010152E');
    expect(parseCorreosCode('  pka6tp-980010152  ')?.base).toBe('PKA6TP980010152');
    expect(parseCorreosCode('PKA6TP 9800101520108320 G')?.parcelNo).toBe('01');
  });

  it.each([
    ['HELLO', 'a word'],
    ['', 'nothing at all'],
    ['PKA6TP98001015', '14 characters — one short'],
    ['PKA6TP9800101520108320', '22 — a bulto with its check letter missing'],
    ['PKA6TP98001015201083201', '23 but ending in a digit'],
    ['PKA6TP980010152EE', '17 — two check letters'],
    ['12345678901234567890123', "the sender's own barcode"],
  ])('refuses %s (%s)', (input) => {
    expect(parseCorreosCode(input)).toBeNull();
  });

  it('never invents a base out of something too short', () => {
    expect(baseOf('short')).toBe('');
    expect(baseOf('pka6tp980010152e')).toBe('PKA6TP980010152');
    expect(baseOf('pka6tp980010152e')).toHaveLength(CODE_BASE_LENGTH);
  });

  it('normalises to A–Z and 0–9 only', () => {
    expect(normaliseCode(' pk-a6 tp98/0010152e ')).toBe('PKA6TP980010152E');
  });

  it('says what a typed number reads as, with its length', () => {
    expect(readsAs(parseCorreosCode('PKA6TP9800101520108320G')!)).toBe('23 characters · Código de Bulto');
    expect(readsAs(parseCorreosCode('PKA6TP980010152E')!)).toBe('16 characters · EXPEDICIÓN number');
    expect(readsAs(parseCorreosCode('PKA6TP980010152')!))
      .toBe('15 characters · EXPEDICIÓN without its check letter');
  });
});

/* ------------------------------------------------------------- what a row says */

describe('what the batch row says a parcel is', () => {
  it('shows the order number and shop for a Shopify parcel', () => {
    expect(scanLabel({
      orderNumber: '#22709', storeName: 'Don Cabello Profesional', storePlatform: 'shopify',
    })).toEqual({ lead: '#22709', note: 'Don Cabello Profesional' });
  });

  it('shows Amazon with its full order id, which is what a packing slip has', () => {
    expect(scanLabel({
      orderNumber: '405-0360895-9964304', storeName: 'Amazon ES', storePlatform: 'amazon',
    })).toEqual({ lead: 'Amazon', note: '405-0360895-9964304' });
  });

  it('shortens the TikTok order, which is too long to read on a phone', () => {
    expect(scanLabel({
      orderNumber: '576912345678', storeName: 'TikTok Shop ES', storePlatform: 'tiktok',
    })).toEqual({ lead: 'TikTok order 5769…', note: 'TikTok Shop ES' });
  });

  it('says which kind of nothing it found', () => {
    expect(unmatchedNote(0)).toBe('Not in Return Shield');
    expect(unmatchedNote(2)).toBe('2 parcels with this number');
  });
});

/* --------------------------------------------------------------- the counting */

function item(over: Partial<ScanItem> & { codeAsRead: string }): ScanItem {
  return {
    id: over.codeAsRead,
    codeAsRead: over.codeAsRead,
    base: over.codeAsRead.slice(0, CODE_BASE_LENGTH),
    parcelNo: null,
    postalCode: '08320',
    source: over.source ?? 'barcode',
    scannedAt: '2026-10-16T10:00:00.000Z',
    timesRead: over.timesRead ?? 1,
    label: over.label ?? null,
    sharing: over.sharing ?? 0,
    shipmentId: over.shipmentId ?? null,
  };
}

describe('the batch summary', () => {
  const found = { lead: '#22709', note: 'Don Cabello' };

  const batch: ScanItem[] = [
    item({ codeAsRead: 'PKA6TP980010001E', label: found, sharing: 1 }),
    item({ codeAsRead: 'PKA6TP980010002E', label: found, sharing: 1, timesRead: 2 }),
    item({ codeAsRead: 'PKA6TP980010003E', label: found, sharing: 1, source: 'typed' }),
    item({ codeAsRead: 'PKA6TP980010004E' }),
    item({ codeAsRead: 'PKA6TP980010005E', sharing: 2 }),
  ];

  it('counts the rows, and nothing but the rows', () => {
    const s = summarise(batch);

    expect(s.scanned).toBe(5);
    expect(s.found).toBe(4);
    expect(s.notFound).toBe(1);
    expect(s.typed).toBe(1);
    expect(s.scannedTwice).toBe(1);
  });

  it('always adds up: found plus not found is the number scanned', () => {
    // The property that stops a sheet saying thirteen over a list of twelve.
    const s = summarise(batch);
    expect(s.found + s.notFound).toBe(s.scanned);
  });

  it('counts a multi-parcel shipment as found, and flags it for a look', () => {
    // It IS in Return Shield — we just cannot say which box without the
    // Código de Bulto. Calling it "not found" would send somebody hunting for
    // an order that is right there.
    const s = summarise(batch);

    expect(s.needsALook.map((r) => r.note)).toEqual([
      'Not in Return Shield',
      '2 parcels with this number',
    ]);
  });

  it('counts nothing for an empty batch', () => {
    expect(summarise([])).toEqual({
      scanned: 0, found: 0, notFound: 0, typed: 0, scannedTwice: 0, needsALook: [],
    });
  });
});
