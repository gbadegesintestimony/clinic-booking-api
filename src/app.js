const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createStorage } = require('./db');
const bundledStatic = require('./static');

const DEFAULT_API_KEY = process.env.API_KEY || 'koya-clinic-key-2026';

function sendJson(res, statusCode, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-API-Key, Idempotency-Key',
    'Access-Control-Expose-Headers': 'Retry-After',
    'Cache-Control': 'no-store',
    ...extraHeaders
  });
  res.end(body);
}

function sendStaticFile(res, filePath, contentType, replacements = null, fallbackText = null) {
  try {
    let text;
    if (fs.existsSync(filePath)) {
      text = fs.readFileSync(filePath, 'utf8');
    } else if (fallbackText !== null) {
      text = fallbackText;
    } else {
      return sendJson(res, 404, { error: 'File not found' });
    }
    if (replacements && typeof contentType === 'string' && contentType.includes('text/html')) {
      for (const [k, v] of Object.entries(replacements)) {
        text = text.replaceAll(k, v);
      }
    }
    const content = Buffer.from(text, 'utf8');
    res.writeHead(200, {
      'Content-Type': contentType,
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-cache'
    });
    res.end(content);
  } catch (err) {
    sendJson(res, 404, { error: 'File not found' });
  }
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    // Support pre-parsed body (e.g. serverless environments)
    try {
      if (req.body !== undefined) {
        if (typeof req.body === 'string') {
          if (req.body.trim() === '') return resolve({});
          return resolve(JSON.parse(req.body));
        }
        if (Buffer.isBuffer(req.body)) {
          return resolve(JSON.parse(req.body.toString('utf8')));
        }
        if (typeof req.body === 'object') {
          return resolve(req.body);
        }
      }
    } catch (err) {
      return reject(new Error('Invalid JSON'));
    }

    const chunks = [];
    let totalBytes = 0;
    const MAX_BYTES = 2 * 1024 * 1024; // 2MB

    req.on('data', (chunk) => {
      totalBytes += chunk.length;
      if (totalBytes > MAX_BYTES) {
        reject(new Error('Payload too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) {
        return resolve(null);
      }
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(new Error('Invalid JSON'));
      }
    });

    req.on('error', (err) => reject(err));
  });
}

function createApp(options = {}) {
  const storage = options.storage || createStorage(options);
  const apiKey = options.apiKey || process.env.API_KEY || DEFAULT_API_KEY;
  const publicDir = path.join(__dirname, '..', 'public');

  return async function handleRequest(req, res) {
    try {
      // Handle CORS preflight
      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, X-API-Key, Idempotency-Key',
          'Access-Control-Expose-Headers': 'Retry-After',
          'Access-Control-Max-Age': '86400'
        });
        return res.end();
      }

      const host = req.headers.host || 'localhost';
      const url = new URL(req.url || '/', `http://${host}`);
      const rawPathname = url.pathname;
      const pathname =
        rawPathname.length > 1 && rawPathname.endsWith('/')
          ? rawPathname.slice(0, -1)
          : rawPathname;

      // Public Web UI & Health endpoints (do not require X-API-Key so browsers can load the page)
      if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
        return sendStaticFile(
          res,
          path.join(publicDir, 'index.html'),
          'text/html; charset=utf-8',
          { 'koya-clinic-key-2026': apiKey },
          bundledStatic.html
        );
      }
      if (req.method === 'GET' && pathname === '/styles.css') {
        return sendStaticFile(
          res,
          path.join(publicDir, 'styles.css'),
          'text/css; charset=utf-8',
          null,
          bundledStatic.css
        );
      }
      if (req.method === 'GET' && pathname === '/app.js') {
        return sendStaticFile(
          res,
          path.join(publicDir, 'app.js'),
          'application/javascript; charset=utf-8',
          null,
          bundledStatic.js
        );
      }
      if (req.method === 'GET' && pathname === '/health') {
        return sendJson(res, 200, { status: 'ok' });
      }
      if (req.method === 'GET' && (pathname === '/favicon.ico' || pathname === '/favicon.png')) {
        res.writeHead(204);
        return res.end();
      }

      // Level 2: Authenticate all API endpoints via X-API-Key header
      const providedKey = req.headers['x-api-key'];
      if (!providedKey || providedKey !== apiKey) {
        return sendJson(res, 401, { error: 'Missing or invalid X-API-Key' });
      }

      // POST /reset (Level 1: Replace all slots and delete every booking)
      if (req.method === 'POST' && pathname === '/reset') {
        let body;
        try {
          body = await readJsonBody(req);
        } catch (err) {
          return sendJson(res, 400, { error: 'Invalid JSON body' });
        }

        if (!body || typeof body !== 'object' || !Array.isArray(body.slots)) {
          return sendJson(res, 400, { error: 'Request body must contain a "slots" array' });
        }

        for (const s of body.slots) {
          if (
            !s ||
            typeof s !== 'object' ||
            typeof s.id !== 'string' ||
            !s.id.trim() ||
            typeof s.provider !== 'string' ||
            !s.provider.trim() ||
            typeof s.start !== 'string' ||
            Number.isNaN(Date.parse(s.start)) ||
            typeof s.end !== 'string' ||
            Number.isNaN(Date.parse(s.end))
          ) {
            return sendJson(res, 400, {
              error: 'Each slot must include valid id, provider, start, and end fields'
            });
          }
        }

        await storage.resetSlots(body.slots);
        return sendJson(res, 200, { ok: true });
      }

      // GET /slots (Level 1: List slots, earliest start first)
      if (req.method === 'GET' && pathname === '/slots') {
        const provider = url.searchParams.has('provider')
          ? url.searchParams.get('provider')
          : undefined;
        const slots = await storage.listSlots(provider);
        return sendJson(res, 200, { slots });
      }

      // POST /bookings (Levels 1-5: Book a slot)
      if (req.method === 'POST' && pathname === '/bookings') {
        let body;
        try {
          body = await readJsonBody(req);
        } catch (err) {
          return sendJson(res, 400, { error: 'Invalid JSON body' });
        }

        const rawIdem = req.headers['idempotency-key'];
        const idemKey =
          typeof rawIdem === 'string' && rawIdem.trim() !== '' ? rawIdem.trim() : null;

        const result = await storage.createBooking({ body, idemKey });
        return sendJson(res, result.status, result.body, result.headers || {});
      }

      // GET /bookings (Level 4: List a person's bookings with cursor pagination)
      if (req.method === 'GET' && pathname === '/bookings') {
        const rawEmail = url.searchParams.get('email');
        if (!rawEmail || rawEmail.trim() === '') {
          return sendJson(res, 400, { error: 'email query parameter is required' });
        }

        let limit = 10;
        if (url.searchParams.has('limit')) {
          const rawLimit = url.searchParams.get('limit');
          if (!/^\d+$/.test(rawLimit)) {
            return sendJson(res, 400, { error: 'limit must be an integer between 1 and 50' });
          }
          limit = Number(rawLimit);
          if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
            return sendJson(res, 400, { error: 'limit must be between 1 and 50' });
          }
        }

        let cursorSeq = 0;
        if (url.searchParams.has('cursor')) {
          const rawCursor = url.searchParams.get('cursor');
          if (rawCursor !== '' && rawCursor !== null) {
            if (!/^\d+$/.test(rawCursor)) {
              return sendJson(res, 400, { error: 'Invalid cursor' });
            }
            cursorSeq = Number(rawCursor);
          }
        }

        const page = await storage.listBookingsByEmail({
          email: rawEmail,
          limit,
          cursorSeq
        });
        return sendJson(res, 200, page);
      }

      // GET /bookings/{id} (Level 1) & DELETE /bookings/{id} (Level 3)
      const bookingMatch = pathname.match(/^\/bookings\/([^/]+)$/);
      if (bookingMatch) {
        let bookingId;
        try {
          bookingId = decodeURIComponent(bookingMatch[1]);
        } catch (_) {
          bookingId = bookingMatch[1];
        }

        if (req.method === 'GET') {
          const booking = await storage.getBookingById(bookingId);
          if (!booking) {
            return sendJson(res, 404, { error: 'No booking with that id' });
          }
          return sendJson(res, 200, booking);
        }

        if (req.method === 'DELETE') {
          const result = await storage.cancelBooking(bookingId);
          return sendJson(res, result.status, result.body);
        }
      }

      return sendJson(res, 404, { error: 'Endpoint not found' });
    } catch (err) {
      console.error('Unhandled request error:', err);
      return sendJson(res, 500, { error: 'Internal server error' });
    }
  };
}

if (!process.env.DATABASE_URL && !process.env.SQLITE_PATH && process.env.VERCEL) {
  process.env.SQLITE_PATH = path.join(os.tmpdir(), 'clinic.sqlite');
}

let _defaultHandler = null;
function defaultApp(req, res) {
  if (!_defaultHandler) {
    _defaultHandler = createApp();
  }
  return _defaultHandler(req, res);
}

defaultApp.createApp = createApp;
defaultApp.DEFAULT_API_KEY = DEFAULT_API_KEY;
defaultApp.default = defaultApp;

module.exports = defaultApp;

