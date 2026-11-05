const http = require('node:http');
const path = require('node:path');
const os = require('node:os');
const { createApp, DEFAULT_API_KEY } = require('./app');

if (!process.env.DATABASE_URL && !process.env.SQLITE_PATH && process.env.VERCEL) {
  process.env.SQLITE_PATH = path.join(os.tmpdir(), 'clinic.sqlite');
}

const PORT = Number(process.env.PORT) || 3000;
const app = createApp();

if (!process.env.VERCEL) {
  const server = http.createServer(app);
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`Clinic Booking API & Web App listening on http://localhost:${PORT}`);
    console.log(`Configured X-API-Key: ${process.env.API_KEY || DEFAULT_API_KEY}`);
  });
}

module.exports = app;
