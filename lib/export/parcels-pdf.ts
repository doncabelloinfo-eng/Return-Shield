import type { ParcelListRow } from '@/lib/views/parcels';
import { fmt, madridDateKey, shortDate } from '@/lib/time';
import {
  PAGE, fitsIn, pdfDocument, wrapTo,
  type PdfFont, type PdfPage, type PdfRule, type PdfText,
} from './pdf';

/**
 * The tab, as a sheet of paper for the warehouse.
 *
 * WHAT IS IN IT IS THE OPERATOR'S CHOICE, and the choice was order and
 * tracking only — no customer name, no address, no phone, no email, no amount.
 * This file is emailed to a third party, so those columns are not "not shown",
 * they are NOT PRESENT: there is nothing to scroll to and nothing hidden
 * behind a white fill. tests/export-pdf.test.ts asserts that none of them
 * appears anywhere in the bytes.
 *
 * The rows arrive already decided — same query, same predicates, same order as
 * the screen (lib/views/parcels.ts). Nothing here filters or sorts; it only
 * measures and draws.
 */

const MARGIN = 28;
const GUTTER = 8;

/** 7.5pt body text on 9.5pt of leading: eight columns need the room. */
const BODY = 7.5;
const LEADING = 9.5;
const SMALL = 6.5;

/**
 * One piece of text in a cell. A cell can hold several, stacked.
 *
 * `wrap` is how many lines the piece may take; the default of one means cut it
 * to the column instead. It is stated per piece rather than worked out from
 * the colour — which is what this used to do, and which truncated the badge in
 * "In this status" to "4 working days in pr…" because nothing said that column
 * was allowed a second line.
 */
interface Piece {
  text: string;
  font?: PdfFont;
  grey?: number;
  /** 6.5pt instead of 7.5pt, for the secondary line in a cell. */
  small?: boolean;
  wrap?: number;
}

interface Column {
  header: string;
  width: number;
  lines: (row: ParcelListRow) => Piece[];
}

/**
 * The eight columns of the brief, in its order.
 *
 * The widths add up to 785, inside the 785.89pt a 28pt margin leaves on an A4
 * landscape page, and a test checks that sum rather than trusting the eye:
 * one column two points too wide pushes the last one off the paper, which is
 * not visible in anything but the finished file.
 */
export const COLUMNS: readonly Column[] = [
  {
    header: 'Order',
    width: 80,
    lines: (r) => [{ text: r.orderNumber, font: 'bold' }],
  },
  {
    header: 'Shop',
    width: 100,
    lines: (r) => [{ text: r.storeName }],
  },
  {
    header: 'Ordered',
    width: 52,
    // The marketplace tracking files carry no order date, and a made-up one
    // would be worse than a dash.
    lines: (r) => [{ text: r.orderedOn ?? '—' }],
  },
  {
    header: 'Shipped',
    width: 52,
    lines: (r) => [{ text: r.shippedOn }],
  },
  {
    header: 'Tracking code',
    width: 126,
    // Fixed width, because these get read out character by character over the
    // phone and compared against a label by eye.
    lines: (r) => [{ text: r.shippingCode, font: 'mono' }],
  },
  {
    header: 'Status',
    width: 128,
    // Two lines for the English label too: several of them are a phrase, not
    // a word — "Pre-admission (label made, nothing from Correos)" — and it was
    // being cut to "Pre-admission (label made,…".
    lines: (r) => [
      { text: r.status.en, wrap: 2 },
      ...(r.status.es ? [{ text: r.status.es, grey: 0.45, small: true, wrap: 2 }] : []),
    ],
  },
  {
    header: 'In this status',
    width: 100,
    // The badge when the row has one — "3 working days in pre-admission" — and
    // the plain duration when it does not. The badge is the sentence the
    // screen shows, so the file and the screen say the same thing.
    // Two lines, because the badge is a sentence and half of it is no use:
    // "4 working days in pre-admission" does not fit on one.
    lines: (r) => [{ text: r.badges[0] ?? r.inStatus, wrap: 2 }],
  },
  {
    header: 'Last word from Correos',
    width: 147,
    /*
     * `wrap: 2` on the English label here too, and for the same reason as the
     * Status column: this draws the SAME string. `eventLabels(...).en` reads
     * the same `STATE_LABEL` table as `stateLabels(...).en`, so a parcel in
     * `created` — every row of the Pre-admission and Stuck-in-pre-admission
     * tabs — carried "Pre-admission (label made, not handed to Correos)" in
     * both columns, wrapped in one and cut to "…(label made, not h…" in the
     * other, on the same row.
     */
    lines: (r) => (r.event
      ? [
        { text: r.event.en, wrap: 2 },
        { text: r.event.es, grey: 0.45, small: true, wrap: 2 },
        { text: r.event.when, grey: 0.45, small: true },
      ]
      : [{ text: 'Nothing yet', grey: 0.45, small: true }]),
  },
];

const CONTENT_WIDTH = PAGE.width - MARGIN * 2;

/** Where each column starts, left to right. */
function columnX(): number[] {
  const xs: number[] = [];
  let x = MARGIN;
  for (const c of COLUMNS) { xs.push(x); x += c.width; }
  return xs;
}

export interface PdfMeta {
  /** "Stuck in pre-admission". */
  tabLabel: string;
  /** What the tab holds, which may be more than the rows given. */
  total: number;
  capped: boolean;
  /** "Search "Marta" · Shop: Afro Latino · Shipped on 2026-10-06", or ''. */
  filters: string;
  at: Date;
}

/**
 * Every line a cell draws, measured and wrapped.
 *
 * THE ONLY PLACE THAT DECIDES THIS, which is the point: the height of a row
 * and the text drawn into it are two passes over the same answer, and a row
 * that reserved three lines and drew four would overlap the one beneath it.
 */
interface DrawnLine {
  text: string;
  font?: PdfFont;
  grey?: number;
  size: number;
}

function cellLines(column: Column, row: ParcelListRow): DrawnLine[] {
  const width = column.width - GUTTER;
  const out: DrawnLine[] = [];

  for (const piece of column.lines(row)) {
    if (!piece.text) continue;
    const size = piece.small ? SMALL : BODY;
    const parts = (piece.wrap ?? 1) > 1
      ? wrapTo(piece.text, width, size, piece.wrap ?? 1, piece.font)
      : [fitsIn(piece.text, width, size, piece.font)];

    for (const text of parts) out.push({ text, font: piece.font, grey: piece.grey, size });
  }

  return out;
}

/** How tall a row is: however many lines its tallest column needs. */
function rowHeight(row: ParcelListRow): number {
  let most = 1;
  for (const c of COLUMNS) most = Math.max(most, cellLines(c, row).length);
  return most * LEADING + 5;
}

const HEADER_TOP = MARGIN + 46;
const TABLE_TOP = HEADER_TOP + 22;
const FOOTER_TOP = PAGE.height - MARGIN - 10;

/** Rows are laid out before anything is drawn, so "Page 2 of 5" can be right. */
function paginate(rows: readonly ParcelListRow[]): ParcelListRow[][] {
  const pages: ParcelListRow[][] = [];
  let page: ParcelListRow[] = [];
  let y = TABLE_TOP;

  for (const row of rows) {
    const height = rowHeight(row);
    if (page.length && y + height > FOOTER_TOP - 14) {
      pages.push(page);
      page = [];
      y = TABLE_TOP;
    }
    page.push(row);
    y += height;
  }

  pages.push(page);
  return pages;
}

export function parcelsPdf(rows: readonly ParcelListRow[], meta: PdfMeta): Buffer {
  const xs = columnX();
  const sheets = paginate(rows);

  const pages: PdfPage[] = sheets.map((sheet, index) => {
    const texts: PdfText[] = [];
    const rules: PdfRule[] = [];

    /* ----------------------------------------------------------- heading */
    texts.push({
      x: MARGIN, y: MARGIN + 12, size: 14, font: 'bold',
      text: `Return Shield · ${meta.tabLabel}`,
    });

    const counted = `${meta.total.toLocaleString('en-GB')} ${meta.total === 1 ? 'parcel' : 'parcels'}`;
    texts.push({
      x: MARGIN, y: MARGIN + 26, size: BODY, grey: 0.42,
      text: [counted, meta.filters].filter(Boolean).join(' · '),
    });
    texts.push({
      x: MARGIN, y: MARGIN + 37, size: BODY, grey: 0.42,
      text: `Generated ${fmt(meta.at).date} ${fmt(meta.at).year}, ${fmt(meta.at).time} (Madrid)`,
    });

    // Said once, on the first page, where somebody reading the file will see
    // it before they start working through it.
    if (meta.capped && index === 0) {
      texts.push({
        x: MARGIN + 430, y: MARGIN + 12, size: BODY, font: 'bold',
        text: `First ${rows.length.toLocaleString('en-GB')} of ${meta.total.toLocaleString('en-GB')}`
          + ' — narrow the search to get the rest',
      });
    }

    /* ------------------------------------------------- the header row */
    for (const [i, c] of COLUMNS.entries()) {
      texts.push({
        x: xs[i], y: HEADER_TOP, size: SMALL, font: 'bold', grey: 0.3,
        text: c.header.toUpperCase(),
      });
    }
    rules.push({
      x1: MARGIN, y1: HEADER_TOP + 5, x2: MARGIN + CONTENT_WIDTH, y2: HEADER_TOP + 5, grey: 0.5,
    });

    /* ------------------------------------------------------------- rows */
    let y = TABLE_TOP;
    for (const row of sheet) {
      for (const [i, c] of COLUMNS.entries()) {
        for (const [line, piece] of cellLines(c, row).entries()) {
          texts.push({
            x: xs[i],
            y: y + line * LEADING,
            text: piece.text,
            size: piece.size,
            font: piece.font,
            grey: piece.grey,
          });
        }
      }

      y += rowHeight(row);
      rules.push({ x1: MARGIN, y1: y - 7, x2: MARGIN + CONTENT_WIDTH, y2: y - 7, grey: 0.9 });
    }

    if (!sheet.length) {
      texts.push({ x: MARGIN, y: TABLE_TOP + 4, size: BODY, grey: 0.42, text: 'Nothing in this tab.' });
    }

    /* ----------------------------------------------------------- the foot */
    texts.push({
      x: MARGIN, y: FOOTER_TOP, size: SMALL, grey: 0.45,
      text: `Page ${index + 1} of ${sheets.length}`,
    });
    texts.push({
      x: MARGIN + CONTENT_WIDTH - 150, y: FOOTER_TOP, size: SMALL, grey: 0.45,
      text: 'Return Shield · order and tracking only',
    });

    return { texts, rules };
  });

  return pdfDocument(pages, { title: `Return Shield · ${meta.tabLabel}` });
}

/**
 * "stuck-in-pre-admission-2026-10-14.pdf".
 *
 * The date is in the name because these land in a mailbox and get opened a
 * week later, and "which day is this from" is the first thing anybody asks.
 * ASCII only and no spaces: the name travels through email and WhatsApp.
 */
export function pdfFilename(tabLabel: string, at: Date): string {
  const slug = tabLabel
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return `${slug || 'parcels'}-${madridDateKey(at)}.pdf`;
}

/**
 * The filters in use, for the line under the heading.
 *
 * It has to name EVERY filter the rows went through. A file headed "Stuck in
 * pre-admission" that is silently only the parcels nobody scanned out is a file
 * somebody acts on believing it is the whole tab — which is the same mistake
 * the `?date=banana` heading made, from the other direction.
 */
export function filterLine(opts: {
  q?: string; store?: string; date?: string; scanned?: string;
}): string {
  const bits: string[] = [];
  if (opts.q) bits.push(`Search "${opts.q}"`);
  if (opts.store) bits.push(`Shop: ${opts.store}`);
  if (opts.scanned === 'out') bits.push('Left the warehouse');
  if (opts.scanned === 'not') bits.push('Not scanned out');
  if (opts.date) {
    /*
     * The caller passes the date the SQL predicate was built from
     * (`parseDayFilter(date)?.key`), so this is already known-good. Checked
     * again anyway, because the version that trusted its input answered
     * `?date=banana` with a 500: `Intl.DateTimeFormat` throws RangeError on an
     * Invalid Date, and a heading is not worth failing a download over.
     */
    const [y, m, d] = opts.date.split('-').map(Number);
    const when = new Date(Date.UTC(y, (m || 1) - 1, d || 1, 12));
    if (Number.isFinite(when.getTime())) bits.push(`Shipped on ${shortDate(when)} ${y}`);
  }
  return bits.join(' · ');
}
