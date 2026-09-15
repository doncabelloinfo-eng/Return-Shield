import { officeView } from '@/lib/views/rows';
import { getDb } from '@/db';
import { productRules, stores } from '@/db/schema';
import { ParcelTable } from '@/components/ParcelTable';
import { OfficeFilters } from '@/components/OfficeFilters';
import { PageHeading, Empty } from '@/components/ui';

// Per-request, behind a login or a signed token, and it reads the database.
// Saying so explicitly keeps it out of the build's static render pass, which
// is what would otherwise make every build need a live production database.
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
/**
 * Every parcel a post office is holding, most urgent first. One decided next
 * step per row; everything else is behind the ⋯.
 */
export default async function OfficePage({
  searchParams,
}: {
  searchParams: { q?: string; store?: string; pay?: string; urg?: string };
}) {
  const [rows, storeRows, rules] = await Promise.all([
    officeView(),
    getDb().select({ name: stores.name }).from(stores),
    getDb().select().from(productRules),
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

    const d = r.daysLeftNumber;
    if (urg === '0–3' && !(d !== null && d <= 3)) return false;
    if (urg === '4–7' && !(d !== null && d >= 4 && d <= 7)) return false;
    if (urg === '8+' && !(d !== null && d >= 8)) return false;
    return true;
  });

  const standard = rules.find((r) => r.productCode === 'PAQ ESTÁNDAR')?.depositDays
    ?? rules[0]?.depositDays ?? 15;

  return (
    <div className="px-4 pb-10 pt-[18px]">
      <div className="flex flex-wrap items-end gap-[14px]">
        <PageHeading
          title="Post office"
          note={`${rows.length} waiting · Correos sends them back when the countdown hits zero · they wait ${standard} days`}
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
