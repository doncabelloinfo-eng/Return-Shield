import { resolveToken, markLinkOpened } from '@/lib/customer-page';
import { CustomerActions } from '@/components/CustomerActions';

// Per-request, behind a login or a signed token, and it reads the database.
// Saying so explicitly keeps it out of the build's static render pass, which
// is what would otherwise make every build need a live production database.
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
/**
 * The customer's own page. No login: the signed token in the URL is the
 * credential, and it carries no personal data of its own.
 *
 * Everything here is in Spanish and in the customer's palette, not the
 * operator's — it is the only screen in the system a customer ever sees, and
 * it has one job: make it obvious what to do about the parcel.
 */
export default async function CustomerPage({
  params,
}: { params: { token: string } }) {
  const result = await resolveToken(params.token);

  if (!result.ok) {
    return <Closed why={result.why} />;
  }

  const v = result.view;
  await markLinkOpened(v.notificationId);

  return (
    <main className="min-h-screen bg-[#F4F6F9] px-4 py-8 text-[#111826]">
      <div className="mx-auto w-full max-w-[440px] overflow-hidden rounded-xl border border-[#D9E0EA] bg-white shadow-[0_8px_30px_rgba(16,32,61,.10)]">
        <div className="flex items-center gap-[9px] bg-[#10203D] px-4 py-3 text-white">
          <span className="h-2 w-2 rounded-[2px] bg-[#F2B705]" />
          <span className="text-[13px] font-semibold">{v.storeName}</span>
        </div>

        <div className="px-5 py-5">
          <div className="text-[10px] font-semibold uppercase tracking-[.08em] text-[#5A6478]">
            Tu pedido {v.orderNumber}
          </div>
          <h1 className="mt-[6px] text-[19px] font-bold leading-tight">{v.stateEs}</h1>

          <div className="mt-3 flex items-baseline gap-[9px]">
            <span
              className="text-[52px] font-extrabold leading-[.9] [font-variant-numeric:tabular-nums]"
              style={{
                color: v.daysLeft === null ? '#111826'
                  : v.daysLeft <= 3 ? '#B3261E' : v.daysLeft <= 7 ? '#C2410C' : '#111826',
              }}
            >
              {v.state === 'at_office' && v.daysLeft !== null ? Math.max(0, v.daysLeft) : '!'}
            </span>
            <span className="text-[11.5px] font-medium leading-[1.4] text-[#5A6478]">
              {v.state === 'at_office'
                ? 'días para recogerlo antes de que vuelva a origen'
                : 'necesitamos que nos digas qué hacer'}
            </span>
          </div>

          {v.officeName && (
            <div className="mt-4 rounded-md border border-[#D9E0EA] bg-[#F7F9FC] px-4 py-3 text-[12.5px] leading-[1.6]">
              <strong>{v.officeName}</strong>
              {v.officeAddress && <><br />{v.officeAddress}</>}
              {v.officeHours && <><br />{v.officeHours}</>}
              <br />
              Código: <span className="font-mono">{v.shippingCode}</span>
              <br />
              <a
                className="mt-2 inline-block font-semibold text-[#10203D] underline"
                href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${v.officeName}, ${v.officeAddress ?? ''}`)}`}
                target="_blank"
                rel="noreferrer"
              >
                Ver en el mapa
              </a>
            </div>
          )}

          <CustomerActions token={params.token} firstName={v.firstName} storeName={v.storeName} />
        </div>
      </div>

      <p className="mx-auto mt-4 max-w-[440px] text-center text-[11px] leading-[1.5] text-[#5A6478]">
        Este enlace es solo para tu pedido y caduca cuando lo recibas.
      </p>
    </main>
  );
}

function Closed({ why }: { why: 'invalid' | 'expired' | 'finished' | 'unknown' }) {
  const text = why === 'finished'
    ? '¡Ya lo tienes! Este pedido está entregado, así que este enlace ya no hace falta.'
    : why === 'expired'
      ? 'Este enlace ha caducado. Si aún necesitas ayuda con tu pedido, responde al mensaje original de la tienda.'
      : 'Este enlace no es válido. Comprueba que lo has copiado entero.';

  return (
    <main className="flex min-h-screen items-center justify-center bg-[#F4F6F9] px-4 text-[#111826]">
      <div className="w-full max-w-[420px] rounded-xl border border-[#D9E0EA] bg-white px-6 py-8 text-center">
        <div className="text-[15px] font-semibold">{why === 'finished' ? 'Todo listo' : 'Enlace no disponible'}</div>
        <p className="mt-2 text-[13px] leading-[1.6] text-[#5A6478]">{text}</p>
      </div>
    </main>
  );
}
