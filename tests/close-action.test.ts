import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { getDb } from '@/db';
import { closures, shipments, users } from '@/db/schema';
import { eq } from 'drizzle-orm';

// A server action is a public endpoint whatever the page around it looks like,
// so the guard is stubbed with a spy and one test below asserts it is called.
// `closed_by` is a uuid foreign key to users, so the stubbed session has to
// be a real row — a made-up id would fail on the constraint rather than on
// anything the test is about.
let userId = '00000000-0000-0000-0000-000000000000';
const requireUser = vi.fn(async () => ({ id: userId, email: 'op@example.com', name: 'Op' }));
vi.mock('@/lib/auth/guard', () => ({ requireUser }));
// revalidatePath needs a request scope, which there is none of here.
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const { stopChasing, undoStopChasing } = await import('@/app/actions/parcel');
const { TestClock, resetClock } = await import('@/lib/clock');
const { resetDb, closeDb } = await import('./helpers/db');
const { makeShipment } = await import('./helpers/fixtures');

/**
 * The close action, from the outside.
 *
 * `dropIt` validates the reason and so does this, which looks redundant and is
 * not: `reason` arrives here as whatever the caller sent. Anyone who can reach
 * the endpoint can send `reason: "x"`, and the only thing standing between
 * that and a row in `closures` is this check.
 */

let clock: InstanceType<typeof TestClock>;

beforeEach(async () => {
  await resetDb();
  clock = new TestClock('2026-10-07T10:00:00+02:00');
  clock.install();
  const [u] = await getDb().insert(users).values({
    email: 'op@example.com', name: 'Op', passwordHash: 'x',
  }).returning({ id: users.id });
  userId = u.id;
  requireUser.mockClear();
});

afterAll(async () => {
  resetClock();
  await closeDb();
});

describe('stopChasing', () => {
  it('refuses to run for anyone who is not logged in', async () => {
    const fix = await makeShipment({ shippingCode: 'PA1', state: 'at_office' });
    await stopChasing(fix.shipmentId, 'lost');
    expect(requireUser).toHaveBeenCalledOnce();
  });

  it('rejects a reason that is not one of the four', async () => {
    const fix = await makeShipment({ shippingCode: 'PA2', state: 'at_office' });

    await expect(stopChasing(fix.shipmentId, 'whatever')).rejects.toThrow(/unknown close reason/);
    await expect(stopChasing(fix.shipmentId, '')).rejects.toThrow(/unknown close reason/);

    const [row] = await getDb().select().from(shipments).where(eq(shipments.id, fix.shipmentId));
    expect(row.droppedAt).toBeNull();
    expect(await getDb().select().from(closures)).toHaveLength(0);
  });

  it('rejects "other" with no note', async () => {
    const fix = await makeShipment({ shippingCode: 'PA3', state: 'at_office' });
    await expect(stopChasing(fix.shipmentId, 'other')).rejects.toThrow(/needs a note/);
  });

  it('records who closed it', async () => {
    const fix = await makeShipment({ shippingCode: 'PA4', state: 'at_office' });

    await stopChasing(fix.shipmentId, 'returned_received', 'back on the shelf');

    const [row] = await getDb().select().from(shipments).where(eq(shipments.id, fix.shipmentId));
    expect(row.closeReason).toBe('returned_received');
    expect(row.closeNote).toBe('back on the shelf');
    // The user id comes from the session, never from the caller's arguments.
    expect(row.closedBy).toBe(userId);

    const [c] = await getDb().select().from(closures);
    expect(c.closedBy).toBe(userId);
  });

  it('undoes through the same guard', async () => {
    const fix = await makeShipment({ shippingCode: 'PA5', state: 'at_office' });
    await stopChasing(fix.shipmentId, 'lost');
    requireUser.mockClear();

    await undoStopChasing(fix.shipmentId);

    expect(requireUser).toHaveBeenCalledOnce();
    const [row] = await getDb().select().from(shipments).where(eq(shipments.id, fix.shipmentId));
    expect(row.droppedAt).toBeNull();
  });
});
