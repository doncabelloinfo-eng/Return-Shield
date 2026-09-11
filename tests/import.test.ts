import { describe, it, expect } from 'vitest';
import ExcelJS from 'exceljs';
import { buildPreview, parseFile, parseMoneyCents, parsePayment, parseDate } from '@/lib/import/parse';

/**
 * The import screen's promise: fix what can be fixed without guessing, raise
 * what cannot, and never write anything until a person has looked at it.
 */

const HEADER = 'order_id,customer_name,phone,address,city,postal_code,shipping_code,order_value,payment_method,shipped_at';

function csv(...rows: string[]): Buffer {
  return Buffer.from([HEADER, ...rows].join('\n'), 'utf8');
}

describe('reading the file', () => {
  it('reads a plain CSV', async () => {
    const parsed = await parseFile('orders.csv', csv(
      'TT-90412,Vanesa Ortega Ríos,+34 611 402 938,C/ Mayor 1,Getafe,28901,PQ1111111111ES,42.00,prepaid,01/09/2026',
    ));
    expect(parsed.missingColumns).toEqual([]);
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.rows[0].customer_name).toBe('Vanesa Ortega Ríos');
  });

  it('reads a CSV a Spanish Excel saved with semicolons', async () => {
    const body = Buffer.from([
      HEADER.replace(/,/g, ';'),
      'TT-1;Ana Ruiz;611402938;C/ Mayor 1;Getafe;28901;PQ2222222222ES;42,00;contra reembolso;01/09/2026',
    ].join('\n'), 'utf8');

    const parsed = await parseFile('orders.csv', body);
    expect(parsed.rows[0].customer_name).toBe('Ana Ruiz');
    expect(parsed.rows[0].shipping_code).toBe('PQ2222222222ES');
  });

  it('survives a UTF-8 byte order mark on the first header', async () => {
    const parsed = await parseFile('orders.csv', Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      csv('TT-1,Ana,611402938,C/ Mayor,Getafe,28901,PQ3333333333ES,10,cod,01/09/2026'),
    ]));
    expect(parsed.missingColumns).toEqual([]);
  });

  it('finds columns TikTok has renamed', async () => {
    const body = Buffer.from([
      'Order ID,Recipient Name,Phone Number,Detail Address,City,Zip Code,Tracking Number,Total Amount,Payment,Shipping Time',
      'TT-2,Saray Muñoz,634118220,C/ Real 4,Fuenlabrada,28940,PQ4444444444ES,58.90,COD,02/09/2026',
    ].join('\n'), 'utf8');

    const parsed = await parseFile('orders.csv', body);
    expect(parsed.missingColumns).toEqual([]);
    expect(parsed.rows[0].customer_name).toBe('Saray Muñoz');
    expect(parsed.rows[0].shipping_code).toBe('PQ4444444444ES');
  });

  it('says which required columns are missing rather than importing rubbish', async () => {
    const parsed = await parseFile('orders.csv', Buffer.from('order_id,customer_name\nTT-1,Ana', 'utf8'));
    expect(parsed.missingColumns).toContain('shipping_code');
    expect(parsed.missingColumns).toContain('phone');
  });

  it('reads an XLSX', async () => {
    const wb = new ExcelJS.Workbook();
    const sheet = wb.addWorksheet('Orders');
    sheet.addRow(HEADER.split(','));
    sheet.addRow(['TT-7', 'Alba Prieto', '+34 691 204 551', 'C/ Sol 3', 'Mataró', '08301', 'PQ5555555555ES', 36.2, 'prepaid', '03/09/2026']);
    const bytes = Buffer.from(await wb.xlsx.writeBuffer());

    const parsed = await parseFile('orders.xlsx', bytes);
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.rows[0].customer_name).toBe('Alba Prieto');
  });
});

describe('the preview', () => {
  it('separates fixed, new, duplicate and needs-you', async () => {
    const parsed = await parseFile('orders.csv', csv(
      'TT-1,Vanesa Ortega,+34611402938,C/ A,Getafe,28901,PQ1000000001ES,42.00,prepaid,01/09/2026',
      'TT-2,Saray Muñoz,634 118 220,C/ B,Fuenlabrada,28940,PQ1000000002ES,58.90,cod,01/09/2026',
      'TT-3,Youssef Bennani,+34 913 224 118,C/ C,Madrid,28001,PQ1000000003ES,67.50,prepaid,01/09/2026',
      'TT-4,Óscar Prats,+34 60012,C/ D,Elche,03203,PQ1000000004ES,24.00,cod,01/09/2026',
      'TT-5,Marta Gil,+34 655 019 342,C/ E,Zaragoza,50003,PQ9999999999ES,44.90,cod,01/09/2026',
    ));

    const { rows, summary } = buildPreview(parsed.rows, new Set(['PQ9999999999ES']));

    expect(rows[0].status).toBe('new');
    expect(rows[1].status).toBe('fixed');
    expect(rows[2].status).toBe('needs_you');
    expect(rows[2].error).toBe('Landline — no WhatsApp, no SMS');
    expect(rows[3].status).toBe('needs_you');
    expect(rows[4].status).toBe('duplicate');

    // "new" counts everything that will be created, fixed or not; "autofixed"
    // counts only the numbers we had to touch on the way in.
    expect(summary).toMatchObject({ total: 5, new: 2, duplicate: 1, needsYou: 2, autofixed: 1 });
  });

  it('dedupes within one file, so a doubled row is not two parcels', async () => {
    const parsed = await parseFile('orders.csv', csv(
      'TT-1,Ana,611402938,C/ A,Getafe,28901,PQ1000000001ES,10.00,cod,01/09/2026',
      'TT-1,Ana,611402938,C/ A,Getafe,28901,PQ1000000001ES,10.00,cod,01/09/2026',
    ));
    const { rows } = buildPreview(parsed.rows, new Set());
    expect(rows[0].status).toBe('fixed');
    expect(rows[1].status).toBe('duplicate');
  });

  it('makes the whole file safe to re-upload', async () => {
    const parsed = await parseFile('orders.csv', csv(
      'TT-1,Ana,611402938,C/ A,Getafe,28901,PQ1000000001ES,10.00,cod,01/09/2026',
    ));
    const { summary } = buildPreview(parsed.rows, new Set(['PQ1000000001ES']));
    expect(summary).toMatchObject({ new: 0, duplicate: 1 });
  });

  it('numbers rows the way a person counting in a spreadsheet would', async () => {
    const parsed = await parseFile('orders.csv', csv(
      'TT-1,Ana,611402938,C/ A,Getafe,28901,PQ1000000001ES,10.00,cod,01/09/2026',
    ));
    const { rows } = buildPreview(parsed.rows, new Set());
    // Row 1 is the header, so the first order is row 2.
    expect(rows[0].n).toBe(2);
  });

  it('flags a row with no tracking code — there is nothing to follow', async () => {
    const parsed = await parseFile('orders.csv', csv(
      'TT-1,Ana,611402938,C/ A,Getafe,28901,,10.00,cod,01/09/2026',
    ));
    const { rows } = buildPreview(parsed.rows, new Set());
    expect(rows[0].status).toBe('needs_you');
    expect(rows[0].error).toBe('No tracking code — nothing to follow');
  });
});

describe('reading the awkward fields', () => {
  it('reads money however the file spells it', () => {
    expect(parseMoneyCents('42.00')).toBe(4200);
    expect(parseMoneyCents('42,00')).toBe(4200);
    expect(parseMoneyCents('€1.234,56')).toBe(123456);
    expect(parseMoneyCents('1,234.56')).toBe(123456);
    expect(parseMoneyCents('42')).toBe(4200);
    expect(parseMoneyCents('')).toBe(0);
    expect(parseMoneyCents(undefined)).toBe(0);
  });

  it('spots cash on delivery under every name it goes by', () => {
    // Getting this wrong costs the whole sale rather than the margin, so it is
    // worth being generous about the spelling.
    for (const s of ['COD', 'cod', 'Cash on Delivery', 'contra reembolso', 'contrareembolso', 'Reembolso', 'efectivo']) {
      expect(parsePayment(s)).toBe('cod');
    }
    for (const s of ['prepaid', 'PayPal', 'card', '', undefined]) {
      expect(parsePayment(s)).toBe('prepaid');
    }
  });

  it('reads a Spanish date the Spanish way round', () => {
    // 09/03/2026 is the ninth of March, not the third of September.
    const d = parseDate('09/03/2026');
    expect(d?.getUTCMonth()).toBe(2);
    expect(d?.getUTCDate()).toBe(9);
  });

  it('reads an ISO date too', () => {
    expect(parseDate('2026-09-03T10:00:00Z')?.getUTCDate()).toBe(3);
  });

  it('returns null rather than an Invalid Date', () => {
    expect(parseDate('not a date')).toBeNull();
    expect(parseDate('')).toBeNull();
    expect(parseDate(undefined)).toBeNull();
  });
});
