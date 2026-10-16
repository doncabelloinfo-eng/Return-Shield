/**
 * Draws the Scanner's app icons, and commits the result.
 *
 * Run with `node scripts/make-scan-icons.mjs`. It writes
 * public/scan/icon-192.png, icon-512.png and icon-maskable-512.png, which are
 * committed rather than generated at build time — an icon that is produced by
 * the build is an icon nobody ever looks at, and Chrome refuses to offer
 * "Install" at all if one of them is missing or unreadable.
 *
 * NO IMAGE LIBRARY. A PNG is a header, one zlib stream of filtered scanlines
 * and a footer, and `node:zlib` is already here — so this needs nothing
 * installed, which matters because the icons have to be reproducible from a
 * clean checkout. The drawing is two rectangles' worth of logic: Return
 * Shield's navy, with its accent-yellow barcode across the middle. The same
 * stripe is on the Scanner's own sign-in screen.
 *
 * The maskable one keeps the stripe well inside the centre 80%, which is the
 * only part Android is guaranteed not to crop when it masks the icon into
 * whatever shape the launcher uses.
 */
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(dirname(fileURLToPath(import.meta.url))), 'public', 'scan');

/** app/globals.css: --navy and --accent. */
const NAVY = [0x10, 0x20, 0x3d];
const ACCENT = [0xf2, 0xb7, 0x05];

/** The barcode, as a list of [start, width] in fractions of the stripe. */
const BARS = [
  [0.00, 0.08], [0.12, 0.04], [0.20, 0.12], [0.36, 0.04],
  [0.44, 0.08], [0.56, 0.16], [0.76, 0.04], [0.84, 0.08], [0.96, 0.04],
];

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i += 1) {
    c ^= buf[i];
    for (let k = 0; k < 8; k += 1) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(data.length + 12);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  const body = out.subarray(4, 8 + data.length);
  out.writeUInt32BE(crc32(body), 8 + data.length);
  return out;
}

/** An RGB PNG from a pixel function. No alpha: the field is opaque navy. */
function png(size, pixel) {
  const stride = size * 3;
  // One filter byte (0 = none) in front of each scanline.
  const rawLength = (stride + 1) * size;
  const raw = Buffer.alloc(rawLength);

  for (let y = 0; y < size; y += 1) {
    const row = y * (stride + 1);
    raw[row] = 0;
    for (let x = 0; x < size; x += 1) {
      const [r, g, b] = pixel(x, y);
      raw[row + 1 + x * 3] = r;
      raw[row + 2 + x * 3] = g;
      raw[row + 3 + x * 3] = b;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;   // 8 bits per channel
  ihdr[9] = 2;   // truecolour
  ihdr[10] = 0;  // deflate
  ihdr[11] = 0;  // adaptive filtering
  ihdr[12] = 0;  // no interlace

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * `reach` is how much of the icon the stripe may use.
 *
 * 0.62 for the ordinary icons, which are shown whole. 0.5 for the maskable
 * one, so the stripe stays inside the centre 80% a launcher may crop to.
 */
function drawer(size, reach) {
  const width = size * reach;
  const left = (size - width) / 2;
  const height = Math.round(size * reach * 0.46);
  const top = Math.round((size - height) / 2);

  return (x, y) => {
    if (y < top || y >= top + height) return NAVY;
    const at = (x - left) / width;
    if (at < 0 || at >= 1) return NAVY;
    return BARS.some(([from, w]) => at >= from && at < from + w) ? ACCENT : NAVY;
  };
}

mkdirSync(OUT, { recursive: true });

const files = [
  ['icon-192.png', 192, 0.62],
  ['icon-512.png', 512, 0.62],
  ['icon-maskable-512.png', 512, 0.50],
];

for (const [name, size, reach] of files) {
  const file = join(OUT, name);
  writeFileSync(file, png(size, drawer(size, reach)));
  console.log(`wrote ${name} (${size}×${size})`);
}
