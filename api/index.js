const path = require('node:path');
const os = require('node:os');
const { createApp } = require('../src/app');

// On serverless platforms without DATABASE_URL, fall back to /tmp/clinic.sqlite
if (!process.env.DATABASE_URL && !process.env.SQLITE_PATH) {
  process.env.SQLITE_PATH = path.join(os.tmpdir(), 'clinic.sqlite');
}

const app = createApp();

module.exports = (req, res) => app(req, res);
