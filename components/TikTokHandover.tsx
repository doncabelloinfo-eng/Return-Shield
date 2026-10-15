'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { moveTikTokOrders, previewTikTokOrders } from '@/app/actions/shopify';
// Type-only, so the import is erased and none of that module reaches the
// client bundle. See the note in app/actions/shopify.ts for why they are not
// re-exported from there.
import type { HandoverPreview, HandoverResult } from '@/lib/orders/tiktok-handover';

/**
 * "Give the TikTok orders back to TikTok Shop ES."
 *
 * The TikTok sales channel is installed on the Shopify store, so every TikTok
 * Shop order was also a Shopify order — and the webhook took it at fulfilment,
 * before the TikTok upload saw it. Those parcels ended up under the Shopify
 * shop with a #22xxx Shopify order number, invisible to the TikTok Shop filter
 * the team actually works from.
 *
 * Two presses, on purpose. The first writes nothing and says what would
 * happen; the second does it. A one-press button that moved 81 parcels would
 * be the only button on this screen that could not be examined first.
 */
export function TikTokHandover() {
  const [preview, setPreview] = useState<HandoverPreview | null>(null);
  const [result, setResult] = useState<HandoverResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const router = useRouter();

  function check(): void {
    setError(null);
    setResult(null);
    start(async () => {
      const answer = await previewTikTokOrders();
      if (!answer.ok || !answer.preview) {
        setError(answer.error ?? 'Could not read the orders.');
        return;
      }
      setPreview(answer.preview);
    });
  }

  function move(): void {
    setError(null);
    start(async () => {
      const answer = await moveTikTokOrders();
      if (!answer.ok || !answer.result) {
        setError(answer.error ?? 'The move did not finish.');
        return;
      }
      setResult(answer.result);
      setPreview(answer.result);
      router.refresh();
    });
  }

  const nothingToDo = preview !== null && preview.tiktokOrders === 0;

  return (
    <div className="border-b border-line px-[14px] py-[11px]">
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-[12.5px] font-semibold text-ink">TikTok orders pulled from Shopify</span>

        <button
          type="button"
          onClick={check}
          disabled={pending}
          className="rounded border border-line px-[11px] py-[7px] text-[12px] font-semibold text-ink disabled:opacity-50"
        >
          {pending && !preview ? 'Looking…' : 'Check what would move'}
        </button>

        {preview && !nothingToDo && !result && (
          <button
            type="button"
            onClick={move}
            disabled={pending}
            className="rounded border border-navy px-[11px] py-[7px] text-[12px] font-semibold text-navy disabled:opacity-50"
          >
            {pending ? 'Moving…' : `Move ${preview.parcelsToMove} to TikTok Shop ES`}
          </button>
        )}

        {result && <span className="text-[12px] font-semibold text-good">Done</span>}
      </div>

      {preview && !result && (
        <ul className="mt-[7px] list-inside list-disc text-[12px] leading-[1.55] text-muted">
          <li>{`TikTok orders pulled from Shopify: ${preview.tiktokOrders}`}</li>
          <li>{`Parcels to move to TikTok Shop ES: ${preview.parcelsToMove}`}</li>
          <li>{`Empty Shopify rows to remove: ${preview.emptyRows}`}</li>
          {preview.parcelsLosingContact > 0 && (
            <li>
              {`${preview.parcelsLosingContact} will lose the Shopify name, phone and address — `}
              TikTok&rsquo;s own files carry none either, so the parcel keeps its tracking and
              its history but not its contact details. This cannot be undone.
            </li>
          )}
          {preview.unreadableTags > 0 && (
            <li>{`${preview.unreadableTags} with a tag nobody can read an id out of — left alone`}</li>
          )}
          {nothingToDo && <li>Nothing to move. This has already been done.</li>}
        </ul>
      )}

      {result && (
        <ul className="mt-[7px] list-inside list-disc text-[12px] leading-[1.55] text-muted">
          <li>{`${result.moved} ${result.moved === 1 ? 'parcel' : 'parcels'} moved to TikTok Shop ES`}</li>
          <li>{`${result.ordersRemoved} Shopify order ${result.ordersRemoved === 1 ? 'row' : 'rows'} removed`}</li>
          <li>{`${result.tiktokOrdersCreated} TikTok ${result.tiktokOrdersCreated === 1 ? 'order' : 'orders'} created`}</li>
        </ul>
      )}

      {error && <div className="mt-[7px] text-[12px] font-semibold text-crit">{error}</div>}

      {!preview && !result && (
        <div className="mt-[6px] max-w-[560px] text-[11.5px] leading-[1.5] text-muted">
          Every TikTok Shop order is also a Shopify order, and until now the webhook took it
          first — so the parcel sat under the Shopify shop with a Shopify order number, where
          the TikTok Shop filter could not see it. This hands each one back: the parcel keeps
          its id, its events and its whole history, and the empty Shopify row goes. Online
          Store and Draft Orders are not touched.
        </div>
      )}
    </div>
  );
}
