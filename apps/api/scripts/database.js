import { readFile, readdir } from 'node:fs/promises';
import { readConfig } from '../src/config.js';
import { createPool } from '../src/database.js';

const action = process.argv[2];
if (!['migrate', 'seed', 'check'].includes(action)) throw new Error('Use migrate, seed or check.');
const pool = createPool(readConfig());
let client;
try {
  client = await pool.connect();
  if (action === 'check') {
    const { rows } = await client.query(`SELECT
      (SELECT count(*)::int FROM public.schema_migrations) AS migrations,
      (SELECT count(*)::int FROM public.slots WHERE starts_at > now()) AS future_slots,
      (SELECT count(*)::int FROM public.bookings) AS bookings`);
    console.log('Database connection and clinic tables OK:', rows[0]);
  } else {
  await client.query('BEGIN');
  // Serialize runners and record each applied migration atomically.
  await client.query('SELECT pg_advisory_xact_lock(7241901)');
  if (action === 'migrate') {
    await client.query('CREATE TABLE IF NOT EXISTS public.schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    await client.query('ALTER TABLE public.schema_migrations ENABLE ROW LEVEL SECURITY');
    await client.query('REVOKE ALL ON public.schema_migrations FROM anon, authenticated');
    const directory = new URL('../../../supabase/migrations/', import.meta.url);
    const files = (await readdir(directory)).filter(name => name.endsWith('.sql')).sort();
    for (const file of files) {
      const { rows } = await client.query('SELECT name FROM public.schema_migrations WHERE name = $1', [file]);
      if (rows.length) continue;
      await client.query(await readFile(new URL(file, directory), 'utf8'));
      await client.query('INSERT INTO public.schema_migrations (name) VALUES ($1)', [file]);
      console.log(`Applied ${file}`);
    }
  } else await client.query(await readFile(new URL('../../../supabase/seed.sql', import.meta.url), 'utf8'));
  await client.query('COMMIT');
  }
  console.log(`${action} complete.`);
} catch (error) {
  if (client && action !== 'check') await client.query('ROLLBACK');
  console.error(`${action} failed:`, error.code ?? error.name);
  if (['ENOTFOUND', 'ENETUNREACH', 'EHOSTUNREACH'].includes(error.code)) {
    console.error('Database host could not be reached. Supabase direct endpoints require IPv6; on IPv4 use Connect > Session pooler, port 5432, username postgres.PROJECT_REF. Update DATABASE_URL in apps/api/.env.');
  } else if (error.code === '28P01') {
    console.error('Database authentication failed. Check the database password and connection username in apps/api/.env.');
  } else {
    console.error('Check DATABASE_URL in apps/api/.env and run npm run db:migrate before seed/check.');
  }
  process.exitCode = 1;
} finally { client?.release(); await pool.end(); }
