import Link from 'next/link';
import type { ParcelListRow } from '@/lib/views/parcels';
import { marketplaceOrderLink, marketplaceName } from '@/lib/orders/marketplace-link';
import { CopyButton } from './CopyButton';
import { AlertBadge, Empty, PayBadge, Th } from './ui';

/**
 * The parcels to ring about today: Correos tried, nobody took it, and it is
 * now sitting at a post office, and every day it sits there is a day closer to
 * Correos sending it back.
 *
 * Every row carries everything needed to contact the customer without opening
 * the parcel — the phone, the WhatsApp link with the finished Spanish text,
 * the email, the office and its address, how long it has been waiting and the
 * attempts. That
 * is the point of the tab: it is a worklist, and a worklist that needs a click
 * per row to become useful is a list of links.
 *
 * The buttons are the parcel page's, not new ones. `officeDetails` builds the
 * text in one place, so the message the operator copies here is the same
 * message to the character.
 */
export function ContactTable({ rows }: { rows: ParcelListRow[] }) {
  if (!rows.length) {
    return (
      <div className="rounded-[5px] border border-line bg-surface">
        <Empty good>
          Nobody is waiting at a post office after a missed delivery. Parcels sent straight to
          an office are under &ldquo;Waiting at the post office&rdquo;.
        </Empty>
      </div>
    );
  }

  const button = 'rounded border border-line bg-surface2 px-[10px] py-[7px] text-[11.5px] font-semibold text-ink';

  return (
    <div className="overflow-x-auto rounded-[5px] border border-line bg-surface">
      <table className="w-full border-collapse">
        <thead>
          <tr>
            <Th>Customer</Th>
            <Th>Phone</Th>
            <Th>Office</Th>
            <Th>At the office</Th>
            <Th align="right">Value</Th>
            <Th>Get in touch</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const link = marketplaceOrderLink(r.storePlatform, r.orderNumber);
            const noContact = !r.phoneE164 && !r.email;

            return (
              <tr key={r.id} className="align-top hover:bg-hover">
                <td className="border-b border-line px-3 py-[10px]">
                  <Link href={`/parcel/${r.id}`} className="text-[13px] font-semibold text-ink underline-offset-2 hover:underline">
                    {r.customerName}
                  </Link>
                  <div className="text-[12px] text-muted">
                    {r.orderNumber} · {r.storeName}
                  </div>
                  <div className="font-mono text-[11px] text-muted">{r.shippingCode}</div>
                  <div className="mt-[4px] flex flex-wrap gap-[4px]">
                    <AlertBadge>
                      {r.attempts > 0
                        ? `${r.attempts} delivery ${r.attempts === 1 ? 'attempt' : 'attempts'}`
                        : 'Delivery attempted'}
                    </AlertBadge>
                    {r.badges.map((b) => <AlertBadge key={b}>{b}</AlertBadge>)}
                  </div>
                </td>

                <td className="whitespace-nowrap border-b border-line px-3 py-[10px] text-[12.5px]">
                  {r.phoneE164
                    ? <a href={`tel:${r.phoneE164}`} className="font-mono font-semibold text-ink">{r.phoneDisplay}</a>
                    : <span className="text-muted">no phone</span>}
                  {r.email && <div className="mt-[2px] break-all font-mono text-[11px] text-muted">{r.email}</div>}
                </td>

                {/*
                  Nothing at all when Correos named no office, rather than
                  "not said yet" on every row plus a maps link that searches
                  for an empty string. Today's events carry no office details,
                  so that was every row.
                */}
                <td className="border-b border-line px-3 py-[10px] text-[12.5px]">
                  {r.officeName && (
                    <>
                      <div className="font-medium text-ink">{r.officeName}</div>
                      {r.officeAddress && <div className="text-[11.5px] text-muted">{r.officeAddress}</div>}
                      <a href={r.mapsHref} target="_blank" rel="noreferrer"
                        className="mt-[3px] inline-block text-[11.5px] font-semibold text-navy underline-offset-2 hover:underline">
                        Open in maps
                      </a>
                    </>
                  )}
                </td>

                {/*
                  Since when, and how long — not a last day. Correos' at-the-
                  office event carries no date beyond its own, so the last day
                  this column used to show was arithmetic on a guess.
                */}
                <td className="whitespace-nowrap border-b border-line px-3 py-[10px] text-[12.5px]">
                  {r.atOffice
                    ? (
                      <>
                        <div className="text-ink" title={r.atOffice.sinceExact}>
                          since {r.atOffice.since}
                        </div>
                        <div className={`text-[11.5px] font-semibold ${r.atOffice.late ? 'text-crit' : 'text-muted'}`}>
                          {r.atOffice.days} {r.atOffice.days === 1 ? 'day' : 'days'} at the office
                        </div>
                      </>
                    )
                    : <span className="text-muted">—</span>}
                </td>

                <td className="whitespace-nowrap border-b border-line px-3 py-[10px] text-right">
                  <div className="text-[13px] font-semibold text-ink tabular-nums">{r.valueText}</div>
                  <PayBadge method={r.paymentMethod} />
                </td>

                <td className="border-b border-line px-3 py-[10px]">
                  <div className="flex flex-wrap gap-[5px]">
                    {/* Always available, and the only thing that works for a
                        parcel with no phone and no email. */}
                    <CopyButton text={r.messageText} said="Message copied — paste it to the customer." className={button}>
                      Copy message
                    </CopyButton>

                    {r.waHref && (
                      <a href={r.waHref} target="_blank" rel="noreferrer"
                        className="rounded border border-good bg-goodsoft px-[10px] py-[7px] text-[11.5px] font-semibold text-good">
                        WhatsApp
                      </a>
                    )}

                    {r.emailHref && (
                      <a href={r.emailHref}
                        className="rounded border border-navy px-[10px] py-[7px] text-[11.5px] font-semibold text-navy">
                        Email
                      </a>
                    )}

                    {/*
                      No phone and no email: every Amazon and TikTok parcel from
                      a tracking file. The customer is reachable through the
                      marketplace's own chat, so the row links straight there —
                      and when that URL has not been configured, the order
                      number is the next best thing, because the operator can
                      paste it into seller central themselves.
                    */}
                    {noContact && link && (
                      <a href={link} target="_blank" rel="noreferrer"
                        className="rounded border border-navy px-[10px] py-[7px] text-[11.5px] font-semibold text-navy">
                        Open in {marketplaceName(r.storePlatform)}
                      </a>
                    )}

                    {noContact && !link && (
                      <CopyButton text={r.orderNumber} said={`Order ${r.orderNumber} copied.`} className={button}>
                        Copy order number
                      </CopyButton>
                    )}

                    {/*
                      The same thing for the Shopify rows, built from the shop
                      domain and the numeric order id rather than a configured
                      template — the admin lives at one address for every shop.
                      Shown whether or not there is a phone: the reason to open
                      the order is the address and the line items, not contact.
                    */}
                    {r.shopifyHref && (
                      <a href={r.shopifyHref} target="_blank" rel="noreferrer" className={button}>
                        Open in Shopify
                      </a>
                    )}
                  </div>

                  {noContact && (
                    <div className="mt-[5px] max-w-[230px] text-[11px] leading-[1.45] text-muted">
                      This file carried no phone or email. Message them inside{' '}
                      {marketplaceName(r.storePlatform)}.
                    </div>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
