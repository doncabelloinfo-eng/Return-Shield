import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  experimental: { serverActions: { bodySizeLimit: '10mb' } },

  /**
   * The barcode decoder, cached for ever.
   *
   * `prebuild` copies `zxing_reader.wasm` out of node_modules into public/, so
   * its contents are fixed for the life of a deploy and about 950 KB. Immutable
   * means a warehouse phone fetches it once rather than revalidating it every
   * morning — and a new version arrives as a new deploy, which is a new build
   * of the page that asks for it.
   *
   * The service worker gets the opposite treatment in its own route handler
   * (app/scan-sw.js/route.ts): never cached, so a change to it reaches a phone
   * on the next visit.
   */
  async headers() {
    return [
      {
        source: '/zxing_reader.wasm',
        headers: [
          { key: 'Cache-Control', value: 'public, max-age=31536000, immutable' },
          { key: 'Content-Type', value: 'application/wasm' },
        ],
      },
    ];
  },

  webpack: (config) => {
    // `@/*` is declared in tsconfig for the editor and for tsc. Declaring it
    // here too means the build does not depend on Next picking the tsconfig
    // `paths` up, which it does not do reliably with `moduleResolution:
    // "bundler"`. One alias, two places, no surprises.
    config.resolve.alias = { ...config.resolve.alias, '@': root };
    return config;
  },
};

export default nextConfig;
