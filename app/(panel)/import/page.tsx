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
 * Shopify orders come in on their own. TikTok orders are a file.
 *
 * Phone numbers get cleaned up here automatically — only the ones nobody can
 * guess are left for a person, with a box right there to fix them.
 */
export default async function ImportPage() {
  const batches = await getDb().select().from(importBatches)
    .orderBy(desc(importBatches.createdAt)).limit(10);

  return (
    <div className="px-4 pb-10 pt-[18px]">
      <PageHeading
        title="Add TikTok orders"
        note={
          <span className="block max-w-[700px]">
            Shopify orders come in on their own. TikTok orders are a file. Phone numbers get
            cleaned up here automatically — only the ones nobody can guess are left for you.
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
