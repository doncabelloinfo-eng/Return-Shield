/**
 * A PDF, written out by hand.
 *
 * WHY NOT A LIBRARY. Nothing in this project renders a PDF yet, so any library
 * is a new dependency — and the brief names the trap that comes with the
 * obvious one: pdfkit reads its font metrics (.afm) off disk at runtime, which
 * Next's output tracing is liable to leave out of a serverless bundle, so it
 * works in a test and throws on Vercel. That is a failure this session could
 * not have caught, because this container cannot reach the npm registry to
 * install anything at all.
 *
 * So: no dependency, no font files, nothing read from disk. A PDF that uses
 * only the base-14 fonts — Helvetica, Helvetica-Bold, Courier — is a few
 * hundred bytes of structure around some text, and every reader has those
 * fonts built in. The file this produces has no compression and no font
 * embedding, which also makes it readable with `strings` and testable without
 * a parser.
 *
 * WHAT IT DOES NOT DO. It does not measure text. Real widths need the metrics
 * this deliberately avoids, so `fitsIn` estimates — exactly, for Courier,
 * where every glyph is 600/1000 of an em, and conservatively for the other
 * two, so a long line is truncated a character early rather than running into
 * the next column.
 */

/** A4, landscape, in points. */
export const PAGE = { width: 841.89, height: 595.28 } as const;

export type PdfFont = 'regular' | 'bold' | 'mono';

/** One run of text. `y` is measured DOWN FROM THE TOP of the page. */
export interface PdfText {
  x: number;
  y: number;
  text: string;
  font?: PdfFont;
  size?: number;
  /** 0 is black, 1 is white. 0.42 is the grey the screens use for notes. */
  grey?: number;
}

/** A rule. Both `y`s are measured down from the top. */
export interface PdfRule {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  width?: number;
  grey?: number;
}

export interface PdfPage {
  texts: PdfText[];
  rules: PdfRule[];
}

const FONT_REF: Record<PdfFont, string> = {
  regular: '/F1',
  bold: '/F2',
  mono: '/F3',
};

/**
 * Average glyph width as a fraction of the font size.
 *
 * Courier is exact: it is monospaced at 600/1000. The other two are an
 * estimate on the generous side of the true average, so text is cut slightly
 * early rather than overlapping the column beside it.
 */
const WIDTH_FACTOR: Record<PdfFont, number> = {
  regular: 0.56,
  bold: 0.58,
  mono: 0.6,
};

export function textWidth(text: string, size: number, font: PdfFont = 'regular'): number {
  return text.length * size * WIDTH_FACTOR[font];
}

/** The text, cut to fit `max` points, with an ellipsis when it was cut. */
export function fitsIn(text: string, max: number, size: number, font: PdfFont = 'regular'): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (textWidth(clean, size, font) <= max) return clean;

  const room = Math.max(1, Math.floor(max / (size * WIDTH_FACTOR[font])) - 1);
  return `${clean.slice(0, room).trimEnd()}…`;
}

/**
 * The text broken into at most `maxLines` lines that each fit `max` points.
 *
 * Greedy, on word boundaries, because what goes through here is Correos' own
 * sentences — "Entregado en oficina a disposición del destinatario" — and a
 * line break in the middle of a word reads as a typo in a file somebody
 * forwards.
 */
export function wrapTo(
  text: string, max: number, size: number, maxLines: number, font: PdfFont = 'regular',
): string[] {
  const words = text.replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  if (!words.length) return [];

  const lines: string[] = [];
  let line = '';

  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (textWidth(candidate, size, font) <= max) { line = candidate; continue; }

    if (line) lines.push(line);
    // Out of lines with a word still in hand: say so with an ellipsis rather
    // than stopping mid-sentence as though that were the end of it.
    if (lines.length >= maxLines) return ellipsise(lines, maxLines);
    line = word;
  }

  if (line) lines.push(line);
  return lines.length > maxLines ? ellipsise(lines, maxLines) : lines;
}

function ellipsise(lines: string[], maxLines: number): string[] {
  const kept = lines.slice(0, maxLines);
  kept[maxLines - 1] = `${kept[maxLines - 1].replace(/…$/, '')}…`;
  return kept;
}

/* ------------------------------------------------------------------ bytes */

/**
 * Text as WinAnsi bytes, which is what the fonts are declared as.
 *
 * WinAnsi is CP1252, so every Spanish accent — Logroño, Muñoz, Cádiz,
 * Peñíscola — is a single byte and identical to Latin-1. The typographic
 * characters this app actually uses are not, so they are mapped by hand;
 * anything else above U+00FF becomes a question mark rather than silently
 * turning into a wrong glyph.
 */
const CP1252: Record<string, number> = {
  '€': 0x80, '‚': 0x82, '„': 0x84, '…': 0x85, '†': 0x86, '‡': 0x87,
  'ˆ': 0x88, '‰': 0x89, '‹': 0x8b, '‘': 0x91, '’': 0x92, '“': 0x93,
  '”': 0x94, '•': 0x95, '–': 0x96, '—': 0x97, '™': 0x99, '›': 0x9b,
};

export function winAnsi(text: string): Buffer {
  const out: number[] = [];
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 63;
    if (code === 0x0a || code === 0x0d) { out.push(0x20); continue; }
    if (code < 0x20) continue;
    if (code <= 0xff) { out.push(code); continue; }
    const mapped = CP1252[ch];
    out.push(mapped ?? 0x3f);
  }
  return Buffer.from(out);
}

/** A PDF string literal: the three characters that would end it, escaped. */
function literal(text: string): Buffer {
  const bytes = winAnsi(text);
  const out: number[] = [0x28]; // (
  for (const b of bytes) {
    if (b === 0x28 || b === 0x29 || b === 0x5c) out.push(0x5c);
    out.push(b);
  }
  out.push(0x29); // )
  return Buffer.from(out);
}

const n = (value: number) => (Math.round(value * 100) / 100).toString();

function contentStream(page: PdfPage): Buffer {
  const parts: Buffer[] = [];

  for (const r of page.rules) {
    parts.push(Buffer.from(
      `${n(r.width ?? 0.5)} w ${n(r.grey ?? 0.85)} G `
      + `${n(r.x1)} ${n(PAGE.height - r.y1)} m ${n(r.x2)} ${n(PAGE.height - r.y2)} l S\n`,
      'latin1',
    ));
  }

  for (const t of page.texts) {
    if (!t.text) continue;
    parts.push(Buffer.from(`${n(t.grey ?? 0)} g BT ${FONT_REF[t.font ?? 'regular']} ${n(t.size ?? 8)} Tf `
      + `1 0 0 1 ${n(t.x)} ${n(PAGE.height - t.y)} Tm `, 'latin1'));
    parts.push(literal(t.text));
    parts.push(Buffer.from(' Tj ET\n', 'latin1'));
  }

  return Buffer.concat(parts);
}

/**
 * The finished file.
 *
 * Object numbers are worked out up front rather than fixed up afterwards — 1
 * catalog, 2 page tree, 3–5 the fonts, then two objects per page — so the
 * `/Kids` array and the cross-reference table cannot disagree with each other.
 * The xref offsets are counted in bytes as the file is assembled, which is the
 * one thing in a PDF that has to be exactly right for a reader to open it at
 * all.
 */
export function pdfDocument(pages: PdfPage[], meta: { title: string } = { title: '' }): Buffer {
  const pageObjects = pages.map((_, i) => 6 + i * 2);
  const objects: Buffer[] = [];
  const text = (body: string) => Buffer.from(body, 'latin1');

  objects.push(text('<< /Type /Catalog /Pages 2 0 R >>'));
  objects.push(text(
    `<< /Type /Pages /Count ${pages.length} `
    + `/Kids [${pageObjects.map((o) => `${o} 0 R`).join(' ')}] >>`,
  ));
  for (const base of ['Helvetica', 'Helvetica-Bold', 'Courier']) {
    objects.push(text(
      `<< /Type /Font /Subtype /Type1 /BaseFont /${base} /Encoding /WinAnsiEncoding >>`,
    ));
  }

  for (const [i, page] of pages.entries()) {
    const stream = contentStream(page);
    objects.push(text(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${n(PAGE.width)} ${n(PAGE.height)}] `
      + '/Resources << /Font << /F1 3 0 R /F2 4 0 R /F3 5 0 R >> >> '
      + `/Contents ${pageObjects[i] + 1} 0 R >>`,
    ));
    objects.push(Buffer.concat([
      text(`<< /Length ${stream.length} >>\nstream\n`),
      stream,
      text('\nendstream'),
    ]));
  }

  // The document title, as its own object: /Info must be an indirect
  // reference, and a dictionary written straight into the trailer is the kind
  // of almost-valid PDF that opens in one reader and not another.
  let infoObject = 0;
  if (meta.title) {
    objects.push(Buffer.concat([
      text('<< /Title '), literal(meta.title), text(' /Producer (Return Shield) >>'),
    ]));
    infoObject = objects.length;
  }

  const chunks: Buffer[] = [];
  let offset = 0;
  const push = (b: Buffer | string) => {
    const buf = typeof b === 'string' ? Buffer.from(b, 'latin1') : b;
    chunks.push(buf);
    offset += buf.length;
  };

  push('%PDF-1.4\n');
  // A comment of high bytes, so anything that moves this file treats it as
  // binary rather than helpfully converting its line endings.
  push(Buffer.from([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));

  const at: number[] = [];
  for (const [i, body] of objects.entries()) {
    at.push(offset);
    push(`${i + 1} 0 obj\n`);
    push(body);
    push('\nendobj\n');
  }

  const xref = offset;
  push(`xref\n0 ${objects.length + 1}\n`);
  // Every entry is exactly twenty bytes, including this first free one.
  push('0000000000 65535 f \n');
  for (const o of at) push(`${String(o).padStart(10, '0')} 00000 n \n`);

  push(
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R`
    + (infoObject ? ` /Info ${infoObject} 0 R` : '')
    + ` >>\nstartxref\n${xref}\n%%EOF\n`,
  );

  return Buffer.concat(chunks);
}
