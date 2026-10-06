import { envOr } from '@/lib/env';

/**
 * Which Shopify Admin API version we call.
 *
 * Shopify releases quarterly and supports each version for a year. Past that
 * it does not fail the request — it silently serves the oldest version it
 * still supports. So a stale version here is not an error anywhere; it is a
 * slow drift onto whatever Shopify has decided the floor is this quarter,
 * with field names and behaviour changing underneath us and nothing in any log
 * to say so. This app was pinned to `2024-10` for exactly that long.
 *
 * Hence one constant, in one place, and a date in the deploy docs to review it.
 */
export const SHOPIFY_API_VERSION_DEFAULT = '2026-10';

/**
 * The version to call, overridable with `SHOPIFY_API_VERSION`.
 *
 * A function rather than a module-level `const` deliberately. Next evaluates
 * every module during the build, so a const would freeze whatever the build
 * machine had and setting `SHOPIFY_API_VERSION` in Vercel would do nothing
 * until the next deploy — which is the opposite of what an override is for.
 *
 * Read through `envOr`, so a variable added with an empty value falls back to
 * the default rather than producing `/admin/api//orders.json`.
 */
export function shopifyApiVersion(): string {
  return envOr('SHOPIFY_API_VERSION', SHOPIFY_API_VERSION_DEFAULT);
}

/**
 * An Admin API URL for one store.
 *
 * Here so the version cannot be spelled out at a second call site later: the
 * bug being fixed was a version written inline, and a second inline copy is
 * how it comes back.
 */
export function adminApiUrl(
  shopDomain: string,
  path: string,
  params: Record<string, string> = {},
): string {
  const query = new URLSearchParams(params).toString();
  const base = `https://${shopDomain}/admin/api/${shopifyApiVersion()}/${path.replace(/^\//, '')}`;
  return query ? `${base}?${query}` : base;
}
