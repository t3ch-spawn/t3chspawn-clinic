import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

dotenv.config({ path: fileURLToPath(new URL('../.env', import.meta.url)), quiet: true });
export function readConfig() {
  const result = z.object({
    PORT: z.coerce.number().int().min(1).max(65535).default(3001),
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    DATABASE_URL: z.url().refine(value => {
      try {
        const url = new URL(value);
        return ['postgres:', 'postgresql:'].includes(url.protocol)
          && !!url.username && !!url.password
          && !/PROJECT_REF|POOLER_HOST/i.test(url.username + url.hostname)
          && !/^(PASSWORD|YOUR_PASSWORD|\[YOUR-PASSWORD\])$/i.test(decodeURIComponent(url.password));
      } catch { return false; }
    }, 'Use the PostgreSQL connection string from Supabase Connect with your password filled in'),
    DATABASE_SSL: z.enum(['true', 'false']).default('true'),
    DATABASE_SSL_CA_FILE: z.string().min(1).optional(),
    API_KEY: z.string().min(32),
  }).safeParse(process.env);
  if (!result.success) throw new Error(`Invalid environment: ${result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')}. Edit apps/api/.env; see apps/api/.env.example.`);
  return result.data;
}
