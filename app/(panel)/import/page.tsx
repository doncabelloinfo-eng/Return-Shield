import { desc } from 'drizzle-orm';
import { getDb } from '@/db';
import { importBatches } from '@/db/schema';
import { fmt } from '@/lib/time';
import { ImportScreen } from '@/components/ImportScreen';
import { PageHeading } from '@/components/ui';

// Per-request, behind a login or a signed token, and it reads the database.
// Saying so explicitly keeps it out of the build's static render pass, which
// is what would otherwise make every build need a live production database.
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
/**
 * Shopify orders come in on their own. TikTok and Amazon orders are a file.
 *
 * The file says which marketplace each row is from — both export the same
 * eight columns, so it is worked out from the order number rather than from
 * the file name, which people rename.
 */
export default async function ImportPage() {
  const batches = await getDb().select().from(importBatches)
    .orderBy(desc(importBatches.createdAt)).limit(10);

  return (
    <div className="px-4 pb-10 pt-[18px]">
      <PageHeading
        title="Upload orders"
        note={
          <span className="block max-w-[700px]">
            TikTok · Amazon. Shopify orders come in on their own; these are a file. Each row
            says which marketplace it is from, worked out from the order number, so one file
            can hold both. Phone numbers in a full export get cleaned up automatically — only
            the ones nobody can guess are left for you.
          </span>
        }
      />

      <ImportScreen />

      <div className="mt-6">
        <h3 className="m-0 mb-[9px] font-display text-[12.5px] font-bold text-ink">Earlier uploads</h3>
        <div className="rounded-[5px] border border-line bg-surface">
          {batches.length === 0 && (
            <div className="px-[14px] py-[14px] text-[12.5px] text-muted">Nothing uploaded yet.</div>
          )}
          {batches.map((b) => (
            <div key={b.id} className="flex flex-wrap items-center gap-4 border-b border-line px-[14px] py-[10px]">
              <span className="min-w-[280px] font-mono text-[12px] text-ink">{b.filename}</span>
              <span className="min-w-[100px] font-mono text-[12px] text-muted">
                {fmt(b.createdAt).date} · {fmt(b.createdAt).time}
              </span>
              <span className="text-[12.5px] text-muted">
                {b.rowsTotal} rows · {b.rowsNew} new · {b.rowsAutofixed} numbers fixed
                {b.rowsError ? ` · ${b.rowsError} left for you` : ''}
              </span>
              <span className={`ml-auto text-[12px] font-semibold ${b.committedAt ? 'text-good' : 'text-muted'}`}>
                {b.committedAt ? 'Added' : 'Cancelled'}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
