import { notFound, redirect } from 'next/navigation';
import { requireScanner } from '@/lib/auth/guard';
import { loadDemoClock } from '@/lib/demo-clock';
import { currentBatch, openBatches } from '@/lib/scan/batches';
import { isScanDirection } from '@/lib/scan/model';
import { ScannerApp } from '@/components/scan/ScannerApp';

// Per-request, behind a login or a signed token, and it reads the database.
// Saying so explicitly keeps it out of the build's static render pass, which
// is what would otherwise make every build need a live production database.
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * The scanning screen. Images 3 to 9 all live inside the component below.
 *
 * TWO QUERIES, AND NO WRITES. The open batch is read so the pile resumes, and
 * the open batches are read so the one-pile-at-a-time rule holds however
 * somebody got here — a typed URL as much as a tap on the previous screen.
 *
 * Nothing is created on this GET. Next prefetches links, and a GET that opened
 * a batch would leave empty batches behind every time a thumb passed over the
 * card. The phone opens its batch with a POST, on its own, once it is running.
 */
export default async function ScanDirectionPage({
  params,
}: {
  params: { direction: string };
}) {
  if (!isScanDirection(params.direction)) notFound();
  const direction = params.direction;

  const user = await requireScanner();
  await loadDemoClock();

  const [batch, open] = await Promise.all([
    currentBatch(user.id, direction),
    openBatches(user.id),
  ]);

  /*
   * One pile at a time, by the operator's rule.
   *
   * Enforced here as well as on the chooser because the chooser is only one way
   * in: an installed app resumes on whatever URL it was last on, and a phone
   * that was scanning outgoing yesterday must not be able to land straight on
   * incoming with thirteen outgoing parcels still waiting. /scan says which
   * batch to finish and offers the way to it.
   */
  const other = open.find((b) => b.direction !== direction && b.scans > 0);
  if (other && (batch === null || batch.items.length === 0)) redirect('/scan');

  return (
    <ScannerApp
      direction={direction}
      worker={user.name}
      initialBatch={batch}
    />
  );
}
