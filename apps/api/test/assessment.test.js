import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { bookingStore } from '../src/bookings.js';
import { createPool } from '../src/database.js';

const apiKey = 'test-key-that-is-at-least-32-characters';
const future = offset => new Date(Date.now() + 86400000 + offset * 3600000).toISOString();
const slots = [
  { id: 's2', provider: 'Dr Ade', start: future(1), end: future(1.5) },
  { id: 'past', provider: 'Dr Past', start: '2020-01-01T09:00:00Z', end: '2020-01-01T09:30:00Z' },
  { id: 's1', provider: 'Dr Ade', start: future(0), end: future(.5) },
  { id: 's3', provider: 'Dr Other', start: future(2), end: future(2.5) },
];
const payload = { slot_id: 's1', name: 'Ada Obi', email: 'ada@example.com' };

async function embeddedPool() {
  const db = new PGlite();
  // PGlite is single-session. Serialize checked-out clients to preserve transactions.
  let queue = Promise.resolve();
  async function connect() {
    let release;
    const prior = queue;
    queue = new Promise(resolve => { release = resolve; });
    await prior;
    return { query: (sql, values) => db.query(sql, values), release };
  }
  await db.exec('CREATE ROLE anon; CREATE ROLE authenticated;');
  return {
    connect,
    async query(sql, values) { const client = await connect(); try { return await client.query(sql, values); } finally { client.release(); } },
    exec: sql => db.exec(sql),
    end: () => db.close(),
  };
}

async function contractSuite(t, pool) {
  const store = bookingStore(pool);
  const app = createApp({ store, apiKey });
  const get = path => request(app).get(path).set('X-API-Key', apiKey);
  const post = (path, body) => request(app).post(path).set('X-API-Key', apiKey).send(body);
  const book = (body = payload, key) => {
    const req = post('/bookings', body);
    return key ? req.set('Idempotency-Key', key) : req;
  };
  const cancel = id => request(app).delete(`/bookings/${id}`).set('X-API-Key', apiKey);
  async function reset() { assert.equal((await post('/reset', { slots })).status, 200); }

  await t.test('API key protects every assessment endpoint and /api aliases', async () => {
    for (const prefix of ['', '/api']) {
      for (const [method, path] of [['post', '/reset'], ['get', '/slots'], ['post', '/bookings'], ['get', '/bookings'], ['get', '/bookings/nope'], ['delete', '/bookings/nope']]) {
        assert.equal((await request(app)[method](`${prefix}${path}`)).status, 401);
        assert.equal((await request(app)[method](`${prefix}${path}`).set('X-API-Key', 'wrong')).status, 401);
      }
    }
  });
  await t.test('reset accepts past slots and listing includes all slots in order with exact provider filtering', async () => {
    await reset();
    const response = await get('/slots');
    assert.equal(response.status, 200);
    assert.deepEqual(response.body.slots.map(slot => slot.id), ['past', 's1', 's2', 's3']);
    assert.ok(response.body.slots.every(slot => slot.available === true && slot.provider && slot.start && slot.end));
    assert.equal((await get('/slots?provider=Dr%20Ade')).body.slots.length, 2);
    assert.equal((await get('/slots?provider=dr%20ade')).body.slots.length, 0);
    assert.deepEqual((await get('/api/slots')).body, response.body);
    assert.equal(response.headers['cache-control'], 'no-store');
  });
  await t.test('validation, trimming, normalization, non-UUID slots, lookup and missing/past slots', async () => {
    await reset();
    for (const body of [{}, { ...payload, name: '' }, { ...payload, email: 'bad' }, { ...payload, slot_id: '' }, { ...payload, email: ' ' }]) {
      assert.equal((await book(body)).status, 400);
    }
    assert.equal((await book({ ...payload, email: 'other@example.com', slot_id: 'unknown' })).status, 404);
    assert.equal((await book({ ...payload, email: 'other@example.com', slot_id: 'past' })).status, 400);
    const created = await book({ ...payload, name: ' A ', email: ' ADA@EXAMPLE.COM ' });
    assert.equal(created.status, 201);
    assert.deepEqual(Object.keys(created.body).sort(), ['id', 'slot_id', 'name', 'email', 'status', 'created_at'].sort());
    assert.equal(created.body.name, 'A'); assert.equal(created.body.email, payload.email);
    assert.equal(created.body.status, 'confirmed');
    assert.deepEqual((await get(`/bookings/${created.body.id}`)).body, created.body);
    assert.equal((await get('/bookings/does-not-exist')).status, 404);
  });
  await t.test('simultaneous requests cannot double-book; cancellation deletes the booking and frees its slot', async () => {
    await reset();
    const attempts = await Promise.all(Array.from({ length: 10 }, (_, i) => book({ ...payload, email: `race${i}@example.com` })));
    assert.equal(attempts.filter(item => item.status === 201).length, 1);
    assert.equal(attempts.filter(item => item.status === 409).length, 9);
    assert.equal((await get('/slots')).body.slots.find(slot => slot.id === 's1').available, false);
    const winner = attempts.find(item => item.status === 201).body;
    const cancelled = await cancel(winner.id);
    assert.equal(cancelled.status, 200); assert.equal(cancelled.body.status, 'cancelled');
    assert.equal(cancelled.body.slot_id, 's1');
    assert.equal((await cancel(winner.id)).status, 404);
    assert.equal((await get(`/bookings/${winner.id}`)).status, 404);
    assert.equal((await pool.query('SELECT id FROM bookings WHERE id = $1', [winner.id])).rows.length, 0);
    assert.equal((await cancel('invalid')).status, 404);
    assert.equal((await get('/slots')).body.slots.find(slot => slot.id === 's1').available, true);
    assert.equal((await book()).status, 201);
  });
  await t.test('idempotency replays exact responses and returns gone after cancellation without retaining booking details', async () => {
    await reset();
    const [first, replay] = await Promise.all([book(payload, 'retry-1'), book(payload, 'retry-1')]);
    assert.equal(first.status, 201); assert.deepEqual(replay.body, first.body); assert.equal(replay.status, 201);
    const reordered = await book({ email: payload.email, name: payload.name, slot_id: payload.slot_id }, 'retry-1');
    assert.deepEqual(reordered.body, first.body);
    assert.equal((await book({ ...payload, name: 'Changed' }, 'retry-1')).status, 422);
    await cancel(first.body.id);
    const afterCancel = await book(payload, 'retry-1');
    assert.equal(afterCancel.status, 410);
    assert.match(afterCancel.body.error, /cancelled/);
    assert.equal((await get(`/bookings/${first.body.id}`)).status, 404);
    const stored = (await pool.query('SELECT response_body FROM booking_idempotency WHERE key = $1', ['retry-1'])).rows[0].response_body;
    assert.deepEqual(Object.keys(stored), ['error']);
  });
  await t.test('failed requests are also cached by idempotency key', async () => {
    await reset();
    const first = await book({ ...payload, slot_id: 'unknown' }, 'failed-key');
    assert.equal(first.status, 404);
    await pool.query(`INSERT INTO slots (id, clinician, starts_at, ends_at) VALUES ('unknown', 'New', $1, $2)`, [future(3), future(3.5)]);
    const second = await book({ ...payload, slot_id: 'unknown' }, 'failed-key');
    assert.equal(second.status, 404); assert.deepEqual(second.body, first.body);
  });
  await t.test('cursor pagination is case insensitive, stable on timestamp ties, and omits deleted bookings', async () => {
    await reset();
    const first = await book();
    assert.equal(first.status, 201);
    await pool.query("UPDATE slots SET starts_at = '2020-01-01T09:00:00Z', ends_at = '2020-01-01T09:30:00Z' WHERE id = 's1'");
    for (const slot_id of ['s2', 's3']) assert.equal((await book({ ...payload, slot_id })).status, 201);
    await pool.query("UPDATE bookings SET created_at = '2026-01-01T00:00:00.123Z'");
    const all = (await get('/bookings?email=ADA%40EXAMPLE.COM')).body;
    assert.equal(all.bookings.length, 3); assert.equal(all.next_cursor, null);
    const ids = []; let cursor;
    do {
      const response = await get(`/bookings?email=ada%40example.com&limit=1${cursor ? `&cursor=${cursor}` : ''}`);
      assert.equal(response.status, 200);
      ids.push(...response.body.bookings.map(item => item.id)); cursor = response.body.next_cursor;
    } while (cursor);
    assert.deepEqual(ids, all.bookings.map(item => item.id)); assert.equal(new Set(ids).size, 3);
    await cancel(first.body.id);
    assert.equal((await get('/bookings?email=ada%40example.com')).body.bookings.length, 2);
    for (const limit of ['0', '51', '-1', '1.5', 'nope', '']) assert.equal((await get(`/bookings?email=ada%40example.com&limit=${limit}`)).status, 400);
    assert.equal((await get('/bookings')).status, 400);
    assert.equal((await get('/bookings?email=ada%40example.com&cursor=invalid')).status, 400);
    const firstPage = (await get('/bookings?email=ada%40example.com&limit=1')).body;
    assert.equal((await get(`/bookings?email=other%40example.com&cursor=${firstPage.next_cursor}`)).status, 400);
  });
  await t.test('two upcoming appointments per normalized email, including simultaneous requests; cancellation restores capacity', async () => {
    await reset();
    const secondApp = createApp({ store: bookingStore(pool), apiKey });
    const responses = await Promise.all(['s1', 's2', 's3'].map((slot_id, i) =>
      request(i % 2 ? app : secondApp).post('/bookings').set('X-API-Key', apiKey)
        .send({ ...payload, email: i % 2 ? ' ADA@EXAMPLE.COM ' : payload.email, slot_id })));
    const confirmed = responses.filter(item => item.status === 201);
    assert.equal(confirmed.length, 2);
    const blocked = responses.find(item => item.status === 409);
    assert.match(blocked.body.error, /at most 2 upcoming appointments/);
    const unused = ['s1', 's2', 's3'].find(id => !confirmed.some(item => item.body.slot_id === id));
    await cancel(confirmed[0].body.id);
    const replacement = await book({ ...payload, slot_id: unused }, 'replacement');
    assert.equal(replacement.status, 201);
    const replay = await book({ ...payload, slot_id: unused }, 'replacement');
    assert.equal(replay.status, 201);
    assert.equal(replay.body.id, replacement.body.id);
  });
  await t.test('a quota rejection can be retried with the same key after cancellation, including old cached quota failures', async () => {
    await reset();
    const first = await book(payload, 'cancelled-source');
    assert.equal(first.status, 201);
    assert.equal((await book({ ...payload, slot_id: 's2' })).status, 201);
    const body = { ...payload, slot_id: 's3' };
    const rejected = await book(body, 'quota-retry');
    assert.equal(rejected.status, 409);
    assert.equal((await pool.query('SELECT key FROM booking_idempotency WHERE key = $1', ['quota-retry'])).rows.length, 0);
    // Reproduce a quota response persisted by the previous implementation.
    const hash = createHash('sha256').update(JSON.stringify(Object.fromEntries(Object.entries(body).sort(([a], [b]) => a.localeCompare(b))))).digest('hex');
    await pool.query('INSERT INTO booking_idempotency (key, body_hash, status_code, response_body) VALUES ($1, $2, 409, $3::jsonb)', ['quota-retry', hash, JSON.stringify(rejected.body)]);
    assert.equal((await cancel(first.body.id)).status, 200);
    assert.equal((await book(body, 'quota-retry')).status, 201);
    assert.equal((await get('/bookings?email=ada%40example.com')).body.bookings.length, 2);
    assert.equal((await book(payload, 'cancelled-source')).status, 410);
  });
  await t.test('five attempts per normalized email, failed attempts count, other emails unaffected, window expires', async () => {
    await reset();
    for (let i = 0; i < 5; i++) assert.equal((await book({ email: ' ADA@EXAMPLE.COM ' })).status, 400);
    const blocked = await book();
    assert.equal(blocked.status, 429); assert.match(blocked.headers['retry-after'], /^[1-9]\d*$/);
    assert.ok(Number(blocked.headers['retry-after']) <= 60);
    assert.equal((await book({ ...payload, email: 'other@example.com' })).status, 201);
    await pool.query("UPDATE booking_rate_limits SET attempts = ARRAY[clock_timestamp() - interval '61 seconds'] WHERE email = $1", [payload.email]);
    assert.equal((await book({ ...payload, slot_id: 's2' })).status, 201);
  });
  await t.test('rate limits hold under simultaneous requests and across app instances', async () => {
    await reset();
    const secondApp = createApp({ store: bookingStore(pool), apiKey });
    const responses = await Promise.all(Array.from({ length: 12 }, (_, i) => request(i % 2 ? app : secondApp).post('/bookings').set('X-API-Key', apiKey).send({ email: payload.email })));
    assert.equal(responses.filter(item => item.status === 400).length, 5);
    assert.equal(responses.filter(item => item.status === 429).length, 7);
  });
  await t.test('reset deletes bookings, idempotency records and attempt counts; invalid reset is non-destructive', async () => {
    await reset();
    const first = await book(payload, 'reset-key');
    assert.equal(first.status, 201);
    assert.equal((await post('/reset', { slots: [slots[0], slots[0]] })).status, 400);
    assert.equal((await get(`/bookings/${first.body.id}`)).status, 200);
    assert.equal((await post('/reset', { slots: [] })).status, 200);
    assert.equal((await get(`/bookings/${first.body.id}`)).status, 404);
    assert.deepEqual((await get('/slots')).body, { slots: [] });
    assert.equal((await pool.query('SELECT * FROM booking_idempotency')).rows.length, 0);
    assert.equal((await pool.query('SELECT * FROM booking_rate_limits')).rows.length, 0);
  });
  await t.test('malformed JSON and incorrect content types return JSON errors', async () => {
    assert.equal((await request(app).post('/bookings').set('X-API-Key', apiKey).set('Content-Type', 'application/json').send('{')).status, 400);
    assert.equal((await request(app).post('/bookings').set('X-API-Key', apiKey).send('not json')).status, 415);
  });
}

test('assessment contract against embedded PostgreSQL (single session)', async t => {
  const pool = await embeddedPool();
  try {
    const directory = new URL('../../../supabase/migrations/', import.meta.url);
    for (const file of (await readdir(directory)).filter(name => name.endsWith('.sql')).sort()) {
      if (file === '002_assessment_contract.sql') {
        // Exercise an upgrade with records from the original starter schema.
        await pool.query(`INSERT INTO slots (id, clinician, starts_at, ends_at)
          VALUES ('a291a3ce-fc57-4eaa-8f5f-a99421a75681', 'Existing clinician', $1, $2)`, [future(0), future(.5)]);
        await pool.query(`INSERT INTO bookings (id, slot_id, patient_name, patient_email, access_token_hash)
          VALUES ('b291a3ce-fc57-4eaa-8f5f-a99421a75681', 'a291a3ce-fc57-4eaa-8f5f-a99421a75681', 'Existing Patient', 'OLD@EXAMPLE.COM', 'old-token-hash')`);
      }
      await pool.exec(await readFile(new URL(file, directory), 'utf8'));
    }
    const migrated = await bookingStore(pool).find('b291a3ce-fc57-4eaa-8f5f-a99421a75681');
    assert.equal(migrated.email, 'old@example.com');
    assert.equal(migrated.slot_id, 'a291a3ce-fc57-4eaa-8f5f-a99421a75681');
    assert.equal(migrated.status, 'confirmed');
    // Ensure the revised seed parses and remains safe to run twice.
    const seed = await readFile(new URL('../../../supabase/seed.sql', import.meta.url), 'utf8');
    await pool.exec(seed); const count = (await pool.query('SELECT count(*) FROM slots')).rows[0].count;
    await pool.exec(seed); assert.equal((await pool.query('SELECT count(*) FROM slots')).rows[0].count, count);
    await contractSuite(t, pool);
  } finally { await pool.end(); }
});

test('assessment contract against real multi-connection PostgreSQL', { skip: !process.env.TEST_DATABASE_URL }, async t => {
  // Dedicated migrated test database only: the contract suite calls /reset.
  const pool = createPool({ DATABASE_URL: process.env.TEST_DATABASE_URL, DATABASE_SSL: process.env.TEST_DATABASE_SSL ?? 'true' });
  try { await contractSuite(t, pool); } finally { await pool.end(); }
});

test('all five levels against isolated live Supabase connections', { skip: process.env.RUN_LIVE_AUDIT !== 'true' }, async t => {
  const { readConfig } = await import('../src/config.js');
  const config = readConfig();
  const admin = createPool(config);
  const schema = `clinic_audit_${randomUUID().replaceAll('-', '')}`;
  let created = false;
  let pool;
  try {
    // A fresh private schema, never public, contains every test table and record.
    assert.match(schema, /^clinic_audit_[a-f0-9]{32}$/);
    await admin.query(`CREATE SCHEMA ${schema}`);
    created = true;
    const url = new URL(config.DATABASE_URL);
    url.searchParams.set('options', `-c search_path=${schema}`);
    pool = createPool({ ...config, DATABASE_URL: url.toString() });
    assert.equal((await pool.query('SELECT current_schema() AS schema')).rows[0].schema, schema);
    const directory = new URL('../../../supabase/migrations/', import.meta.url);
    for (const file of (await readdir(directory)).filter(name => name.endsWith('.sql')).sort()) {
      const sql = await readFile(new URL(file, directory), 'utf8');
      await pool.query(sql.replaceAll('public.', `${schema}.`));
    }
    const clients = await Promise.all([pool.connect(), pool.connect()]);
    try {
      const sessions = await Promise.all(clients.map(client => client.query('SELECT pg_backend_pid() AS pid')));
      assert.notEqual(sessions[0].rows[0].pid, sessions[1].rows[0].pid);
    } finally { clients.forEach(client => client.release()); }
    await contractSuite(t, pool);
  } finally {
    if (pool) await pool.end();
    try { if (created) await admin.query(`DROP SCHEMA ${schema} CASCADE`); }
    finally { await admin.end(); }
  }
});
