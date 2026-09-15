import 'dotenv/config';
import { getSql, getDb, closeDb } from './index';
import { offices, orders, productRules, shipments, stores, users } from './schema';
import { hashPassword } from '@/lib/auth/password';
import { ingestEvent } from '@/lib/shipments/ingest';
import { runTick } from '@/lib/escalation/run';
import { liveShipmentIds } from '@/lib/shipments/repo';
import { setSetting } from '@/lib/settings';
import { DAY, HOUR } from '@/lib/clock';

/**
 * Seeds an account and, with DEMO_MODE=1, a realistic set of parcels part-way
 * through their lives — one about to be returned, one that came back, one
 * nobody was home for, several moving normally.
 *
 * The demo data exists for two reasons: somebody can be shown the system
 * without pointing it at real customers, and a change to the engine can be
 * seen working against a board that is not empty.
 *
 * Run: npm run db:seed
 */

const DEMO = process.env.DEMO_MODE === '1';

const OFFICES = [
  { correosCode: 'OF-MAD-12', name: 'Oficina Madrid Sucursal 12', address: 'C/ Mejía Lequerica 8, 28004 Madrid', postalCode: '28004', city: 'Madrid' },
  { correosCode: 'OF-SEV-01', name: 'Oficina Sevilla Centro', address: 'Av. de la Constitución 32, 41001 Sevilla', postalCode: '41001', city: 'Sevilla' },
  { correosCode: 'OF-BCN-EIX', name: 'Oficina Barcelona Eixample', address: 'C/ Aragó 282, 08007 Barcelona', postalCode: '08007', city: 'Barcelona' },
  { correosCode: 'OF-BAR-01', name: 'Oficina Barakaldo', address: 'C/ Autonomía 5, 48901 Barakaldo', postalCode: '48901', city: 'Barakaldo' },
  { correosCode: 'OF-ALC-02', name: 'Oficina Alcalá de Henares 2', address: 'C/ Libreros 17, 28801 Alcalá de Henares', postalCode: '28801', city: 'Alcalá de Henares' },
];

interface SeedParcel {
  name: string; town: string; postalCode: string; order: string; track: string;
  store: string; valueCents: number; pay: 'prepaid' | 'cod'; product: string;
  phone: string; email: string; address: string; office?: string;
  /** [days ago, hour, Spanish description] */
  script: [number, number, string][];
}

const toOffice = (start: number): [number, number, string][] => [
  [start, 9, 'Admitido'],
  [start, 19, 'En tránsito'],
  [start - 1, 8, 'En reparto'],
  [start - 1, 13, 'Intento de entrega fallido — ausente'],
  [start - 1, 19, 'Disponible en oficina para recoger'],
];

const delivered = (start: number): [number, number, string][] => [
  [start, 9, 'Admitido'],
  [start, 19, 'En tránsito'],
  [start - 1, 8, 'En reparto'],
  [start - 1, 13, 'Entregado'],
];

const PARCELS: SeedParcel[] = [
  { name: 'Lucía Fernández Ortiz', town: 'Getafe, Madrid', postalCode: '28901', order: 'ORD-4821', track: 'PQ7842931055ES',
    store: 'Cosmetics Afro Latino', valueCents: 6490, pay: 'cod', product: 'PAQ PREMIUM', phone: '+34627481093',
    email: 'lucia.fernandez91@example.com', address: 'C/ Toledo 44, 3ºB', office: 'OF-MAD-12',
    script: toOffice(15) },

  { name: 'Rocío Jiménez Palma', town: 'Dos Hermanas, Sevilla', postalCode: '41701', order: 'ORD-4811', track: 'PQ7841577390ES',
    store: 'ibBan', valueCents: 11200, pay: 'cod', product: 'PAQ ESTÁNDAR', phone: '+34661884250',
    email: 'rocio.jimenez@example.com', address: 'C/ Antonio Machado 12', office: 'OF-SEV-01',
    script: toOffice(14) },

  { name: 'Javier Moreno Sanz', town: 'Alcalá de Henares, Madrid', postalCode: '28801', order: 'ORD-4826', track: 'PQ7843902471ES',
    store: 'Cosmetics Afro Latino', valueCents: 14850, pay: 'cod', product: 'PAQ PREMIUM', phone: '+34644210875',
    email: 'javi.moreno@example.com', address: 'C/ Libreros 22, 1ºA', office: 'OF-ALC-02',
    script: toOffice(13) },

  { name: 'Nerea Bilbao Etxeberria', town: 'Barakaldo, Bizkaia', postalCode: '48901', order: 'ORD-4787', track: 'PQ7843188207ES',
    store: 'Don Cabello Pro', valueCents: 8120, pay: 'prepaid', product: 'PAQ ESTÁNDAR', phone: '+34646905317',
    email: 'nerea.bilbao@example.com', address: 'C/ Zumalakarregi 7, 2ºD', office: 'OF-BAR-01',
    script: toOffice(4) },

  { name: 'Mohamed El Amrani', town: "L'Hospitalet, Barcelona", postalCode: '08901', order: 'ORD-4818', track: 'PQ7839114602ES',
    store: 'Don Cabello Pro', valueCents: 3850, pay: 'prepaid', product: 'PAQ 48', phone: '+34612947338',
    email: 'm.elamrani@example.com', address: 'C/ Rambla Just Oliveras 31', office: 'OF-BCN-EIX',
    script: [...toOffice(13), [11, 10, 'Entregado en oficina']] },

  { name: 'Carmen Ruiz Delgado', town: 'Leganés, Madrid', postalCode: '28911', order: 'ORD-4815', track: 'PQ7840788123ES',
    store: 'Cosmetics Afro Latino', valueCents: 9240, pay: 'cod', product: 'PAQ ESTÁNDAR', phone: '+34655302719',
    email: 'carmen.ruiz@example.com', address: 'Av. de la Universidad 9, 6ºA',
    script: [[3, 9, 'Admitido'], [2, 8, 'En reparto'], [2, 12, 'Dirección incorrecta']] },

  { name: 'Óscar Vidal Ferrer', town: 'Elche, Alicante', postalCode: '03203', order: 'ORD-4829', track: 'PQ7843771905ES',
    store: 'ibBan', valueCents: 12000, pay: 'cod', product: 'PAQ ESTÁNDAR', phone: '+34673228140',
    email: 'oscar.vidal@example.com', address: 'C/ Corredora 55',
    script: [[3, 9, 'Admitido'], [2, 8, 'En reparto'], [2, 12, 'Envío rehusado por el destinatario']] },

  { name: 'Marta Gil Escudero', town: 'Zaragoza', postalCode: '50003', order: 'ORD-4749', track: 'PQ7837992005ES',
    store: 'Cosmetics Afro Latino', valueCents: 4490, pay: 'cod', product: 'PAQ ESTÁNDAR', phone: '+34655019342',
    email: 'marta.gil@example.com', address: 'C/ Don Jaime I 30', office: 'OF-MAD-12',
    script: [...toOffice(20), [1, 9, 'Devolución a origen iniciada']] },

  { name: 'Adrián Pons Beltrán', town: 'Manacor, Illes Balears', postalCode: '07500', order: 'ORD-4790', track: 'PQ7839884471ES',
    store: 'TikTok Shop ES', valueCents: 4300, pay: 'cod', product: 'PAQ ESTÁNDAR', phone: '+34673118904',
    email: 'adrian.pons@example.com', address: 'C/ Major 3',
    script: [[9, 9, 'Admitido'], [9, 20, 'En tránsito']] },

  { name: 'Andrea Castaño Ruiz', town: 'Alcorcón, Madrid', postalCode: '28921', order: 'ORD-4795', track: 'PQ7840022914ES',
    store: 'Cosmetics Afro Latino', valueCents: 2795, pay: 'prepaid', product: 'PAQ ESTÁNDAR', phone: '+34634019552',
    email: 'andrea.castano@example.com', address: 'C/ Mayor 41, 4ºC',
    script: delivered(3) },

  { name: 'Iker Agirre Mendoza', town: 'Donostia, Gipuzkoa', postalCode: '20006', order: 'ORD-4808', track: 'PQ7842014558ES',
    store: 'Don Cabello Pro', valueCents: 5610, pay: 'prepaid', product: 'PAQ ESTÁNDAR', phone: '+34688117402',
    email: 'iker.agirre@example.com', address: 'C/ Urdaneta 9',
    script: delivered(2) },

  { name: 'Paula Serrano Vidal', town: 'Paterna, Valencia', postalCode: '46980', order: 'ORD-4804', track: 'PQ7841200937ES',
    store: 'TikTok Shop ES', valueCents: 3180, pay: 'cod', product: 'PAQ 48', phone: '+34699540116',
    email: 'paula.serrano@example.com', address: 'C/ Mayor 62',
    script: delivered(1) },
];

async function main(): Promise<void> {
  const email = process.env.SEED_EMAIL ?? 'you@example.com';
  const password = process.env.SEED_PASSWORD ?? 'change-this-now';

  await getDb().insert(users).values({
    email: email.toLowerCase(),
    name: process.env.SEED_NAME ?? 'Operator',
    passwordHash: await hashPassword(password),
  }).onConflictDoNothing();

  console.log(`user: ${email}`);
  if (password === 'change-this-now') {
    console.log('  ⚠ the default password is in the repository. Change it before this is reachable.');
  }

  // The deposit window. Unconfirmed until somebody checks with Correos, and
  // the Settings screen says so out loud while that is true.
  for (const [productCode, depositDays] of [['PAQ ESTÁNDAR', 15], ['PAQ PREMIUM', 15], ['PAQ 48', 15]] as const) {
    await getDb().insert(productRules).values({
      productCode,
      depositDays,
      label: 'Working assumption — not yet confirmed with Correos',
      confirmedWithCarrier: false,
    }).onConflictDoNothing();
  }

  if (!DEMO) {
    console.log('DEMO_MODE is not 1, so no sample parcels were created.');
    await closeDb();
    return;
  }

  for (const o of OFFICES) {
    await getDb().insert(offices).values({ ...o, openingHours: 'L–V 08:30–20:30 · S 09:30–13:00' })
      .onConflictDoNothing();
  }

  const storeNames = [...new Set(PARCELS.map((p) => p.store))];
  for (const name of storeNames) {
    await getDb().insert(stores).values({
      key: name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
      name,
      platform: name.startsWith('TikTok') ? 'tiktok' : 'shopify',
      ingest: name.startsWith('TikTok') ? 'manual' : 'auto',
    }).onConflictDoNothing();
  }

  const storeIds = new Map(
    (await getDb().select({ id: stores.id, name: stores.name }).from(stores)).map((s) => [s.name, s.id]),
  );

  const now = Date.now();

  for (const p of PARCELS) {
    const [order] = await getDb().insert(orders).values({
      storeId: storeIds.get(p.store)!,
      externalOrderId: p.order,
      orderNumber: p.order,
      customerName: p.name,
      phoneE164: p.phone,
      phoneRaw: p.phone,
      phoneStatus: 'ok',
      email: p.email,
      addressLine: p.address,
      city: p.town,
      postalCode: p.postalCode,
      totalValueCents: p.valueCents,
      paymentMethod: p.pay,
      placedAt: new Date(now - 25 * DAY),
    }).onConflictDoNothing().returning({ id: orders.id });

    if (!order) continue;

    await getDb().insert(shipments).values({
      orderId: order.id,
      shippingCode: p.track,
      productCode: p.product,
      state: 'created',
    }).onConflictDoNothing();

    for (const [daysAgo, hour, desc] of p.script) {
      const at = new Date(now - daysAgo * DAY);
      at.setHours(hour, 0, 0, 0);
      await ingestEvent({
        shippingCode: p.track,
        eventCode: `SEED-${desc.slice(0, 16)}`,
        eventDesc: desc,
        occurredAt: at,
        source: 'push',
        officeCode: desc.startsWith('Disponible') ? (p.office ?? null) : null,
        officeName: null,
        rawPayload: { desEvento: desc, seed: true },
      });
    }
  }

  await setSetting('phase', 1);

  // Let the ladder catch up, so the board is not suspiciously empty.
  const fired = await runTick(await liveShipmentIds());
  console.log(`${PARCELS.length} parcels seeded · ${fired.rungsFired} escalation steps caught up`);

  await closeDb();
}

main().catch((err) => { console.error(err); process.exit(1); });
