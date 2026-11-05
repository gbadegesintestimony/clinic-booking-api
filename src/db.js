const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');

const DEFAULT_SLOTS = [
  {
    id: 's1',
    provider: 'Dr Ade',
    start: '2026-12-10T09:00:00Z',
    end: '2026-12-10T09:30:00Z'
  },
  {
    id: 's2',
    provider: 'Dr Ade',
    start: '2026-12-10T09:30:00Z',
    end: '2026-12-10T10:00:00Z'
  },
  {
    id: 's3',
    provider: 'Dr Bello',
    start: '2026-12-10T10:00:00Z',
    end: '2026-12-10T10:30:00Z'
  },
  {
    id: 's4',
    provider: 'Dr Bello',
    start: '2026-12-10T11:00:00Z',
    end: '2026-12-10T11:30:00Z'
  },
  {
    id: 's5',
    provider: 'Dr Chen',
    start: '2026-12-11T14:00:00Z',
    end: '2026-12-11T14:30:00Z'
  },
  {
    id: 's6',
    provider: 'Dr Chen',
    start: '2026-12-11T15:00:00Z',
    end: '2026-12-11T15:30:00Z'
  }
];

function canonicalizeValue(val) {
  if (val === null || typeof val !== 'object') {
    return val;
  }
  if (Array.isArray(val)) {
    return val.map(canonicalizeValue);
  }
  const sortedKeys = Object.keys(val).sort();
  const result = {};
  for (const k of sortedKeys) {
    result[k] = canonicalizeValue(val[k]);
  }
  return result;
}

function hashRequestBody(body) {
  const canonical = JSON.stringify(canonicalizeValue(body));
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

function isValidEmail(email) {
  if (typeof email !== 'string') return false;
  if (email.length > 254 || email.length < 3) return false;
  if (/\s/.test(email)) return false;
  const parts = email.split('@');
  if (parts.length !== 2) return false;
  const [local, domain] = parts;
  if (!local || !domain) return false;
  if (local.startsWith('.') || local.endsWith('.') || local.includes('..')) return false;
  if (domain.startsWith('.') || domain.endsWith('.') || domain.includes('..')) return false;
  const domainLabels = domain.split('.');
  if (domainLabels.length < 2) return false;
  for (const label of domainLabels) {
    if (!label || label.startsWith('-') || label.endsWith('-')) return false;
    if (!/^[a-zA-Z0-9-]+$/.test(label)) return false;
  }
  const tld = domainLabels[domainLabels.length - 1];
  if (tld.length < 2) return false;
  return true;
}

/**
 * In-process async mutex to serialize write transactions safely.
 */
class AsyncMutex {
  constructor() {
    this._queue = Promise.resolve();
  }
  run(fn) {
    const next = this._queue.then(fn, fn);
    this._queue = next.catch(() => {});
    return next;
  }
}

/**
 * SQLite Storage Engine (using built-in node:sqlite DatabaseSync)
 */
class SqliteStorage {
  constructor(dbPath) {
    const { DatabaseSync } = require('node:sqlite');
    if (dbPath !== ':memory:') {
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    }
    this.db = new DatabaseSync(dbPath);
    this.mutex = new AsyncMutex();
    this._init();
  }

  _init() {
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA busy_timeout = 5000;

      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS slots (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        start_iso TEXT NOT NULL,
        end_iso TEXT NOT NULL,
        start_ms INTEGER NOT NULL,
        seq INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS bookings (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        slot_id TEXT NOT NULL,
        name TEXT NOT NULL,
        email TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('confirmed', 'cancelled')),
        created_at TEXT NOT NULL
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_bookings_confirmed_slot
      ON bookings (slot_id)
      WHERE status = 'confirmed';

      CREATE INDEX IF NOT EXISTS idx_bookings_email_seq
      ON bookings (email, seq);

      CREATE TABLE IF NOT EXISTS idempotency_keys (
        idem_key TEXT PRIMARY KEY,
        body_hash TEXT NOT NULL,
        status_code INTEGER NOT NULL,
        response_json TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS rate_limits (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT NOT NULL,
        attempted_at_ms INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_rate_limits_email_time
      ON rate_limits (email, attempted_at_ms);
    `);

    const seeded = this.db.prepare(`SELECT value FROM meta WHERE key = 'seeded'`).get();
    if (!seeded) {
      this._replaceSlotsSync(DEFAULT_SLOTS);
      this.db.prepare(`INSERT OR REPLACE INTO meta (key, value) VALUES ('seeded', '1')`).run();
    }
  }

  _replaceSlotsSync(slots) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.exec('DELETE FROM bookings');
      this.db.exec('DELETE FROM slots');
      this.db.exec('DELETE FROM idempotency_keys');
      this.db.exec('DELETE FROM rate_limits');

      const insertSlot = this.db.prepare(`
        INSERT INTO slots (id, provider, start_iso, end_iso, start_ms, seq)
        VALUES (?, ?, ?, ?, ?, ?)
      `);

      slots.forEach((slot, idx) => {
        const startMs = Date.parse(slot.start);
        insertSlot.run(
          String(slot.id),
          String(slot.provider),
          String(slot.start),
          String(slot.end),
          Number.isNaN(startMs) ? 0 : startMs,
          idx
        );
      });

      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  async resetSlots(slots) {
    return this.mutex.run(async () => {
      this._replaceSlotsSync(slots);
    });
  }

  async listSlots(provider) {
    const query = `
      SELECT
        s.id,
        s.provider,
        s.start_iso AS start,
        s.end_iso AS "end",
        CASE WHEN b.id IS NULL THEN 1 ELSE 0 END AS available
      FROM slots s
      LEFT JOIN bookings b
        ON b.slot_id = s.id AND b.status = 'confirmed'
      ${provider !== undefined ? 'WHERE s.provider = ?' : ''}
      ORDER BY s.start_ms ASC, s.seq ASC
    `;
    const stmt = this.db.prepare(query);
    const rows = provider !== undefined ? stmt.all(provider) : stmt.all();
    return rows.map((r) => ({
      id: r.id,
      provider: r.provider,
      start: r.start,
      end: r.end,
      available: Boolean(r.available)
    }));
  }

  async createBooking({ body, idemKey }) {
    return this.mutex.run(async () => {
      const nowMs = Date.now();
      const bodyHash = hashRequestBody(body);

      // 1. Check Idempotency-Key first (Level 4)
      if (idemKey) {
        const existingIdem = this.db
          .prepare(`SELECT body_hash, status_code, response_json FROM idempotency_keys WHERE idem_key = ?`)
          .get(idemKey);

        if (existingIdem) {
          if (existingIdem.body_hash === bodyHash) {
            return {
              status: existingIdem.status_code,
              body: JSON.parse(existingIdem.response_json)
            };
          }
          return {
            status: 422,
            body: { error: 'Idempotency-Key reused with a different body' }
          };
        }
      }

      // 2. Rate limiting per email (Level 5): at most 5 attempts per email per minute, failed attempts included
      const rawEmail = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
      if (rawEmail) {
        const rl = this._checkAndRecordRateLimitSync(rawEmail, nowMs);
        if (rl.limited) {
          return {
            status: 429,
            headers: { 'Retry-After': String(rl.retryAfter) },
            body: { error: 'Too many attempts for this email' }
          };
        }
      }

      // Helper to save idempotency result and return
      const respond = (status, responseBody) => {
        if (idemKey) {
          this.db
            .prepare(`
              INSERT OR IGNORE INTO idempotency_keys (idem_key, body_hash, status_code, response_json, created_at_ms)
              VALUES (?, ?, ?, ?, ?)
            `)
            .run(idemKey, bodyHash, status, JSON.stringify(responseBody), nowMs);
        }
        return { status, body: responseBody };
      };

      // 3. Validate input fields (Level 2)
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return respond(400, { error: 'Invalid request body' });
      }

      const slotId = typeof body.slot_id === 'string' ? body.slot_id.trim() : '';
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';

      if (!slotId || !name || !email) {
        return respond(400, { error: 'slot_id, name, and email are required' });
      }

      if (!isValidEmail(email)) {
        return respond(400, { error: 'Invalid email address' });
      }

      // 4. Check slot existence and start time (Level 2)
      const slot = this.db
        .prepare(`SELECT id, provider, start_iso, end_iso, start_ms FROM slots WHERE id = ?`)
        .get(slotId);

      if (!slot) {
        return respond(404, { error: 'Slot not found' });
      }

      if (slot.start_ms <= nowMs) {
        return respond(400, { error: 'Slot has already started' });
      }

      // 5. Atomic booking creation (Level 3)
      this.db.exec('BEGIN IMMEDIATE');
      try {
        const existingBooking = this.db
          .prepare(`SELECT id FROM bookings WHERE slot_id = ? AND status = 'confirmed'`)
          .get(slotId);

        if (existingBooking) {
          this.db.exec('ROLLBACK');
          return respond(409, { error: 'Slot already booked' });
        }

        const bookingId = 'bk_' + crypto.randomUUID().replace(/-/g, '').slice(0, 16);
        const createdAt = new Date(nowMs).toISOString();

        this.db
          .prepare(`
            INSERT INTO bookings (id, slot_id, name, email, status, created_at)
            VALUES (?, ?, ?, ?, 'confirmed', ?)
          `)
          .run(bookingId, slotId, name, email, createdAt);

        const booking = {
          id: bookingId,
          slot_id: slotId,
          name,
          email,
          status: 'confirmed',
          created_at: createdAt
        };

        if (idemKey) {
          this.db
            .prepare(`
              INSERT INTO idempotency_keys (idem_key, body_hash, status_code, response_json, created_at_ms)
              VALUES (?, ?, ?, ?, ?)
            `)
            .run(idemKey, bodyHash, 201, JSON.stringify(booking), nowMs);
        }

        this.db.exec('COMMIT');
        return { status: 201, body: booking };
      } catch (err) {
        try {
          this.db.exec('ROLLBACK');
        } catch (_) {}
        if (String(err.message).includes('UNIQUE constraint failed')) {
          return respond(409, { error: 'Slot already booked' });
        }
        throw err;
      }
    });
  }

  _checkAndRecordRateLimitSync(email, nowMs) {
    const windowStartMs = nowMs - 60_000;
    const recent = this.db
      .prepare(`
        SELECT attempted_at_ms
        FROM rate_limits
        WHERE email = ? AND attempted_at_ms > ?
        ORDER BY attempted_at_ms ASC
      `)
      .all(email, windowStartMs);

    if (recent.length >= 5) {
      const oldestMs = Number(recent[0].attempted_at_ms);
      const retryAfter = Math.max(1, Math.ceil((oldestMs + 60_000 - nowMs) / 1000));
      return { limited: true, retryAfter };
    }

    this.db
      .prepare(`INSERT INTO rate_limits (email, attempted_at_ms) VALUES (?, ?)`)
      .run(email, nowMs);

    return { limited: false, retryAfter: 0 };
  }

  async getBookingById(id) {
    const row = this.db
      .prepare(`SELECT id, slot_id, name, email, status, created_at FROM bookings WHERE id = ?`)
      .get(id);
    if (!row) return null;
    return {
      id: row.id,
      slot_id: row.slot_id,
      name: row.name,
      email: row.email,
      status: row.status,
      created_at: row.created_at
    };
  }

  async cancelBooking(id) {
    return this.mutex.run(async () => {
      this.db.exec('BEGIN IMMEDIATE');
      try {
        const row = this.db
          .prepare(`SELECT id, slot_id, name, email, status, created_at FROM bookings WHERE id = ?`)
          .get(id);

        if (!row) {
          this.db.exec('ROLLBACK');
          return { status: 404, body: { error: 'No booking with that id' } };
        }

        if (row.status === 'cancelled') {
          this.db.exec('ROLLBACK');
          return { status: 409, body: { error: 'Already cancelled' } };
        }

        this.db
          .prepare(`UPDATE bookings SET status = 'cancelled' WHERE id = ?`)
          .run(id);

        this.db.exec('COMMIT');
        return {
          status: 200,
          body: {
            id: row.id,
            slot_id: row.slot_id,
            name: row.name,
            email: row.email,
            status: 'cancelled',
            created_at: row.created_at
          }
        };
      } catch (err) {
        try {
          this.db.exec('ROLLBACK');
        } catch (_) {}
        throw err;
      }
    });
  }

  async listBookingsByEmail({ email, limit, cursorSeq }) {
    const normalizedEmail = email.trim().toLowerCase();
    const rows = this.db
      .prepare(`
        SELECT seq, id, slot_id, name, email, status, created_at
        FROM bookings
        WHERE email = ? AND seq > ?
        ORDER BY seq ASC
        LIMIT ?
      `)
      .all(normalizedEmail, cursorSeq, limit + 1);

    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor = hasMore ? String(pageRows[pageRows.length - 1].seq) : null;

    return {
      bookings: pageRows.map((r) => ({
        id: r.id,
        slot_id: r.slot_id,
        name: r.name,
        email: r.email,
        status: r.status,
        created_at: r.created_at
      })),
      next_cursor: nextCursor
    };
  }
}

/**
 * PostgreSQL Storage Engine (for Serverless / Neon / Supabase / Render Postgres)
 */
class PostgresStorage {
  constructor(connectionString) {
    const { Pool } = require('pg');
    this.pool = new Pool({
      connectionString,
      ssl: connectionString.includes('localhost') || connectionString.includes('127.0.0.1')
        ? false
        : { rejectUnauthorized: false },
      max: 10
    });
    this._initPromise = null;
  }

  async ensureInit() {
    if (!this._initPromise) {
      this._initPromise = this._init().catch((err) => {
        this._initPromise = null;
        throw err;
      });
    }
    return this._initPromise;
  }

  async _init() {
    const client = await this.pool.connect();
    try {
      await client.query(`
        CREATE TABLE IF NOT EXISTS meta (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS slots (
          id TEXT PRIMARY KEY,
          provider TEXT NOT NULL,
          start_iso TEXT NOT NULL,
          end_iso TEXT NOT NULL,
          start_ms BIGINT NOT NULL,
          seq INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS bookings (
          seq BIGSERIAL PRIMARY KEY,
          id TEXT NOT NULL UNIQUE,
          slot_id TEXT NOT NULL,
          name TEXT NOT NULL,
          email TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('confirmed', 'cancelled')),
          created_at TEXT NOT NULL
        );

        CREATE UNIQUE INDEX IF NOT EXISTS idx_bookings_confirmed_slot
        ON bookings (slot_id)
        WHERE status = 'confirmed';

        CREATE INDEX IF NOT EXISTS idx_bookings_email_seq
        ON bookings (email, seq);

        CREATE TABLE IF NOT EXISTS idempotency_keys (
          idem_key TEXT PRIMARY KEY,
          body_hash TEXT NOT NULL,
          status_code INTEGER NOT NULL,
          response_json TEXT NOT NULL,
          created_at_ms BIGINT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS rate_limits (
          id BIGSERIAL PRIMARY KEY,
          email TEXT NOT NULL,
          attempted_at_ms BIGINT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_rate_limits_email_time
        ON rate_limits (email, attempted_at_ms);
      `);

      const { rows } = await client.query(`SELECT value FROM meta WHERE key = 'seeded'`);
      if (rows.length === 0) {
        await this._replaceSlotsWithClient(client, DEFAULT_SLOTS);
        await client.query(`INSERT INTO meta (key, value) VALUES ('seeded', '1') ON CONFLICT (key) DO NOTHING`);
      }
    } finally {
      client.release();
    }
  }

  async _replaceSlotsWithClient(client, slots) {
    await client.query('BEGIN');
    try {
      await client.query('DELETE FROM bookings');
      await client.query('DELETE FROM slots');
      await client.query('DELETE FROM idempotency_keys');
      await client.query('DELETE FROM rate_limits');

      for (let i = 0; i < slots.length; i++) {
        const slot = slots[i];
        const startMs = Date.parse(slot.start);
        await client.query(
          `INSERT INTO slots (id, provider, start_iso, end_iso, start_ms, seq) VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            String(slot.id),
            String(slot.provider),
            String(slot.start),
            String(slot.end),
            Number.isNaN(startMs) ? 0 : startMs,
            i
          ]
        );
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    }
  }

  async resetSlots(slots) {
    await this.ensureInit();
    const client = await this.pool.connect();
    try {
      await this._replaceSlotsWithClient(client, slots);
    } finally {
      client.release();
    }
  }

  async listSlots(provider) {
    await this.ensureInit();
    const params = [];
    let whereClause = '';
    if (provider !== undefined) {
      params.push(provider);
      whereClause = 'WHERE s.provider = $1';
    }
    const query = `
      SELECT
        s.id,
        s.provider,
        s.start_iso AS start,
        s.end_iso AS "end",
        CASE WHEN b.id IS NULL THEN true ELSE false END AS available
      FROM slots s
      LEFT JOIN bookings b
        ON b.slot_id = s.id AND b.status = 'confirmed'
      ${whereClause}
      ORDER BY s.start_ms ASC, s.seq ASC
    `;
    const { rows } = await this.pool.query(query, params);
    return rows.map((r) => ({
      id: r.id,
      provider: r.provider,
      start: r.start,
      end: r.end,
      available: Boolean(r.available)
    }));
  }

  async _checkAndRecordRateLimit(client, email, nowMs) {
    const windowStartMs = nowMs - 60_000;
    await client.query('BEGIN');
    try {
      // Advisory lock per email so concurrent requests for the same email serialize rate limit checks
      await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`rl:${email}`]);

      const { rows } = await client.query(
        `SELECT attempted_at_ms FROM rate_limits WHERE email = $1 AND attempted_at_ms > $2 ORDER BY attempted_at_ms ASC`,
        [email, windowStartMs]
      );

      if (rows.length >= 5) {
        await client.query('COMMIT');
        const oldestMs = Number(rows[0].attempted_at_ms);
        const retryAfter = Math.max(1, Math.ceil((oldestMs + 60_000 - nowMs) / 1000));
        return { limited: true, retryAfter };
      }

      await client.query(
        `INSERT INTO rate_limits (email, attempted_at_ms) VALUES ($1, $2)`,
        [email, nowMs]
      );
      await client.query('COMMIT');
      return { limited: false, retryAfter: 0 };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    }
  }

  async createBooking({ body, idemKey }) {
    await this.ensureInit();
    const nowMs = Date.now();
    const bodyHash = hashRequestBody(body);

    const client = await this.pool.connect();
    let hasIdemLock = false;
    try {
      // Hold session advisory lock across the entire request when Idempotency-Key is present
      if (idemKey) {
        await client.query(`SELECT pg_advisory_lock(hashtext($1))`, [`idem:${idemKey}`]);
        hasIdemLock = true;

        const { rows: idemRows } = await client.query(
          `SELECT body_hash, status_code, response_json FROM idempotency_keys WHERE idem_key = $1`,
          [idemKey]
        );
        if (idemRows.length > 0) {
          const existingIdem = idemRows[0];
          if (existingIdem.body_hash === bodyHash) {
            return {
              status: existingIdem.status_code,
              body: JSON.parse(existingIdem.response_json)
            };
          }
          return {
            status: 422,
            body: { error: 'Idempotency-Key reused with a different body' }
          };
        }
      }

      // 2. Rate limiting per email (Level 5)
      const rawEmail = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
      if (rawEmail) {
        const rl = await this._checkAndRecordRateLimit(client, rawEmail, nowMs);
        if (rl.limited) {
          return {
            status: 429,
            headers: { 'Retry-After': String(rl.retryAfter) },
            body: { error: 'Too many attempts for this email' }
          };
        }
      }

      const saveIdemAndRespond = async (status, responseBody) => {
        if (idemKey) {
          await client.query(
            `INSERT INTO idempotency_keys (idem_key, body_hash, status_code, response_json, created_at_ms)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (idem_key) DO NOTHING`,
            [idemKey, bodyHash, status, JSON.stringify(responseBody), nowMs]
          );
        }
        return { status, body: responseBody };
      };

      // 3. Validate input fields (Level 2)
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return await saveIdemAndRespond(400, { error: 'Invalid request body' });
      }

      const slotId = typeof body.slot_id === 'string' ? body.slot_id.trim() : '';
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';

      if (!slotId || !name || !email) {
        return await saveIdemAndRespond(400, { error: 'slot_id, name, and email are required' });
      }

      if (!isValidEmail(email)) {
        return await saveIdemAndRespond(400, { error: 'Invalid email address' });
      }

      // 4. Atomic transaction for slot check + booking creation
      await client.query('BEGIN');
      try {
        // Lock slot row with FOR UPDATE so concurrent bookings for this slot serialize cleanly
        const { rows: slotRows } = await client.query(
          `SELECT id, provider, start_iso, end_iso, start_ms FROM slots WHERE id = $1 FOR UPDATE`,
          [slotId]
        );

        if (slotRows.length === 0) {
          await client.query('COMMIT');
          return await saveIdemAndRespond(404, { error: 'Slot not found' });
        }

        const slot = slotRows[0];
        if (Number(slot.start_ms) <= nowMs) {
          await client.query('COMMIT');
          return await saveIdemAndRespond(400, { error: 'Slot has already started' });
        }

        const { rows: existingRows } = await client.query(
          `SELECT id FROM bookings WHERE slot_id = $1 AND status = 'confirmed'`,
          [slotId]
        );

        if (existingRows.length > 0) {
          await client.query('COMMIT');
          return await saveIdemAndRespond(409, { error: 'Slot already booked' });
        }

        const bookingId = 'bk_' + crypto.randomUUID().replace(/-/g, '').slice(0, 16);
        const createdAt = new Date(nowMs).toISOString();

        await client.query(
          `INSERT INTO bookings (id, slot_id, name, email, status, created_at)
           VALUES ($1, $2, $3, $4, 'confirmed', $5)`,
          [bookingId, slotId, name, email, createdAt]
        );

        const booking = {
          id: bookingId,
          slot_id: slotId,
          name,
          email,
          status: 'confirmed',
          created_at: createdAt
        };

        if (idemKey) {
          await client.query(
            `INSERT INTO idempotency_keys (idem_key, body_hash, status_code, response_json, created_at_ms)
             VALUES ($1, $2, $3, $4, $5)`,
            [idemKey, bodyHash, 201, JSON.stringify(booking), nowMs]
          );
        }

        await client.query('COMMIT');
        return { status: 201, body: booking };
      } catch (err) {
        await client.query('ROLLBACK');
        if (err.code === '23505') {
          return await saveIdemAndRespond(409, { error: 'Slot already booked' });
        }
        throw err;
      }
    } finally {
      if (hasIdemLock) {
        try {
          await client.query(`SELECT pg_advisory_unlock(hashtext($1))`, [`idem:${idemKey}`]);
        } catch (_) {}
      }
      client.release();
    }
  }

  async getBookingById(id) {
    await this.ensureInit();
    const { rows } = await this.pool.query(
      `SELECT id, slot_id, name, email, status, created_at FROM bookings WHERE id = $1`,
      [id]
    );
    if (rows.length === 0) return null;
    const row = rows[0];
    return {
      id: row.id,
      slot_id: row.slot_id,
      name: row.name,
      email: row.email,
      status: row.status,
      created_at: row.created_at
    };
  }

  async cancelBooking(id) {
    await this.ensureInit();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(
        `SELECT id, slot_id, name, email, status, created_at FROM bookings WHERE id = $1 FOR UPDATE`,
        [id]
      );

      if (rows.length === 0) {
        await client.query('ROLLBACK');
        return { status: 404, body: { error: 'No booking with that id' } };
      }

      const row = rows[0];
      if (row.status === 'cancelled') {
        await client.query('ROLLBACK');
        return { status: 409, body: { error: 'Already cancelled' } };
      }

      await client.query(`UPDATE bookings SET status = 'cancelled' WHERE id = $1`, [id]);
      await client.query('COMMIT');

      return {
        status: 200,
        body: {
          id: row.id,
          slot_id: row.slot_id,
          name: row.name,
          email: row.email,
          status: 'cancelled',
          created_at: row.created_at
        }
      };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async listBookingsByEmail({ email, limit, cursorSeq }) {
    await this.ensureInit();
    const normalizedEmail = email.trim().toLowerCase();
    const { rows } = await this.pool.query(
      `SELECT seq, id, slot_id, name, email, status, created_at
       FROM bookings
       WHERE email = $1 AND seq > $2
       ORDER BY seq ASC
       LIMIT $3`,
      [normalizedEmail, cursorSeq, limit + 1]
    );

    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor = hasMore ? String(pageRows[pageRows.length - 1].seq) : null;

    return {
      bookings: pageRows.map((r) => ({
        id: r.id,
        slot_id: r.slot_id,
        name: r.name,
        email: r.email,
        status: r.status,
        created_at: r.created_at
      })),
      next_cursor: nextCursor
    };
  }
}

function createStorage(options = {}) {
  const databaseUrl = options.databaseUrl ?? process.env.DATABASE_URL;
  if (databaseUrl) {
    return new PostgresStorage(databaseUrl);
  }
  const sqlitePath =
    options.sqlitePath ??
    process.env.SQLITE_PATH ??
    path.join(__dirname, '..', 'data', 'clinic.sqlite');
  return new SqliteStorage(sqlitePath);
}

module.exports = {
  createStorage,
  SqliteStorage,
  PostgresStorage,
  isValidEmail,
  hashRequestBody,
  DEFAULT_SLOTS
};
