import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { parseCorreosCode } from '@/lib/scan/codes';
import { matchForCode } from '@/lib/scan/match';
import { scanLabel } from '@/lib/scan/items';
import { TestClock, resetClock } from '@/lib/clock';
import { resetDb, closeDb } from './helpers/db';
import { makeShipment } from './helpers/fixtures';

/**
 * Turning a scanned code into a parcel.
 *
 * THE LINK IS THE FIRST FIFTEEN CHARACTERS, because that is the one part the
 * two numbers printed on a Correos label have in common — and
 * `shipments.shipping_code` holds whichever of the two its source happened to
 * give us. Shopify's fulfilment carries the 16-character EXPEDICIÓN; a
 * marketplace file sometimes carries the 23-character Código de Bulto. Both
 * have to match a scan of either.
 *
 * AND IT IS WORKED OUT EVERY TIME ANYBODY ASKS, never frozen at scan time. A
 * TikTok or Amazon parcel is usually scanned out days before its file is
 * uploaded, and a scan that had recorded "no such parcel" would still say so
 * afterwards — telling the operator a parcel never left the warehouse when it
 * left on Tuesday.
 */

const match = async (code: string) => {
  const parsed = parseCorreosCode(code);
  if (!parsed) throw new Error(`${code} does not parse`);
  return matchForCode(parsed);
};

let clock: InstanceType<typeof TestClock>;

beforeEach(async () => {
  await resetDb();
  clock = new TestClock('2026-10-16T10:00:00+02:00');
  clock.install();
});

afterAll(async () => {
  resetClock();
  await closeDb();
});

describe('matching a scan to a parcel', () => {
  it('matches the exact code', async () => {
    await makeShipment({ shippingCode: 'PKA6TP9800101540108224D', orderNumber: '#22711' });

    const answer = await match('PKA6TP9800101540108224D');
    expect(answer.match?.orderNumber).toBe('#22711');
    expect(answer.sharing).toBe(1);
  });

  it('matches on the base alone when only the base was read', async () => {
    await makeShipment({ shippingCode: 'PKA6TP980010155E', orderNumber: '#22712' });

    // The 15-character base, with no check letter: the EXPEDICIÓN typed short.
    const answer = await match('PKA6TP980010155');
    expect(answer.match?.orderNumber).toBe('#22712');
  });

  it('matches a stored 16-character EXPEDICIÓN against a scanned Código de Bulto', async () => {
    // Shopify's fulfilment gives us the expedición; the warehouse scans the
    // barcode, which is the bulto. This is the ordinary case for a Shopify
    // parcel, and the reason nothing matches on the full code alone.
    await makeShipment({ shippingCode: 'PKA6TP980010153E', orderNumber: '#22713' });

    const answer = await match('PKA6TP9800101530130565B');
    expect(answer.match?.orderNumber).toBe('#22713');
  });

  it('matches a stored Código de Bulto against a scanned EXPEDICIÓN', async () => {
    // And the other way round, which is what a marketplace file plus a typed
    // number looks like.
    await makeShipment({ shippingCode: 'PKA6TP9800101560108320G', orderNumber: '408-8109103-1916354' });

    const answer = await match('PKA6TP980010156E');
    expect(answer.match?.orderNumber).toBe('408-8109103-1916354');
  });

  it('finds nothing for a code no parcel has', async () => {
    await makeShipment({ shippingCode: 'PKA6TP980010157E' });

    const answer = await match('PKA6TP980010999E');
    expect(answer.match).toBeNull();
    expect(answer.sharing).toBe(0);
  });
});

describe('two parcels sharing a base', () => {
  beforeEach(async () => {
    // One shipment, two boxes: parcel 01 and parcel 02 of the same expedición.
    await makeShipment({
      shippingCode: 'PKA6TP9800101520108320G', orderNumber: '#22714', storeKey: 'shop-a',
    });
    await makeShipment({
      shippingCode: 'PKA6TP9800101520208320H', orderNumber: '#22715', storeKey: 'shop-a',
    });
  });

  it('refuses to pick one when only the base is known', async () => {
    // "2 parcels with this number" rather than a guess. Picking one is how a
    // parcel gets marked as having left the warehouse while it is on a shelf.
    const answer = await match('PKA6TP980010152E');

    expect(answer.match).toBeNull();
    expect(answer.sharing).toBe(2);
  });

  it('picks the right one when the full code was scanned', async () => {
    expect((await match('PKA6TP9800101520108320G')).match?.orderNumber).toBe('#22714');
    expect((await match('PKA6TP9800101520208320H')).match?.orderNumber).toBe('#22715');
  });
});

describe('a parcel uploaded after it was scanned out', () => {
  it('matches once the file brings it in, with nobody scanning again', async () => {
    // The TikTok and Amazon case. The warehouse scans the box on Tuesday; the
    // file arrives on Thursday.
    const code = 'PKA6TP9800101580108320G';

    expect((await match(code)).match).toBeNull();

    clock.advanceDays(2);
    await makeShipment({
      shippingCode: 'PKA6TP980010158E',
      orderNumber: '576912345678',
      storeName: 'TikTok Shop ES',
      platform: 'tiktok',
    });

    const answer = await match(code);
    expect(answer.match?.orderNumber).toBe('576912345678');
    expect(answer.match && scanLabel(answer.match))
      .toEqual({ lead: 'TikTok order 5769…', note: 'TikTok Shop ES' });
  });
});
