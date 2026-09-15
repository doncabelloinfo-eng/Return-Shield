'use server';

import { revalidatePath } from 'next/cache';
import { and, eq, inArray } from 'drizzle-orm';
import { getDb } from '@/db';
import { shipments, stores } from '@/db/schema';
import { requireUser } from '@/lib/auth/guard';
import { buildPreview, parseFile, type PreviewRow } from '@/lib/import/parse';
import { commitImport } from '@/lib/import/commit';

/**
 * Upload, look, confirm. Two steps, and the first one writes nothing.
 */

export interface PreviewResult {
  ok: boolean;
  error?: string;
  filename?: string;
  sizeLabel?: string;
  rows?: PreviewRow[];
  summary?: { total: number; new: number; duplicate: number; needsYou: number; autofixed: number };
  missingColumns?: string[];
}

export async function previewUpload(form: FormData): Promise<PreviewResult> {
  await requireUser();

  const file = form.get('file');
  if (!(file instanceof File) || file.size === 0) {
    return { ok: false, error: 'Pick a CSV or XLSX file first.' };
  }
  if (!/\.(csv|xlsx?|tsv)$/i.test(file.name)) {
    return { ok: false, error: `${file.name} is not a CSV or XLSX file.` };
  }
  if (file.size > 10 * 1024 * 1024) {
    return { ok: false, error: 'That file is over 10 MB. Split it and upload the parts.' };
  }

  const bytes = Buffer.from(await file.arrayBuffer());

  let parsed;
  try {
    parsed = await parseFile(file.name, bytes);
  } catch (err) {
    return {
      ok: false,
      error: `Could not read ${file.name}: ${err instanceof Error ? err.message : 'unreadable'}`,
    };
  }

  if (parsed.missingColumns.length) {
    return {
      ok: false,
      filename: file.name,
      missingColumns: parsed.missingColumns,
      error: `That file has no ${parsed.missingColumns.join(', ')} column`
        + `${parsed.missingColumns.length > 1 ? 's' : ''}. Nothing was added.`,
    };
  }

  // Dedupe against what we already have, so the same file can be dropped twice.
  const codes = parsed.rows
    .map((r) => (r.shipping_code ?? '').trim().toUpperCase())
    .filter(Boolean);

  const known = codes.length
    ? new Set((await getDb().select({ code: shipments.shippingCode }).from(shipments)
        .where(inArray(shipments.shippingCode, codes))).map((r) => r.code))
    : new Set<string>();

  const { rows, summary } = buildPreview(parsed.rows, known);

  return {
    ok: true,
    filename: file.name,
    sizeLabel: `${Math.max(1, Math.round(file.size / 1024))} KB`,
    rows,
    summary,
  };
}

export async function confirmUpload(
  filename: string,
  rows: PreviewRow[],
  fixes: Record<number, string>,
): Promise<{ created: number; fixed: number }> {
  const user = await requireUser();

  // The TikTok store is created on first use rather than needing setup first.
  const [store] = await getDb().insert(stores).values({
    key: 'tiktok-es',
    name: 'TikTok Shop ES',
    platform: 'tiktok',
    ingest: 'manual',
  }).onConflictDoUpdate({ target: stores.key, set: { active: true } })
    .returning({ key: stores.key });

  const result = await commitImport({
    storeKey: store.key,
    filename,
    userId: user.id,
    rows: rows.map((r) => ({ ...r, shippedAt: r.shippedAt ? new Date(r.shippedAt) : null })),
    fixes,
  });

  revalidatePath('/', 'layout');
  return { created: result.created, fixed: result.fixed };
}
