'use strict';
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { createPool, migrate, reset } = require('../src/db');
const engine = require('../src/engine');

const URL = process.env.DATABASE_URL || 'postgres://postgres@localhost:5433/rtgs_test';
let pool; let n = 0;
const pay = (o) => ({ idempotencyKey: `outbox-key-${Date.now()}-${++n}`, debtor: 'BANKA', creditor: 'BANKB', amount: 100000, currency: 'XTS', priority: 5, ...o });
const events = async () => (await pool.query('SELECT id, aggregate_id, event_type, payload, published_at FROM outbox ORDER BY id')).rows;

before(async () => { pool = createPool(URL); await migrate(pool); });
beforeEach(async () => { await reset(pool); });
after(async () => { await pool.end(); });

test('a settled payment writes pacs.008 then pacs.002(ACSC) to the outbox, unpublished', async () => {
  const { payment } = await engine.submitPayment(pool, pay());
  const ev = await events();
  assert.deepEqual(ev.map((e) => e.event_type), ['pacs.008.001.08', 'pacs.002.001.10']);
  assert.ok(ev.every((e) => e.aggregate_id === payment.id && e.published_at === null));
  assert.equal(ev[1].payload.message.document.Document.FIToFIPmtStsRpt.TxInfAndSts.TxSts, 'ACSC');
});

test('queued then released: outbox follows the audit trail (RECEIVED, QUEUED, SETTLED)', async () => {
  const big = (await engine.submitPayment(pool, pay({ debtor: 'BANKD', creditor: 'BANKA', amount: 30000000 }))).payment;
  await engine.submitPayment(pool, pay({ debtor: 'BANKB', creditor: 'BANKD', amount: 10000000 }));
  const { rows } = await pool.query(`SELECT payload->>'paymentStatus' AS s FROM outbox WHERE aggregate_id=$1 ORDER BY id`, [big.id]);
  assert.deepEqual(rows.map((r) => r.s), ['RECEIVED', 'QUEUED', 'SETTLED']);
});

test('atomicity: a failure mid-settlement rolls back the payment AND its outbox rows', async () => {
  await assert.rejects(engine.submitPayment(pool, pay(), { fault: 'after-debit' }), /injected fault/);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM payments')).rows[0].n, 0);
  assert.equal((await events()).length, 0);
});

test('idempotent replay creates no new outbox rows', async () => {
  const req = pay();
  await engine.submitPayment(pool, req);
  const before1 = (await events()).length;
  const again = await engine.submitPayment(pool, req);
  assert.equal(again.replay, true);
  assert.equal((await events()).length, before1);
});

test('end-of-day cancellation emits a pacs.002 RJCT with the reason', async () => {
  const q = (await engine.submitPayment(pool, pay({ debtor: 'BANKD', creditor: 'BANKA', amount: 30000000 }))).payment;
  await engine.closeSystem(pool);
  const last = (await events()).filter((e) => e.aggregate_id === q.id).pop();
  const tx = last.payload.message.document.Document.FIToFIPmtStsRpt.TxInfAndSts;
  assert.equal(tx.TxSts, 'RJCT');
  assert.equal(tx.StsRsnInf.Rsn.Prtry, 'END_OF_DAY');
});
