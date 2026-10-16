import Link from 'next/link';
import { requireScanner } from '@/lib/auth/guard';
import { loadDemoClock } from '@/lib/demo-clock';
import { now } from '@/lib/clock';
import { fmt } from '@/lib/time';
import { openBatches } from '@/lib/scan/batches';
import { DIRECTION_LABEL, DIRECTION_NOTE, SCAN_DIRECTIONS, type ScanDirection } from '@/lib/scan/model';
import { BarcodeStripe, ChevronRight, IncomingIcon, OutgoingIcon } from '@/components/scan/icons';

// Per-request, behind a login or a signed token, and it reads the database.
// Saying so explicitly keeps it out of the build's static render pass, which
// is what would otherwise make every build need a live production database.
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * "What are you scanning?" — image 2, and the Scanner's front door.
 *
 * It is `/scan` because that is the installed app's `start_url`: a phone that
 * opens Scanner from its home screen lands here, and `requireScanner` sends it
 * to /scan/login if the session has gone — a URL inside the app's own scope, so
 * the installed app never drops into a browser tab to sign in.
 *
 * ONE QUERY. The panel's layout runs four around every screen; this runs one,
 * for the open batches, and it earns its place twice over: it puts "carry on"
 * on the card of a pile already started, and it is what makes switching
 * direction with scans in the other pile ask for that pile to be completed
 * first rather than quietly starting a second one.
 */
export default async function ScanModePage() {
  const user = await requireScanner();
  await loadDemoClock();

  const open = await openBatches(user.id);
  const f = fmt(now());

  return (
    <main className="flex min-h-[100dvh] flex-col bg-ground">
      <header className="flex h-14 flex-none items-center justify-between bg-navy px-4 text-white">
        <div className="flex items-center gap-[10px]">
          <span className="h-3 w-3 flex-none rounded-[2px] bg-accent" />
          <span className="text-[18px] font-bold">Scanner</span>
        </div>
        {/*
          A form, not a link: signing out is a change, and a GET that signs
          somebody out is a GET a link prefetcher can fire by itself.
        */}
        <form action="/api/logout" method="post">
          <button
            type="submit"
            className="flex h-9 items-center rounded-[8px] border border-navy2 px-3 text-[14px] font-semibold text-white"
          >
            Sign out
          </button>
        </form>
      </header>

      <div className="flex min-h-0 flex-1 flex-col gap-5 px-4 pb-6 pt-[22px]">
        <div className="flex flex-col gap-[10px]">
          <span className="self-start rounded-[6px] border border-line bg-surface px-2 py-1 font-mono text-[13px] text-ink">
            {f.day} {f.date} · {f.time}
          </span>
          <h1 className="m-0 text-[28px] font-semibold leading-[1.15] tracking-[-.015em] text-ink">
            What are you scanning?
          </h1>
          <span className="text-[13px] text-muted">Signed in as {user.name}</span>
        </div>

        <div className="flex flex-col gap-3">
          {SCAN_DIRECTIONS.map((direction) => (
            <DirectionCard
              key={direction}
              direction={direction}
              mine={open.find((b) => b.direction === direction) ?? null}
              other={open.find((b) => b.direction !== direction && b.scans > 0) ?? null}
            />
          ))}
        </div>

        <HowItWorks />
      </div>
    </main>
  );
}

interface OpenLine {
  direction: ScanDirection;
  scans: number;
}

/**
 * One direction, in one of two states.
 *
 * The blocked state is the operator's rule about switching direction, and it is
 * a card rather than a dialog: there are no browser `confirm()` boxes anywhere
 * in this app, and a warehouse needs to be able to read why it cannot go that
 * way while it is still holding the parcel. The way out is on the card.
 */
function DirectionCard({
  direction,
  mine,
  other,
}: {
  direction: ScanDirection;
  mine: OpenLine | null;
  other: OpenLine | null;
}) {
  const outgoing = direction === 'outgoing';
  const edge = outgoing ? 'var(--navy)' : 'var(--crit)';
  const Icon = outgoing ? OutgoingIcon : IncomingIcon;
  const blocked = other !== null && (mine === null || mine.scans === 0);

  const tile = (
    <span
      className="grid h-[52px] w-[52px] flex-none place-items-center rounded-[12px] text-white"
      style={{ background: edge }}
    >
      <Icon />
    </span>
  );

  const title = (
    <span className="flex min-w-0 flex-1 flex-col gap-[3px]">
      <span className="text-[21px] font-semibold text-ink">{DIRECTION_LABEL[direction]}</span>
      <span className="text-[14px] leading-[1.4] text-muted">{DIRECTION_NOTE[direction]}</span>
      {mine && mine.scans > 0 && (
        <span className="text-[13px] font-semibold text-good">
          Carry on · {mine.scans} scanned
        </span>
      )}
    </span>
  );

  if (blocked) {
    return (
      <div
        className="rounded-[12px] border border-line bg-surface p-4 shadow-[0_1px_2px_rgba(16,32,61,.06)]"
        style={{ borderLeft: `5px solid ${edge}` }}
      >
        <div className="flex items-center gap-[14px]">
          {tile}
          {title}
        </div>
        <div className="mt-3 rounded-[10px] border border-warn bg-warnsoft px-[14px] py-3">
          <div className="text-[13.5px] font-semibold leading-[1.45] text-warn">
            Complete the {DIRECTION_LABEL[other.direction].toLowerCase()} batch first.
          </div>
          <div className="mt-[3px] text-[13px] leading-[1.45] text-muted">
            {other.scans} {other.scans === 1 ? 'parcel is' : 'parcels are'} waiting in it. One pile
            at a time, so nothing ends up in the wrong one.
          </div>
          <Link
            href={`/scan/${other.direction}`}
            className="mt-[10px] flex h-11 items-center justify-center rounded-[10px] bg-navy text-[15px] font-semibold text-white"
          >
            Go to the {DIRECTION_LABEL[other.direction].toLowerCase()} batch
          </Link>
        </div>
      </div>
    );
  }

  return (
    <Link
      href={`/scan/${direction}`}
      className="flex items-center gap-[14px] rounded-[12px] border border-line bg-surface p-4 shadow-[0_1px_2px_rgba(16,32,61,.06)]"
      style={{ borderLeft: `5px solid ${edge}` }}
    >
      {tile}
      {title}
      <span className="flex-none text-muted"><ChevronRight /></span>
    </Link>
  );
}

/** The three steps from image 2. The only instructions the warehouse gets. */
function HowItWorks() {
  const steps = [
    <>Fill the box on screen with the barcode under <b>Código de Bulto</b>.</>,
    <><b>Beep</b> means it is saved. The next scan starts by itself.</>,
    <>When the pile is done, tap <b>Complete batch</b>.</>,
  ];

  return (
    <section className="flex flex-col gap-[10px]">
      <span className="text-[11px] font-semibold uppercase tracking-[.09em] text-ink">
        How scanning works
      </span>
      <div className="flex flex-col gap-[14px] rounded-[12px] border border-line bg-surface p-4">
        <div
          aria-hidden="true"
          className="flex flex-col gap-[7px] rounded-[8px] border border-line bg-surface2 px-[14px] py-3"
        >
          <div className="flex flex-col gap-[5px]">
            <span className="h-[6px] w-[62%] rounded-[3px] bg-line" />
            <span className="h-[6px] w-[44%] rounded-[3px] bg-line" />
          </div>
          <span className="text-[11px] text-ink">Código de Bulto: PKA6TP9800101520108320G</span>
          <div className="rounded-[6px] border-2 border-good p-[5px]">
            <BarcodeStripe className="h-[34px]" />
          </div>
          <span className="text-[12px] font-semibold text-good">Scan this barcode</span>
        </div>
        <ol className="m-0 flex list-none flex-col gap-[10px] p-0">
          {steps.map((step, i) => (
            // eslint-disable-next-line react/no-array-index-key
            <li key={i} className="flex items-start gap-3">
              <span className="grid h-6 w-6 flex-none place-items-center rounded-full bg-navy text-[12px] font-semibold text-white">
                {i + 1}
              </span>
              <span className="text-[14px] leading-[1.45] text-ink">{step}</span>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
