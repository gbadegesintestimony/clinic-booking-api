const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createApp } = require('../src/app');
const { SqliteStorage } = require('../src/db');

const TEST_API_KEY = 'test-secret-api-key';

describe('Clinic Booking API (Levels 1-5) & Web Page', () => {
  let server;
  let baseUrl;

  before(async () => {
    const storage = new SqliteStorage(':memory:');
    const app = createApp({ storage, apiKey: TEST_API_KEY });
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  after(async () => {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  async function req(path, options = {}) {
    const headers = {
      ...(options.apiKey !== false ? { 'X-API-Key': options.apiKey || TEST_API_KEY } : {}),
      ...(options.headers || {})
    };
    if (options.body !== undefined && !headers['Content-Type']) {
      headers['Content-Type'] = 'application/json';
    }
    const res = await fetch(`${baseUrl}${path}`, {
      method: options.method || 'GET',
      headers,
      body:
        options.body !== undefined
          ? typeof options.body === 'string'
            ? options.body
            : JSON.stringify(options.body)
          : undefined
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch (_) {}
    return { status: res.status, headers: res.headers, json, text };
  }

  it('serves the web page at GET / without requiring X-API-Key', async () => {
    const res = await req('/', { apiKey: false });
    assert.equal(res.status, 200);
    assert.ok(res.text.includes('Koya Clinic Appointment Portal'));
  });

  it('Level 2: enforces X-API-Key authentication (401 on missing or wrong key)', async () => {
    const missing = await req('/slots', { apiKey: false });
    assert.equal(missing.status, 401);
    assert.equal(typeof missing.json?.error, 'string');

    const wrong = await req('/slots', { apiKey: 'wrong-key' });
    assert.equal(wrong.status, 401);
    assert.equal(typeof wrong.json?.error, 'string');
  });

  it('Level 1: POST /reset replaces slots and GET /slots lists them earliest start first with provider filter', async () => {
    const slots = [
      {
        id: 's2',
        provider: 'Dr Bello',
        start: '2027-06-15T11:00:00Z',
        end: '2027-06-15T11:30:00Z'
      },
      {
        id: 's1',
        provider: 'Dr Ade',
        start: '2027-06-15T09:00:00Z',
        end: '2027-06-15T09:30:00Z'
      },
      {
        id: 's_past',
        provider: 'Dr Ade',
        start: '2020-01-01T09:00:00Z',
        end: '2020-01-01T09:30:00Z'
      }
    ];

    const resetRes = await req('/reset', { method: 'POST', body: { slots } });
    assert.equal(resetRes.status, 200);

    const listRes = await req('/slots');
    assert.equal(listRes.status, 200);
    assert.deepEqual(
      listRes.json.slots.map((s) => s.id),
      ['s_past', 's1', 's2']
    );
    assert.equal(listRes.json.slots[1].available, true);

    const filteredRes = await req('/slots?provider=Dr%20Bello');
    assert.equal(filteredRes.status, 200);
    assert.equal(filteredRes.json.slots.length, 1);
    assert.equal(filteredRes.json.slots[0].id, 's2');
  });

  it('Level 1 & Level 2: books a slot, trims name/email, lowercases email, marks slot unavailable, and looks up booking', async () => {
    const bookRes = await req('/bookings', {
      method: 'POST',
      body: {
        slot_id: 's1',
        name: '  Ada Obi  ',
        email: '  Ada.Obi@Example.COM '
      }
    });

    assert.equal(bookRes.status, 201);
    assert.ok(bookRes.json.id);
    assert.equal(bookRes.json.slot_id, 's1');
    assert.equal(bookRes.json.name, 'Ada Obi');
    assert.equal(bookRes.json.email, 'ada.obi@example.com');
    assert.equal(bookRes.json.status, 'confirmed');
    assert.ok(!Number.isNaN(Date.parse(bookRes.json.created_at)));

    // Check slot is now unavailable
    const slotsRes = await req('/slots?provider=Dr%20Ade');
    const s1 = slotsRes.json.slots.find((s) => s.id === 's1');
    assert.equal(s1.available, false);

    // Look up booking by ID
    const getRes = await req(`/bookings/${bookRes.json.id}`);
    assert.equal(getRes.status, 200);
    assert.deepEqual(getRes.json, bookRes.json);

    // Non-existent booking ID returns 404
    const notFoundRes = await req('/bookings/non-existent-id');
    assert.equal(notFoundRes.status, 404);
    assert.equal(typeof notFoundRes.json?.error, 'string');
  });

  it('Level 2: rejects invalid or missing fields (400), non-existent slots (404), and past slots (400)', async () => {
    const missingName = await req('/bookings', {
      method: 'POST',
      body: { slot_id: 's2', name: '   ', email: 'user1@example.com' }
    });
    assert.equal(missingName.status, 400);

    const invalidEmail = await req('/bookings', {
      method: 'POST',
      body: { slot_id: 's2', name: 'Ada', email: 'not-an-email' }
    });
    assert.equal(invalidEmail.status, 400);

    const unknownSlot = await req('/bookings', {
      method: 'POST',
      body: { slot_id: 'does_not_exist', name: 'Ada', email: 'user2@example.com' }
    });
    assert.equal(unknownSlot.status, 404);

    const pastSlot = await req('/bookings', {
      method: 'POST',
      body: { slot_id: 's_past', name: 'Ada', email: 'user3@example.com' }
    });
    assert.equal(pastSlot.status, 400);
  });

  it('Level 3: prevents double-booking under high concurrency and supports cancellation', async () => {
    await req('/reset', {
      method: 'POST',
      body: {
        slots: [
          {
            id: 's_race',
            provider: 'Dr Ade',
            start: '2027-07-01T10:00:00Z',
            end: '2027-07-01T10:30:00Z'
          }
        ]
      }
    });

    // Fire 10 simultaneous requests for the exact same slot
    const attempts = Array.from({ length: 10 }, (_, idx) =>
      req('/bookings', {
        method: 'POST',
        body: {
          slot_id: 's_race',
          name: `Patient ${idx}`,
          email: `patient${idx}@example.com`
        }
      })
    );

    const results = await Promise.all(attempts);
    const created = results.filter((r) => r.status === 201);
    const conflicts = results.filter((r) => r.status === 409);

    assert.equal(created.length, 1, 'Exactly one concurrent request must succeed with 201');
    assert.equal(conflicts.length, 9, 'All other 9 concurrent requests must return 409');

    const winningBooking = created[0].json;

    // Cancel the booking
    const delRes = await req(`/bookings/${winningBooking.id}`, { method: 'DELETE' });
    assert.equal(delRes.status, 200);
    assert.equal(delRes.json.status, 'cancelled');
    assert.equal(delRes.json.id, winningBooking.id);

    // Cancelling again returns 409
    const delAgain = await req(`/bookings/${winningBooking.id}`, { method: 'DELETE' });
    assert.equal(delAgain.status, 409);

    // Cancelling unknown booking returns 404
    const delUnknown = await req('/bookings/unknown-id', { method: 'DELETE' });
    assert.equal(delUnknown.status, 404);

    // Slot is now free and can be booked again
    const rebookRes = await req('/bookings', {
      method: 'POST',
      body: {
        slot_id: 's_race',
        name: 'New Patient',
        email: 'newpatient@example.com'
      }
    });
    assert.equal(rebookRes.status, 201);
  });

  it('Level 4: handles Idempotency-Key retries (201) and body mismatch (422)', async () => {
    await req('/reset', {
      method: 'POST',
      body: {
        slots: [
          { id: 's1', provider: 'Dr Ade', start: '2027-08-01T09:00:00Z', end: '2027-08-01T09:30:00Z' },
          { id: 's2', provider: 'Dr Ade', start: '2027-08-01T10:00:00Z', end: '2027-08-01T10:30:00Z' }
        ]
      }
    });

    const payload = { slot_id: 's1', name: 'Ada Obi', email: 'ada@example.com' };

    const first = await req('/bookings', {
      method: 'POST',
      headers: { 'Idempotency-Key': 'idem-key-123' },
      body: payload
    });
    assert.equal(first.status, 201);

    // Retry with same key and same body -> returns exact same 201 response and booking id
    const second = await req('/bookings', {
      method: 'POST',
      headers: { 'Idempotency-Key': 'idem-key-123' },
      body: payload
    });
    assert.equal(second.status, 201);
    assert.deepEqual(second.json, first.json);

    // Reuse same key with different body -> 422
    const mismatch = await req('/bookings', {
      method: 'POST',
      headers: { 'Idempotency-Key': 'idem-key-123' },
      body: { slot_id: 's2', name: 'Ada Obi', email: 'ada@example.com' }
    });
    assert.equal(mismatch.status, 422);
    assert.equal(typeof mismatch.json?.error, 'string');
  });

  it('Level 4: cursor pagination for GET /bookings?email=... (oldest first, case-insensitive)', async () => {
    await req('/reset', {
      method: 'POST',
      body: {
        slots: [
          { id: 's1', provider: 'Dr Ade', start: '2027-09-01T09:00:00Z', end: '2027-09-01T09:30:00Z' },
          { id: 's2', provider: 'Dr Ade', start: '2027-09-01T10:00:00Z', end: '2027-09-01T10:30:00Z' },
          { id: 's3', provider: 'Dr Ade', start: '2027-09-01T11:00:00Z', end: '2027-09-01T11:30:00Z' }
        ]
      }
    });

    const b1 = (await req('/bookings', {
      method: 'POST',
      body: { slot_id: 's1', name: 'Ada Obi', email: 'ada@example.com' }
    })).json;
    const b2 = (await req('/bookings', {
      method: 'POST',
      body: { slot_id: 's2', name: 'Ada Obi', email: 'ADA@EXAMPLE.COM' }
    })).json;
    const b3 = (await req('/bookings', {
      method: 'POST',
      body: { slot_id: 's3', name: 'Ada Obi', email: 'Ada@Example.com' }
    })).json;

    // Invalid limits return 400
    assert.equal((await req('/bookings?email=ada@example.com&limit=0')).status, 400);
    assert.equal((await req('/bookings?email=ada@example.com&limit=51')).status, 400);
    assert.equal((await req('/bookings?email=ada@example.com&limit=abc')).status, 400);

    // Page 1 (limit=2)
    const page1 = await req('/bookings?email=ADA@example.com&limit=2');
    assert.equal(page1.status, 200);
    assert.deepEqual(
      page1.json.bookings.map((b) => b.id),
      [b1.id, b2.id]
    );
    assert.ok(page1.json.next_cursor);

    // Page 2 using cursor
    const page2 = await req(
      `/bookings?email=ada@example.com&limit=2&cursor=${encodeURIComponent(page1.json.next_cursor)}`
    );
    assert.equal(page2.status, 200);
    assert.deepEqual(
      page2.json.bookings.map((b) => b.id),
      [b3.id]
    );
    assert.equal(page2.json.next_cursor, null);
  });

  it('Level 5: enforces rate limit of 5 attempts per email per minute (failed attempts included) and returns 429 with Retry-After', async () => {
    await req('/reset', {
      method: 'POST',
      body: {
        slots: [
          { id: 's1', provider: 'Dr Ade', start: '2027-10-01T09:00:00Z', end: '2027-10-01T09:30:00Z' }
        ]
      }
    });

    // Attempt 1: succeeds (201)
    const a1 = await req('/bookings', {
      method: 'POST',
      body: { slot_id: 's1', name: 'Ada', email: 'spammer@example.com' }
    });
    assert.equal(a1.status, 201);

    // Attempts 2..5: failed attempts (409 conflict & 404 not found) still count
    for (let i = 2; i <= 5; i++) {
      const res = await req('/bookings', {
        method: 'POST',
        body: {
          slot_id: i % 2 === 0 ? 's1' : 'missing_slot',
          name: 'Ada',
          email: 'spammer@example.com'
        }
      });
      assert.ok(res.status === 409 || res.status === 404);
    }

    // Attempt 6: returns 429 with Retry-After header in whole seconds
    const a6 = await req('/bookings', {
      method: 'POST',
      body: { slot_id: 's1', name: 'Ada', email: 'spammer@example.com' }
    });
    assert.equal(a6.status, 429);
    assert.equal(typeof a6.json?.error, 'string');
    const retryAfter = a6.headers.get('Retry-After');
    assert.ok(retryAfter !== null, 'Retry-After header must be present');
    assert.ok(/^\d+$/.test(retryAfter), `Retry-After must be whole seconds, got: ${retryAfter}`);
    assert.ok(Number(retryAfter) >= 1 && Number(retryAfter) <= 60);

    // Other emails are not affected
    const otherRes = await req('/bookings', {
      method: 'POST',
      body: { slot_id: 's1', name: 'Other Person', email: 'other@example.com' }
    });
    assert.equal(otherRes.status, 409); // Reached slot check instead of 429
  });
});
