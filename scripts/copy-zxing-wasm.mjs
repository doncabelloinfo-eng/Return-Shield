/**
 * Puts the barcode decoder in public/, so we serve it ourselves.
 *
 * Runs as `prebuild`, which npm fires before every `npm run build` — so it
 * happens on Vercel, after `npm install` and before `next build`, with no step
 * anybody has to remember.
 *
 * WHY NOT THE CDN. `zxing-wasm` loads `zxing_reader.wasm` from jsDelivr by
 * default: about 950 KB from a third party, in the request path of the one
 * thing the warehouse actually needs to work. A CDN that is slow, blocked by a
 * phone's network, or simply down on a Tuesday is a warehouse that cannot scan
 * — for a file that never changes between deploys and that we already have on
 * disk. components/scan/useScanner.ts points `locateFile` at the copy this
 * makes, and next.config.mjs serves it immutable.
 *
 * IT FAILS THE BUILD IF THE FILE IS MISSING, deliberately. A warning would
 * produce a deploy that looks fine, installs fine, opens the camera fine, and
 * reads nothing — found by a worker holding a parcel rather than by the build.
 */
import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const from = join(root, 'node_modules', 'zxing-wasm', 'dist', 'reader', 'zxing_reader.wasm');
const to = join(root, 'public', 'zxing_reader.wasm');

if (!existsSync(from)) {
  console.error(
    `Could not find ${from}.\n`
    + 'The Scanner decodes Correos barcodes with zxing-wasm and serves the decoder\n'
    + 'itself rather than from a CDN. Run `npm install` first; if the path has moved\n'
    + 'in a new version of the package, update this script and\n'
    + 'components/scan/useScanner.ts together.',
  );
  process.exit(1);
}

mkdirSync(dirname(to), { recursive: true });
copyFileSync(from, to);
console.log(`copied the barcode decoder: ${(statSync(to).size / 1024).toFixed(0)} KB -> public/zxing_reader.wasm`);
