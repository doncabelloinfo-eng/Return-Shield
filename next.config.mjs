import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  experimental: { serverActions: { bodySizeLimit: '10mb' } },

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
