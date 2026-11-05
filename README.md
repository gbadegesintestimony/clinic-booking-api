# Koya Clinic Booking API & Web Portal (Task 1 · Levels 1–5)

A complete implementation of the **Koya Cohort 4 Assessment — Task 1 (Clinic Booking API & Web App)** matching the OpenAPI 3.0.3 contract at `https://koyaacademy.com/assessment-api/openapi.json`.

## Features & Levels Implemented

- **Level 1 — Core Booking & Slot Management**
  - `POST /reset`: Deletes every booking and replaces all slots (including past slots), resetting idempotency and rate-limit state.
  - `GET /slots`: Lists every slot ordered earliest `start` first, with `available` boolean (`false` while a confirmed booking exists) and optional exact-match `?provider=` filter.
  - `POST /bookings`: Books a slot and returns `201` with `{ id, slot_id, name, email, status: "confirmed", created_at }`.
  - `GET /bookings/{id}`: Looks up a booking by ID (`200`) or returns `404` (`{"error": "..."}`).
- **Level 2 — Authentication & Input Validation**
  - Requires `X-API-Key` header on all API endpoints (`401` on missing or wrong key).
  - Trims spaces from `name` and `email`, and stores `email` in lowercase.
  - Returns `400` if `slot_id`, `name`, or `email` is missing/empty or `email` is invalid.
  - Returns `404` if the slot does not exist.
  - Returns `400` if the slot has already started (`start <= now`).
- **Level 3 — Concurrency Control & Cancellation**
  - Enforces atomic slot reservation via database transactions + partial unique index (`WHERE status = 'confirmed'`), guaranteeing two concurrent requests for the same slot never both succeed (`409` on conflict).
  - `DELETE /bookings/{id}`: Sets `status` to `cancelled` and frees the slot (`200`), or returns `404` if not found / `409` if already cancelled.
- **Level 4 — Idempotency & Cursor Pagination**
  - Supports `Idempotency-Key` header on `POST /bookings`: same key + same body returns the original response without creating a duplicate booking; same key + different body returns `422`.
  - `GET /bookings?email=...&limit=...&cursor=...`: Case-insensitive email match, ordered oldest first, cursor pagination (`next_cursor: null` on last page), and strict `limit` validation (`1` to `50`, otherwise `400`).
- **Level 5 — Anti-Spam Rate Limiting**
  - Enforces at most 5 booking attempts per email per minute on `POST /bookings` (failed attempts included).
  - The 6th attempt within 60 seconds returns `429` with a `Retry-After` header in whole seconds. Other emails are unaffected.
- **Web Frontend (`GET /`)**
  - Served at the root URL (`/`): browse available slots, filter by provider, book an appointment, view the confirmation receipt modal/card, cancel bookings, and search/paginate bookings by email.

## Configuration

| Environment Variable | Default | Description |
| :--- | :--- | :--- |
| `PORT` | `3000` | HTTP server port |
| `API_KEY` | `koya-clinic-key-2026` | Required `X-API-Key` header value |
| `DATABASE_URL` | *(optional)* | PostgreSQL connection URL (Neon / Supabase / Render Postgres). Falls back to built-in persistent SQLite (`data/clinic.sqlite`) when unset. |

## Running Locally

```bash
npm install
npm test
npm start
```
