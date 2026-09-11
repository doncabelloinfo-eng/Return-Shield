import 'dotenv/config';
import { randomInt } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db, sql } from '@/db';
import { users } from '@/db/schema';
import { hashPassword } from '@/lib/auth/password';

/**
 * Add somebody to the team, or reset their password.
 *
 *   npx tsx scripts/create-user.ts ana@example.com "Ana Ruiz"
 *
 * There is no public signup — one business, a handful of people — so this is
 * how accounts are made. The password is generated here and printed once
 * rather than taken as an argument, because an argument ends up in the shell
 * history and in the process list.
 */
async function main(): Promise<void> {
  const [email, name] = process.argv.slice(2);
  if (!email || !name) {
    console.error('Usage: tsx scripts/create-user.ts <email> "<name>"');
    process.exit(1);
  }

  const password = generatePassword();
  const passwordHash = await hashPassword(password);
  const lower = email.trim().toLowerCase();

  const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.email, lower)).limit(1);

  if (existing) {
    await db.update(users).set({ passwordHash, disabledAt: null }).where(eq(users.id, existing.id));
    console.log(`Password reset for ${lower}`);
  } else {
    await db.insert(users).values({ email: lower, name, passwordHash });
    console.log(`Created ${lower}`);
  }

  console.log(`Password: ${password}`);
  console.log('Shown once. Send it to them out of band and have them change it.');
  await sql.end();
}

function generatePassword(): string {
  const words = ['correos', 'oficina', 'paquete', 'reparto', 'destino', 'aviso', 'plazo', 'origen'];
  return Array.from({ length: 4 }, () => words[randomInt(words.length)]).join('-')
    + `-${randomInt(1000, 9999)}`;
}

main().catch((err) => { console.error(err); process.exit(1); });
