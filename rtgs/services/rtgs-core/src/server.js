'use strict';
const { createPool, migrate, seed } = require('./db');
const { createApp } = require('./app');

async function main() {
  const url = process.env.DATABASE_URL;
  const token = process.env.INTERNAL_TOKEN;
  if (!url || !token) { console.error('DATABASE_URL and INTERNAL_TOKEN are required'); process.exit(1); }

  const pool = createPool(url);
  for (let i = 1; ; i++) {           // wait for the database (compose also gates on a healthcheck)
    try { await pool.query('SELECT 1'); break; }
    catch (e) { if (i >= 30) throw e; await new Promise((r) => setTimeout(r, 1000)); }
  }
  await migrate(pool);
  if (process.env.SEED_BANKS !== 'false') await seed(pool);

  const app = createApp(pool, {
    internalToken: token,
    allowReset: process.env.ALLOW_RESET === 'true',
    gitSha: process.env.GIT_SHA || 'dev',
  });
  const port = Number(process.env.PORT || 4000);
  const server = app.listen(port, () => console.log(JSON.stringify({ level: 'info', msg: 'rtgs-core listening', port })));

  // Graceful shutdown: stop taking requests, let in-flight settlements finish, then close the pool.
  const stop = (sig) => {
    console.log(JSON.stringify({ level: 'info', msg: 'shutting down', sig }));
    server.close(async () => { await pool.end().catch(() => {}); process.exit(0); });
    setTimeout(() => process.exit(1), 10000).unref();
  };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));
}
main().catch((e) => { console.error(e); process.exit(1); });
