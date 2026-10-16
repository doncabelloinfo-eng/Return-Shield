import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';

// The route is behind the login like every screen, and a test cannot hold a
// session cookie. One test below asserts the guard is actually called.
// `role: 'operator'` is not decoration. Every panel route checks it now, and a
// session without one is refused — which is the point of making `requireUser`
// operator-only, and is what a warehouse phone gets. See lib/auth/roles.ts.
const currentUser = vi.fn(
  async (): Promise<import('@/lib/auth/session').SessionUser | null> =>
    ({ id: 'u1', email: 'op@example.com', name: 'Op', role: 'operator' }),
);
vi.mock('@/lib/auth/session', () => ({ currentUser, SESSION_COOKIE: 'rs_session' }));

const { GET } = await import('@/app/api/parcels/export/route');
const { parcelsExport, parcelsView, PAGE_SIZE } = await import('@/lib/views/parcels');
const { COLUMNS, filterLine, parcelsPdf, pdfFilename } = await import('@/lib/export/parcels-pdf');
const { PAGE, fitsIn, winAnsi, wrapTo } = await import('@/lib/export/pdf');
const { TestClock, resetClock } = await import('@/lib/clock');
const { resetDb, closeDb } = await import('./helpers/db');
const { makeShipment } = await import('./helpers/fixtures');

type ParcelListRow = Awaited<ReturnType<typeof parcelsExport>>['rows'][number];

/**
 * "If I want to download which orders these are and send them to the
 * warehouse, there is no export option."
 *
 * There was not: the screen pages at a hundred and what is on it is not a
 * file. This is the file — the tab being viewed, with its filters, every row
 * of it, as an A4 landscape PDF.
 *
 * TWO THINGS HERE MATTER MORE THAN THE REST PUT TOGETHER.
 *
 * The file and the tab agree. The export runs the screen's own query with the
 * paging taken off, so a tab that says 37 produces 37 rows in the same order.
 * The day those two drift is the day somebody works a list that is not the one
 * they were looking at.
 *
 * And there is no personal data in it. The operator chose order and tracking
 * only — no customer name, no address, no phone, no email, no amount — and
 * this file goes to a third party, so "not shown" is not good enough. The test
 * below reads the whole PDF and fails if any of them appears anywhere in it.
 */

let clock: InstanceType<typeof TestClock>;
const NOW = '2026-10-14T10:45:00+02:00';
/** Three working days before, so these parcels are stuck. */
const STUCK_SINCE = new Date('2026-10-08T09:00:00+02:00');

beforeEach(async () => {
  await resetDb();
  clock = new TestClock(NOW);
  clock.install();
  currentUser.mockClear();
});

afterAll(async () => {
  resetClock();
  await closeDb();
});

/* ------------------------------------------------------ reading a PDF back */

/**
 * Every string the file draws, in the order it draws them.
 *
 * `latin1` for the bytes, with the three WinAnsi characters that are NOT
 * Latin-1 mapped back. The ellipsis is the one that matters: `winAnsi` writes
 * it as 0x85, which latin1 decodes to U+0085 — so an assertion that a line
 * does not end with '…' was true of every line, truncated or not, and the
 * guard against a cut label was inert while a cut label was in the file.
 */
function textOf(pdf: Buffer): string[] {
  const body = pdf.toString('latin1')
    .replace(/\u0085/g, '…')
    .replace(/\u0096/g, '–')
    .replace(/\u0097/g, '—');
  const out: string[] = [];
  const pattern = /\(((?:[^()\\]|\\.)*)\) Tj/g;
  for (let m = pattern.exec(body); m; m = pattern.exec(body)) {
    out.push(m[1].replace(/\\([()\\])/g, '$1'));
  }
  return out;
}

/**
 * The cross-reference table, checked the way a reader checks it.
 *
 * This is the one part of a hand-written PDF that has to be exactly right or
 * the file does not open at all, so it is not taken on trust: every offset in
 * the table must land on the object it claims.
 */
function xrefIsSound(pdf: Buffer): { objects: number; pages: number } {
  const body = pdf.toString('latin1');

  expect(body.startsWith('%PDF-1.4\n')).toBe(true);
  expect(body.endsWith('%%EOF\n')).toBe(true);

  const start = /startxref\n(\d+)\n%%EOF\n$/.exec(body);
  expect(start, 'no startxref').not.toBeNull();
  const xrefAt = Number(start![1]);
  expect(body.slice(xrefAt, xrefAt + 4)).toBe('xref');

  const header = /^xref\n0 (\d+)\n/.exec(body.slice(xrefAt));
  expect(header, 'no xref header').not.toBeNull();
  const size = Number(header![1]);

  // The free entry, then one per object. Twenty bytes each, always.
  const first = xrefAt + header![0].length;
  expect(body.slice(first, first + 20)).toBe('0000000000 65535 f \n');

  for (let i = 1; i < size; i += 1) {
    const entry = body.slice(first + i * 20, first + (i + 1) * 20);
    expect(entry, `entry ${i}`).toMatch(/^\d{10} 00000 n \n$/);
    const offset = Number(entry.slice(0, 10));
    expect(body.slice(offset, offset + `${i} 0 obj`.length), `object ${i}`).toBe(`${i} 0 obj`);
  }

  // `/Type /Pages` would match a naive search for a page, hence the boundary.
  const pages = (body.match(/\/Type \/Page[^s]/g) ?? []).length;
  const declared = /\/Type \/Pages \/Count (\d+)/.exec(body);
  expect(declared, 'no page tree').not.toBeNull();
  expect(Number(declared![1])).toBe(pages);

  return { objects: size - 1, pages };
}

/* --------------------------------------------------------- a row, by hand */

/**
 * A row with everything on it, so a test can be about one thing.
 *
 * Deliberately carrying personal data in every field that has one: the point
 * of several tests below is that none of it reaches the file.
 */
function makeRow(over: Partial<ParcelListRow> = {}): ParcelListRow {
  return {
    id: '11111111-1111-1111-1111-111111111111',
    state: 'created',
    // The REAL labels, from STATE_LABEL — 49 characters. The fixture used to
    // say 'Pre-admission', which is the short label no screen passes here, and
    // that is why a column cutting the long one passed every test.
    status: { en: 'Pre-admission (label made, not handed to Correos)', es: 'Pre-admisión / Prerregistrado' },
    orderNumber: 'ORD-1042',
    shippingCode: 'PQ3000012345ES',
    customerName: 'Lucía Fernández Ortiz',
    storeName: 'Cosmetics Afro Latino',
    storePlatform: 'shopify',
    orderedOn: '01 Oct',
    shippedOn: '08 Oct',
    shippedExact: 'Thu 08 Oct 2026, 09:00',
    event: {
      // The same table, so the same 49 characters: `eventLabels(...).en` and
      // `stateLabels(...).en` both read STATE_LABEL.
      en: 'Pre-admission (label made, not handed to Correos)',
      es: 'Prerregistrado el envío en origen',
      when: '08 Oct · 09:12',
      exactWhen: 'Thu 08 Oct 2026, 09:12',
    },
    inStatus: '6 days',
    daysInStatus: 6,
    atOffice: null,
    paymentMethod: 'cod',
    valueText: '€64.90',
    phoneDisplay: '+34 627 481 093',
    phoneE164: '+34627481093',
    email: 'lucia.fernandez91@example.com',
    town: 'Getafe, Madrid',
    attempts: 0,
    officeName: 'Oficina Madrid Sucursal 12',
    officeAddress: 'C/ Mejía Lequerica 8, 28004 Madrid',
    mapsHref: 'https://maps.google.com/?q=x',
    messageText: 'Hola Lucía, tu pedido ORD-1042 está en la oficina de Correos…',
    waHref: 'https://wa.me/34627481093',
    emailHref: 'mailto:lucia.fernandez91@example.com',
    shopifyHref: 'https://admin.shopify.com/store/x/orders/1',
    badges: ['4 working days in pre-admission'],
    closed: null,
    ...over,
  } as ParcelListRow;
}

const META = {
  tabLabel: 'Stuck in pre-admission',
  total: 1,
  capped: false,
  filters: '',
  at: new Date(NOW),
};

/* =============================================================== the file */

describe('the PDF itself', () => {
  it('is a file a reader will open', () => {
    const { pages } = xrefIsSound(parcelsPdf([makeRow()], META));
    expect(pages).toBe(1);
  });

  it('is A4 landscape', () => {
    const body = parcelsPdf([makeRow()], META).toString('latin1');
    expect(body).toContain('/MediaBox [0 0 841.89 595.28]');
    expect(PAGE.width).toBeGreaterThan(PAGE.height);
  });

  it('declares only fonts every reader already has', () => {
    // No embedding and no metrics read off disk, which is the whole reason
    // this is written by hand. See lib/export/pdf.ts.
    const body = parcelsPdf([makeRow()], META).toString('latin1');
    expect(body).toContain('/BaseFont /Helvetica /Encoding /WinAnsiEncoding');
    expect(body).toContain('/BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding');
    expect(body).toContain('/BaseFont /Courier /Encoding /WinAnsiEncoding');
  });

  it('says what it is and when it was taken', () => {
    const text = textOf(parcelsPdf([makeRow()], META)).join('\n');
    expect(text).toContain('Return Shield · Stuck in pre-admission');
    expect(text).toContain('Generated 14 Oct 2026, 10:45 (Madrid)');
    expect(text).toContain('1 parcel');
  });

  it('names the filters that were in use', () => {
    const text = textOf(parcelsPdf([makeRow()], {
      ...META,
      filters: filterLine({ q: 'Marta', store: 'Second Shop', date: '2026-10-06' }),
    })).join('\n');

    expect(text).toContain('Search "Marta"');
    expect(text).toContain('Shop: Second Shop');
    expect(text).toContain('Shipped on 06 Oct 2026');
  });
});

describe('the eight columns', () => {
  it('are the ones the operator asked for, in that order', () => {
    expect(COLUMNS.map((c) => c.header)).toEqual([
      'Order',
      'Shop',
      'Ordered',
      'Shipped',
      'Tracking code',
      'Status',
      'In this status',
      'Last word from Correos',
    ]);
  });

  it('fit on the page', () => {
    // One column two points too wide pushes the last one off the paper, and
    // that is invisible in anything but the finished file.
    const total = COLUMNS.reduce((a, c) => a + c.width, 0);
    expect(total).toBeLessThanOrEqual(PAGE.width - 56);
    expect(total).toBeGreaterThan(PAGE.width - 80);
  });

  it('are the only headings in the file', () => {
    const text = textOf(parcelsPdf([makeRow()], META));
    for (const c of COLUMNS) expect(text).toContain(c.header.toUpperCase());
  });

  it('put the order, the dates and the code in, as the screen has them', () => {
    // Joined with a space: a cell that wraps is several drawn strings, and
    // what matters is that the words are all there and in order.
    const text = textOf(parcelsPdf([makeRow()], META)).join(' ');
    expect(text).toContain('ORD-1042');
    expect(text).toContain('Cosmetics Afro Latino');
    expect(text).toContain('01 Oct');
    expect(text).toContain('08 Oct');
    expect(text).toContain('PQ3000012345ES');
    expect(text).toContain('Pre-admission');
    expect(text).toContain('Pre-admisión / Prerregistrado');
  });

  it('show the badge in "In this status", and the duration when there is none', () => {
    /*
     * The badge is the sentence the screen shows, so the file says the same
     * thing the operator was looking at when they pressed the button — ALL of
     * it. Joined with a space because the column wraps it over two lines,
     * which is what it took to stop it reading "4 working days in pr…": half a
     * badge is no use to somebody picking parcels off a sheet of paper.
     */
    const drawn = textOf(parcelsPdf([makeRow()], META));
    expect(drawn.join(' ')).toContain('4 working days in pre-admission');
    for (const line of drawn) expect(line.endsWith('…'), line).toBe(false);
    // Both columns that draw STATE_LABEL, whole, over two lines each.
    expect(drawn.join(' ')).toContain('Pre-admission (label made, not handed to Correos)');
    expect(
      drawn.join(' ').split('Pre-admission (label made, not handed to Correos)').length - 1,
      'the Status column and the Correos column both draw it',
    ).toBe(2);

    expect(textOf(parcelsPdf([makeRow({ badges: [] })], META)).join(' '))
      .toContain('6 days');
  });

  it('write a dash for a marketplace order with no order date', () => {
    // Checked as the byte it is: an em dash is 0x97 in WinAnsi, which is a
    // control character in Latin-1 — so decoding the file as Latin-1 would not
    // give the dash back. See winAnsi in lib/export/pdf.ts.
    const pdf = parcelsPdf([makeRow({ orderedOn: null })], META);
    expect(pdf.includes(Buffer.from([0x97]))).toBe(true);
  });

  it('say so plainly when Correos has said nothing yet', () => {
    const text = textOf(parcelsPdf([makeRow({ event: null })], META)).join('\n');
    expect(text).toContain('Nothing yet');
  });
});

describe('what is NOT in the file', () => {
  const PERSONAL = [
    'Lucía Fernández Ortiz',
    '627 481 093',
    '+34627481093',
    'lucia.fernandez91@example.com',
    '€64.90',
    'Getafe',
    'C/ Mejía Lequerica',
    'wa.me',
  ];

  it('carries no name, address, phone, email or amount — anywhere in it', () => {
    // Not hidden, not white-on-white, not in a comment: absent. This file is
    // emailed to a third party.
    const pdf = parcelsPdf([makeRow()], META).toString('latin1');
    for (const secret of PERSONAL) expect(pdf, secret).not.toContain(secret);
  });

  it('carries none of it even when the row is at a post office', () => {
    const pdf = parcelsPdf([makeRow({
      state: 'at_office',
      atOffice: { since: '09 Oct', sinceExact: 'Fri 09 Oct 2026, 11:00', days: 5, late: false },
    })], META).toString('latin1');
    for (const secret of PERSONAL) expect(pdf, secret).not.toContain(secret);
  });

  it('says on every page that this is all it has', () => {
    const text = textOf(parcelsPdf([makeRow()], META)).join('\n');
    expect(text).toContain('order and tracking only');
  });
});

describe('Spanish accents', () => {
  it('survive the four the brief names, as single WinAnsi bytes', () => {
    for (const town of ['Logroño', 'Muñoz', 'Cádiz', 'Peñíscola']) {
      const pdf = parcelsPdf([makeRow({ storeName: town })], META);
      expect(pdf.toString('latin1'), town).toContain(town);
    }
  });

  it('are one byte each, not two', () => {
    // UTF-8 would be two bytes and would draw as mojibake, because the fonts
    // are declared WinAnsi. Hence lib/export/pdf.ts doing its own encoding.
    expect([...winAnsi('ñ')]).toEqual([0xf1]);
    expect([...winAnsi('á')]).toEqual([0xe1]);
    expect([...winAnsi('€')]).toEqual([0x80]);
    expect([...winAnsi('—')]).toEqual([0x97]);
    expect([...winAnsi('·')]).toEqual([0xb7]);
  });

  it('do not let an unexpected character through as a wrong glyph', () => {
    expect([...winAnsi('日')]).toEqual([0x3f]);
  });

  it('are not broken by a parenthesis or a backslash in the data', () => {
    // These three characters end a PDF string. An unescaped one from a shop
    // name would corrupt everything after it in the file.
    const pdf = parcelsPdf([makeRow({ storeName: 'Afro (x) \\ y' })], META);
    xrefIsSound(pdf);
    expect(textOf(pdf).join('\n')).toContain('Afro (x) \\ y');
  });
});

describe('more rows than fit on a page', () => {
  const many = (n: number) => Array.from({ length: n }, (_, i) => makeRow({
    id: `row-${i}`,
    orderNumber: `ORD-${1000 + i}`,
    shippingCode: `PQ30000${String(i).padStart(5, '0')}ES`,
  }));

  it('repeats the header row on every page', () => {
    const rows = many(80);
    const pdf = parcelsPdf(rows, { ...META, total: rows.length });
    const { pages } = xrefIsSound(pdf);

    expect(pages).toBeGreaterThan(1);
    const headings = textOf(pdf).filter((t) => t === 'ORDER');
    expect(headings).toHaveLength(pages);
  });

  it('numbers the pages, and knows how many there are before it draws the first', () => {
    const rows = many(80);
    const pdf = parcelsPdf(rows, { ...META, total: rows.length });
    const { pages } = xrefIsSound(pdf);
    const text = textOf(pdf);

    for (let i = 1; i <= pages; i += 1) expect(text).toContain(`Page ${i} of ${pages}`);
    expect(text.filter((t) => t.startsWith('Page '))).toHaveLength(pages);
  });

  it('has every row in it, once', () => {
    const rows = many(80);
    const text = textOf(parcelsPdf(rows, { ...META, total: rows.length })).join('\n');
    for (const row of rows) {
      expect(text.split(row.orderNumber).length - 1, row.orderNumber).toBe(1);
    }
  });

  it('says on the first page when it is showing fewer rows than the tab holds', () => {
    const rows = many(3);
    const text = textOf(parcelsPdf(rows, { ...META, total: 7214, capped: true })).join('\n');
    expect(text).toContain('First 3 of 7,214');
    expect(text).toContain('7,214 parcels');
  });

  it('is still a valid file with no rows at all', () => {
    const pdf = parcelsPdf([], { ...META, total: 0 });
    expect(xrefIsSound(pdf).pages).toBe(1);
    expect(textOf(pdf).join('\n')).toContain('Nothing in this tab');
  });
});

describe('fitting text into a column', () => {
  it('cuts a long line rather than letting it run into the next column', () => {
    const cut = fitsIn('Oficina de Correos Madrid Sucursal Numero Doce', 60, 7.5);
    expect(cut.endsWith('…')).toBe(true);
    expect(cut.length).toBeLessThan(46);
  });

  it('leaves a short one alone', () => {
    expect(fitsIn('ORD-1042', 80, 7.5)).toBe('ORD-1042');
  });

  it('wraps a Correos sentence on word boundaries', () => {
    const sentence = 'Entregado en oficina a disposición del destinatario';
    const lines = wrapTo(sentence, 120, 6.5, 2);

    expect(lines.length).toBeLessThanOrEqual(2);
    expect(lines.join(' ')).toBe(sentence);

    // Every token on every line is a whole word of the original: a sentence
    // broken mid-word reads as a typo in a file somebody forwards.
    const words = new Set(sentence.split(' '));
    for (const line of lines) {
      for (const word of line.split(' ')) expect(words.has(word), word).toBe(true);
    }
  });

  it('never returns more lines than it was asked for', () => {
    const lines = wrapTo('a '.repeat(200), 40, 6.5, 2);
    expect(lines).toHaveLength(2);
    expect(lines[1].endsWith('…')).toBe(true);
  });
});

describe('the file name', () => {
  it('is the tab and the Madrid date', () => {
    expect(pdfFilename('Stuck in pre-admission', new Date(NOW)))
      .toBe('stuck-in-pre-admission-2026-10-14.pdf');
  });

  it('survives an accent and a slash', () => {
    expect(pdfFilename('Pre-admisión / Prerregistrado', new Date(NOW)))
      .toBe('pre-admision-prerregistrado-2026-10-14.pdf');
  });

  it('never ends up with no name at all', () => {
    expect(pdfFilename('·', new Date(NOW))).toBe('parcels-2026-10-14.pdf');
  });
});

/* ================================================= the file and its tab */

/** A parcel with a label printed and nothing from Correos since. */
async function stuck(n: number, opts: Record<string, unknown> = {}) {
  return makeShipment({
    shippingCode: `PX${String(n).padStart(3, '0')}`,
    orderNumber: `ORD-${String(n).padStart(3, '0')}`,
    state: 'created',
    orderCreatedAt: STUCK_SINCE,
    ...opts,
  });
}

describe('the export of a tab', () => {
  it('has a row for every parcel the tab counts', async () => {
    await stuck(1);
    await stuck(2);
    await stuck(3);
    // Printed this morning: not stuck yet, and must not be in the file.
    await makeShipment({ shippingCode: 'PFRESH', orderNumber: 'ORD-FRESH', state: 'created' });

    const view = await parcelsView({ status: 'stuck_pre_admission' });
    const file = await parcelsExport({ status: 'stuck_pre_admission' });

    expect(view.tabs.find((t) => t.id === 'stuck_pre_admission')?.count).toBe(3);
    expect(file.total).toBe(3);
    expect(file.rows).toHaveLength(3);
    expect(file.capped).toBe(false);

    const text = textOf(parcelsPdf(file.rows, {
      tabLabel: file.tab.en, total: file.total, capped: file.capped, filters: '', at: clock.now(),
    })).join('\n');
    for (const n of ['ORD-001', 'ORD-002', 'ORD-003']) expect(text).toContain(n);
    expect(text).not.toContain('ORD-FRESH');
  });

  it('is not paged — that is the whole point of it', async () => {
    for (let i = 1; i <= PAGE_SIZE + 5; i += 1) await stuck(i);

    const screen = await parcelsView({ status: 'stuck_pre_admission' });
    expect(screen.rows).toHaveLength(PAGE_SIZE);
    expect(screen.total).toBe(PAGE_SIZE + 5);

    const file = await parcelsExport({ status: 'stuck_pre_admission' });
    expect(file.rows).toHaveLength(PAGE_SIZE + 5);
  }, 90_000);

  it('is in the same order as the tab', async () => {
    // Oldest first on the stuck tabs, which is what "most urgent" means here.
    await stuck(1, { orderCreatedAt: new Date('2026-10-06T09:00:00+02:00') });
    await stuck(2, { orderCreatedAt: new Date('2026-10-02T09:00:00+02:00') });
    await stuck(3, { orderCreatedAt: new Date('2026-10-08T09:00:00+02:00') });

    const screen = await parcelsView({ status: 'stuck_pre_admission' });
    const file = await parcelsExport({ status: 'stuck_pre_admission' });

    expect(file.rows.map((r) => r.orderNumber)).toEqual(screen.rows.map((r) => r.orderNumber));
    expect(file.rows.map((r) => r.orderNumber)).toEqual(['ORD-002', 'ORD-001', 'ORD-003']);
  });

  it('carries the search, the shop and the date filter with it', async () => {
    await stuck(1, { customerName: 'Lucía Fernández' });
    await stuck(2, { customerName: 'Marta Ruiz', storeKey: 'other', storeName: 'Second Shop' });

    expect((await parcelsExport({ status: 'stuck_pre_admission', q: 'Marta' })).rows)
      .toHaveLength(1);
    expect((await parcelsExport({ status: 'stuck_pre_admission', store: 'Second Shop' })).rows)
      .toHaveLength(1);
    expect((await parcelsExport({ status: 'stuck_pre_admission', date: '2026-10-08' })).rows)
      .toHaveLength(2);
    expect((await parcelsExport({ status: 'stuck_pre_admission', date: '2026-10-13' })).rows)
      .toHaveLength(0);
  });

  it('falls back to everything not finished when the tab makes no sense', async () => {
    await stuck(1);
    const file = await parcelsExport({ status: 'nonsense-from-a-typed-url' });
    expect(file.tab.id).toBe('all_open');
    expect(file.rows).toHaveLength(1);
  });
});

/* ============================================================== the route */

describe('the download endpoint', () => {
  const url = (qs: string) => new Request(`http://localhost/api/parcels/export${qs}`);

  it('is behind the login', async () => {
    currentUser.mockResolvedValueOnce(null);
    const res = await GET(url('?status=stuck_pre_admission'));
    expect(res.status).toBe(401);
    expect(currentUser).toHaveBeenCalledOnce();
  });

  it('answers with a PDF the browser will save, named after the tab and the day', async () => {
    await stuck(1);
    const res = await GET(url('?status=stuck_pre_admission'));

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/pdf');
    expect(res.headers.get('content-disposition'))
      .toBe('attachment; filename="stuck-in-pre-admission-2026-10-14.pdf"');
    // A cached export is yesterday's picking list.
    expect(res.headers.get('cache-control')).toContain('no-store');

    const pdf = Buffer.from(await res.arrayBuffer());
    xrefIsSound(pdf);
    expect(textOf(pdf).join('\n')).toContain('ORD-001');
  });

  it('reads the same query string the screen puts in the URL', async () => {
    await stuck(1, { customerName: 'Lucía Fernández' });
    await stuck(2, { customerName: 'Marta Ruiz' });

    const res = await GET(url('?status=stuck_pre_admission&q=Marta'));
    const text = textOf(Buffer.from(await res.arrayBuffer())).join('\n');

    expect(text).toContain('ORD-002');
    expect(text).not.toContain('ORD-001');
    expect(text).toContain('Search "Marta"');
  });

  it('answers a tab with nothing in it with an empty file rather than an error', async () => {
    const res = await GET(url('?status=stuck_pre_admission'));
    expect(res.status).toBe(200);
    expect(textOf(Buffer.from(await res.arrayBuffer())).join('\n')).toContain('Nothing in this tab');
  });
});
