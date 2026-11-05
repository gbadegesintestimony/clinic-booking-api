const http = require('node:http');
const { createApp, DEFAULT_API_KEY } = require('./app');

const PORT = Number(process.env.PORT) || 3000;
const app = createApp();
const server = http.createServer(app);

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Clinic Booking API & Web App listening on http://localhost:${PORT}`);
  console.log(`Configured X-API-Key: ${process.env.API_KEY || DEFAULT_API_KEY}`);
});
