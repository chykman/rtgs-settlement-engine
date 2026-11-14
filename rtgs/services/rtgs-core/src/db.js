'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { Pool, types } = require('pg');

// BIGINT -> JS number. Fine for a simulation (safe up to 9e15 minor units).
types.setTypeParser(20, (v) => parseInt(v, 10));

function createPool(connectionString) {
  return new Pool({ connectionString, max: Number(process.env.PG_POOL_MAX || 20) });
}

async function migrate(pool) {
  const dir = path.join(__dirname, '..', 'migrations');
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock(7001)');      // one migrator at a time
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) {
      await client.query(fs.readFileSync(path.join(dir, f), 'utf8'));
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock(7001)').catch(() => {});
    client.release();
  }
}

const DEFAULT_BANKS = [
  { id: 'BANKA', name: 'Alpha Test Bank',   opening: 100000000 },   // 1,000,000.00 XTS
  { id: 'BANKB', name: 'Bravo Test Bank',   opening: 75000000 },
  { id: 'BANKC', name: 'Charlie Test Bank', opening: 50000000 },
  { id: 'BANKD', name: 'Delta Test Bank',   opening: 25000000 },
];

// Idempotent: only inserts banks that do not exist yet.
async function seed(pool, banks = DEFAULT_BANKS) {
  for (const b of banks) {
    await pool.query(
      `INSERT INTO accounts (id, name, opening_balance, balance) VALUES ($1,$2,$3,$3) ON CONFLICT (id) DO NOTHING`,
      [b.id, b.name, b.opening],
    );
  }
}

// Test/demo only. TRUNCATE does not fire row-level triggers, so the append-only guard does not block it.
async function reset(pool, banks = DEFAULT_BANKS) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query('TRUNCATE ledger_entries, audit_log, payments, accounts, outbox, message_store RESTART IDENTITY CASCADE');
    await c.query(`UPDATE system_state SET value='OPEN' WHERE key='status'`);
    for (const b of banks) {
      await c.query(`INSERT INTO accounts (id, name, opening_balance, balance) VALUES ($1,$2,$3,$3)`, [b.id, b.name, b.opening]);
    }
    await c.query('COMMIT');
  } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
}

module.exports = { createPool, migrate, seed, reset, DEFAULT_BANKS };
