import { createHash } from 'node:crypto';

const fields = 'id, slot_id, patient_name AS name, patient_email AS email, status, created_at';
const error = (status, message) => ({ status, body: { error: message } });
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
const fingerprint = value => createHash('sha256').update(JSON.stringify(canonical(value ?? null))).digest('hex');

export function bookingStore(pool) {
  async function transaction(action, exclusive = false) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // Reset waits for in-flight writes; normal operations run together.
      await client.query(`SELECT ${exclusive ? 'pg_advisory_xact_lock' : 'pg_advisory_xact_lock_shared'}(824201, 0)`);
      const result = await action(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally { client.release(); }
  }

  return {
    async reset(slots) {
      await transaction(async client => {
        await client.query('DELETE FROM booking_idempotency');
        await client.query('DELETE FROM booking_rate_limits');
        await client.query('DELETE FROM bookings');
        await client.query('DELETE FROM slots');
        await client.query(`INSERT INTO slots (id, clinician, starts_at, ends_at)
          SELECT id, provider, start, "end" FROM jsonb_to_recordset($1::jsonb)
          AS x(id text, provider text, start timestamptz, "end" timestamptz)`, [JSON.stringify(slots)]);
      }, true);
    },
    async slots(provider) {
      const { rows } = await pool.query(`SELECT s.id, s.clinician AS provider, s.starts_at AS start, s.ends_at AS "end",
        NOT EXISTS (SELECT 1 FROM bookings b WHERE b.slot_id = s.id AND b.status = 'confirmed') AS available
        FROM slots s WHERE ($1::text IS NULL OR s.clinician = $1) ORDER BY s.starts_at, s.id`, [provider ?? null]);
      return rows;
    },
    async attempt(email) {
      return transaction(async client => {
        await client.query('SELECT pg_advisory_xact_lock(824203, hashtext($1))', [email]);
        const { rows } = await client.query('SELECT attempts, clock_timestamp() AS current_time FROM booking_rate_limits WHERE email = $1', [email]);
        const now = rows[0]?.current_time ?? (await client.query('SELECT clock_timestamp() AS current_time')).rows[0].current_time;
        const recent = (rows[0]?.attempts ?? []).filter(time => now.getTime() - time.getTime() < 60000);
        if (recent.length >= 5) return Math.max(1, Math.ceil((recent[0].getTime() + 60000 - now.getTime()) / 1000));
        recent.push(now);
        await client.query(`INSERT INTO booking_rate_limits (email, attempts) VALUES ($1, $2)
          ON CONFLICT (email) DO UPDATE SET attempts = EXCLUDED.attempts`, [email, recent]);
        return null;
      });
    },
    async create({ body, data, idempotencyKey }) {
      return transaction(async client => {
        const hash = fingerprint(body);
        if (idempotencyKey !== undefined) {
          await client.query('SELECT pg_advisory_xact_lock(824202, hashtext($1))', [idempotencyKey]);
          const { rows } = await client.query('SELECT * FROM booking_idempotency WHERE key = $1', [idempotencyKey]);
          // Old versions persisted quota failures. Reevaluate those after capacity changes.
          const quotaFailure = rows[0]?.status_code === 409 && rows[0].response_body?.error?.includes('at most 2 upcoming appointments');
          if (quotaFailure && rows[0].body_hash === hash) await client.query('DELETE FROM booking_idempotency WHERE key = $1', [idempotencyKey]);
          else if (rows[0]) return rows[0].body_hash === hash
            ? { status: rows[0].status_code, body: rows[0].response_body }
            : error(422, 'Idempotency-Key was already used with a different body.');
        }
        let result;
        if (!data) result = error(400, 'slot_id, name and a valid email are required.');
        else {
          // Serialize this email's bookings across API instances before counting.
          await client.query('SELECT pg_advisory_xact_lock(824204, hashtext($1))', [data.email]);
          const { rows: slots } = await client.query('SELECT id, starts_at <= clock_timestamp() AS started FROM slots WHERE id = $1 FOR UPDATE', [data.slot_id]);
          if (!slots[0]) result = error(404, 'Slot not found.');
          else if (slots[0].started) result = error(400, 'This slot has already started.');
          else {
            const { rows: active } = await client.query(`SELECT count(*)::int AS count FROM bookings b
              JOIN slots s ON s.id = b.slot_id
              WHERE b.patient_email = $1 AND b.status = 'confirmed' AND s.starts_at > clock_timestamp()`, [data.email]);
            if (active[0].count >= 2) result = error(409, 'You can have at most 2 upcoming appointments per email address. Cancel an appointment before booking another.');
            else {
            const { rows } = await client.query(`INSERT INTO bookings (slot_id, patient_name, patient_email)
              VALUES ($1, $2, $3) ON CONFLICT (slot_id) WHERE status = 'confirmed' DO NOTHING RETURNING ${fields}`,
            [data.slot_id, data.name, data.email]);
            result = rows[0] ? { status: 201, body: rows[0] } : error(409, 'This slot has already been booked.');
            }
          }
        }
        const quotaFailure = result.status === 409 && result.body.error?.includes('at most 2 upcoming appointments');
        if (idempotencyKey !== undefined && !quotaFailure) await client.query(`INSERT INTO booking_idempotency (key, body_hash, status_code, response_body)
          VALUES ($1, $2, $3, $4::jsonb)`, [idempotencyKey, hash, result.status, JSON.stringify(result.body)]);
        return result;
      });
    },
    async find(id) {
      const { rows } = await pool.query(`SELECT ${fields} FROM bookings WHERE id = $1`, [id]);
      return rows[0];
    },
    async cancel(id) {
      return transaction(async client => {
        const { rows } = await client.query(`SELECT ${fields} FROM bookings WHERE id = $1`, [id]);
        if (!rows[0]) return error(404, 'Booking not found.');
        await client.query('SELECT pg_advisory_xact_lock(824204, hashtext($1))', [rows[0].email]);
        const result = await client.query(`DELETE FROM bookings WHERE id = $1 RETURNING ${fields}`, [id]);
        if (!result.rows[0]) return error(404, 'Booking not found.');
        // Retain only a non-personal retry tombstone, never a deleted booking's payload.
        await client.query(`UPDATE booking_idempotency SET status_code = 410,
          response_body = '{"error":"This appointment was cancelled. Start a new booking."}'::jsonb
          WHERE response_body->>'id' = $1`, [id]);
        return { status: 200, body: { ...result.rows[0], status: 'cancelled' } };
      });
    },
    async list({ email, limit, cursor }) {
      const { rows } = await pool.query(`SELECT ${fields} FROM bookings WHERE patient_email = $1
        AND ($2::timestamptz IS NULL OR (created_at, id) > ($2::timestamptz, $3::uuid))
        ORDER BY created_at, id LIMIT $4`, [email, cursor?.created_at ?? null, cursor?.id ?? null, limit + 1]);
      const bookings = rows.slice(0, limit);
      const last = bookings.at(-1);
      const next_cursor = rows.length > limit ? Buffer.from(JSON.stringify({ email, id: last.id, created_at: last.created_at.toISOString() })).toString('base64url') : null;
      return { bookings, next_cursor };
    },
  };
}
