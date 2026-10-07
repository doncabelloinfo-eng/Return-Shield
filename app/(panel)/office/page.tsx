import { officeView } from '@/lib/views/rows';
import { getDb } from '@/db';
import { stores } from '@/db/schema';
import { ParcelTable } from '@/components/ParcelTable';
import { OfficeFilters } from '@/components/OfficeFilters';
import { PageHeading, Empty } from '@/components/ui';

// Per-request, behind a login or a signed token, and it reads the database.
// Saying so explicitly keeps it out of the build's static render pass, which
// is what would otherwise make every build need a live production database.
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
/**
 * Every parcel a post office is holding, longest-waiting first. One decided
 * next step per row; everything else is behind the ⋯.
 *
 * "Most urgent" used to mean fewest days left, counted against a deposit
 * window an operator typed in and nobody had confirmed. It now means longest
 * at the office, counted from the day Correos said the parcel got there — the
 * same ordering in practice, resting on a fact instead of a guess.
 */
export default async function OfficePage({
  searchParams,
}: {
  searchParams: { q?: string; store?: string; pay?: string; urg?: string };
}) {
  const [rows, storeRows] = await Promise.all([
    officeView(),
    getDb().select({ name: stores.name }).from(stores),
  ]);

  const q = (searchParams.q ?? '').trim().toLowerCase();
  const store = searchParams.store ?? 'All shops';
  const pay = searchParams.pay ?? 'Any payment';
  const urg = searchParams.urg ?? 'All';

  const filtered = rows.filter((r) => {
    if (q && ![r.customerName, r.orderNumber, r.shippingCode, r.town, r.officeName ?? '']
      .join(' ').toLowerCase().includes(q)) return false;
    if (store !== 'All shops' && r.storeName !== store) return false;
    if (pay !== 'Any payment' && (pay === 'COD' ? r.paymentMethod !== 'cod' : r.paymentMethod !== 'prepaid')) return false;

    // Days AT the office, not days left: the same three buckets, read off the
    // day Correos said the parcel arrived rather than off a last day nobody
    // ever confirmed with them.
    const d = r.daysAtOffice;
    if (urg === '0–3' && !(d !== null && d <= 3)) return false;
    if (urg === '4–7' && !(d !== null && d >= 4 && d <= 7)) return false;
    if (urg === '8+' && !(d !== null && d >= 8)) return false;
    return true;
  });

  return (
    <div className="px-4 pb-10 pt-[18px]">
      <div className="flex flex-wrap items-end gap-[14px]">
        <PageHeading
          title="Post office"
          note={`${rows.length} waiting · longest at the office first · Correos sends one back when its collection window runs out, and tells us when they do`}
        />
        <OfficeFilters
          stores={['All shops', ...storeRows.map((s) => s.name)]}
          current={{ q: searchParams.q ?? '', store, pay, urg }}
        />
      </div>

      <div className="mt-[14px]">
        <ParcelTable
          rows={filtered}
          showOffice
          empty={<Empty good>Nothing waiting at the post office right now.</Empty>}
        />
      </div>
    </div>
  );
}
