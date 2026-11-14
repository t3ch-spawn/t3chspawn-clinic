import { createApp } from './app.js';
import { readConfig } from './config.js';
import { createPool } from './database.js';
import { bookingStore } from './bookings.js';

const config = readConfig();
const pool = createPool(config);
pool.on('error', err => console.error('Database connection error:', err.code));
const app = createApp({ store: bookingStore(pool), apiKey: config.API_KEY, production: config.NODE_ENV === 'production' });
const server = app.listen(config.PORT, () => console.log(`Clinic API listening on http://localhost:${config.PORT}`));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  server.close(() => pool.end().then(() => process.exit(0)));
  setTimeout(() => process.exit(1), 10000).unref();
});
