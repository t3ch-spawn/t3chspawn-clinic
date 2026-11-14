import pg from 'pg';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function createPool(config) {
  // Strip URL SSL flags so they cannot override certificate verification below.
  const url = new URL(config.DATABASE_URL);
  for (const key of ['sslmode', 'sslcert', 'sslkey', 'sslrootcert']) url.searchParams.delete(key);
  return new pg.Pool({
    connectionString: url.toString(), max: 10,
    ssl: config.DATABASE_SSL === 'true' ? {
      rejectUnauthorized: true,
      ...(config.DATABASE_SSL_CA_FILE ? {
        ca: readFileSync(resolve(fileURLToPath(new URL('../', import.meta.url)), config.DATABASE_SSL_CA_FILE), 'utf8'),
      } : {}),
    } : false,
    connectionTimeoutMillis: 10000, statement_timeout: 10000,
  });
}
