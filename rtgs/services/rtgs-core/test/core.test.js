'use strict';
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { createPool, migrate, reset } = require('../src/db');
const engine = require('../src/engine');
const { toMinor, toDecimal } = require('../src/money');

const URL = process.env.DATABASE_URL || 'postgres://postgres@localhost:5433/rtgs_test';
let pool; let n = 0;
const pay = (o) => ({ idempotencyKey: `test-key-${Date.now()}-${++n}`, debtor: 'BANKA', creditor: 'BANKB', amount: 100000, currency: 'XTS', priority: 5, ...o });
const bal = async (id) => (await pool.query('SELECT balance FROM accounts WHERE id=$1', [id])).rows[0].balance;

before(async () => { pool = createPool(URL); await migrate(pool); });
beforeEach(async () => { await reset(pool); });
after(async () => { await pool.end(); });

test('money helpers parse and format without floats', () => {
  assert.equal(toMinor('1250.50'), 125050);
  assert.equal(toMinor('7'), 700);
  assert.equal(toMinor('0.05'), 5);
  assert.equal(toDecimal(125050), '1250.50');
  for (const bad of ['0', '-1', '1.234', '1e3', '', ' 5', 5, null, '0.00']) assert.throws(() => toMinor(bad), /amount/);
});

test('settles immediately when the debtor has liquidity; ledger is double-entry', async () => {
  const { payment } = await engine.submitPayment(pool, pay({ amount: 25000000 }));
  assert.equal(payment.status, 'SETTLED');
  assert.equal(await bal('BANKA'), 100000000 - 25000000);
  assert.equal(await bal('BANKB'), 75000000 + 25000000);
  const { rows } = await pool.query('SELECT direction, account_id, amount FROM ledger_entries WHERE payment_id=$1 ORDER BY direction', [payment.id]);
  assert.deepEqual(rows.map((r) => `${r.direction}:${r.account_id}:${r.amount}`), ['C:BANKB:25000000', 'D:BANKA:25000000']);
  assert.equal((await engine.reconcile(pool)).ok, true);
});

test('queues on insufficient liquidity, then settles automatically when funds arrive', async () => {
  // BANKD holds 250,000.00 and wants to send 300,000.00 to BANKA
  const big = (await engine.submitPayment(pool, pay({ debtor: 'BANKD', creditor: 'BANKA', amount: 30000000 }))).payment;
  assert.equal(big.status, 'QUEUED');
  assert.equal(big.reason, 'INSUFFICIENT_LIQUIDITY');
  assert.equal(await bal('BANKD'), 25000000);                       // nothing moved while queued

  // BANKB sends BANKD 100,000.00 -> BANKD now has 350,000.00 and the queue releases
  await engine.submitPayment(pool, pay({ debtor: 'BANKB', creditor: 'BANKD', amount: 10000000 }));
  const after1 = await engine.getPayment(pool, big.id);
  assert.equal(after1.status, 'SETTLED');
  assert.equal(await bal('BANKD'), 25000000 + 10000000 - 30000000);
  assert.equal((await engine.reconcile(pool)).ok, true);

  const { rows } = await pool.query('SELECT to_status FROM audit_log WHERE payment_id=$1 ORDER BY id', [big.id]);
  assert.deepEqual(rows.map((r) => r.to_status), ['RECEIVED', 'QUEUED', 'SETTLED']);
});

test('queue releases by priority first, then arrival order', async () => {
  const lo = (await engine.submitPayment(pool, pay({ debtor: 'BANKD', creditor: 'BANKA', amount: 20000000, priority: 2 }))).payment;
  const hi = (await engine.submitPayment(pool, pay({ debtor: 'BANKD', creditor: 'BANKB', amount: 20000000, priority: 8 }))).payment;
  assert.equal(lo.status, 'SETTLED');   // 250k covers the first one; the second only 50k left -> check below
  assert.equal(hi.status, 'QUEUED');
  // Top BANKD up by 150k: only the queued one remains, so it must settle
  await engine.submitPayment(pool, pay({ debtor: 'BANKA', creditor: 'BANKD', amount: 15000000 }));
  assert.equal((await engine.getPayment(pool, hi.id)).status, 'SETTLED');
});

test('high priority overtakes low priority in the queue', async () => {
  // Drain BANKD down to 0 first.
  await engine.submitPayment(pool, pay({ debtor: 'BANKD', creditor: 'BANKA', amount: 25000000 }));
  const low  = (await engine.submitPayment(pool, pay({ debtor: 'BANKD', creditor: 'BANKB', amount: 10000000, priority: 1 }))).payment;
  const high = (await engine.submitPayment(pool, pay({ debtor: 'BANKD', creditor: 'BANKC', amount: 10000000, priority: 9 }))).payment;
  assert.deepEqual([low.status, high.status], ['QUEUED', 'QUEUED']);
  // Only enough liquidity for ONE of them arrives.
  await engine.submitPayment(pool, pay({ debtor: 'BANKA', creditor: 'BANKD', amount: 10000000 }));
  assert.equal((await engine.getPayment(pool, high.id)).status, 'SETTLED');
  assert.equal((await engine.getPayment(pool, low.id)).status, 'QUEUED');
});

test('idempotency: the same key twice debits once; a different body with the same key is refused', async () => {
  const req = pay({ amount: 5000000 });
  const a = await engine.submitPayment(pool, req);
  const b = await engine.submitPayment(pool, req);
  assert.equal(a.replay, false);
  assert.equal(b.replay, true);
  assert.equal(a.payment.id, b.payment.id);
  assert.equal(await bal('BANKA'), 100000000 - 5000000);
  await assert.rejects(engine.submitPayment(pool, { ...req, amount: 6000000 }), { code: 'IDEMPOTENCY_CONFLICT' });
});

test('idempotency under concurrency: 25 simultaneous retries of one request settle exactly once', async () => {
  const req = pay({ amount: 1000000 });
  const results = await Promise.all(Array.from({ length: 25 }, () => engine.submitPayment(pool, req)));
  assert.equal(new Set(results.map((r) => r.payment.id)).size, 1);
  assert.equal(results.filter((r) => !r.replay).length, 1);
  assert.equal(await bal('BANKA'), 100000000 - 1000000);
});

test('rejects bad participants and bad shapes; nothing moves', async () => {
  await assert.rejects(engine.submitPayment(pool, pay({ creditor: 'NOBANK' })), { code: 'INVALID_PARTICIPANTS' });
  await assert.rejects(engine.submitPayment(pool, pay({ creditor: 'BANKA' })), { code: 'INVALID_PARTICIPANTS' });
  await assert.rejects(engine.submitPayment(pool, pay({ amount: 0 })), { code: 'VALIDATION_ERROR' });
  await assert.rejects(engine.submitPayment(pool, pay({ amount: 1.5 })), { code: 'VALIDATION_ERROR' });
  await assert.rejects(engine.submitPayment(pool, pay({ idempotencyKey: 'x' })), { code: 'VALIDATION_ERROR' });
  assert.equal((await engine.reconcile(pool)).ok, true);
  assert.equal((await pool.query('SELECT count(*)::int n FROM payments')).rows[0].n, 0);
});

test('atomicity: a crash between debit and credit rolls everything back', async () => {
  await assert.rejects(engine.submitPayment(pool, pay({ amount: 5000000 }), { fault: 'after-debit' }), /injected fault/);
  assert.equal(await bal('BANKA'), 100000000);
  assert.equal(await bal('BANKB'), 75000000);
  assert.equal((await pool.query('SELECT count(*)::int n FROM payments')).rows[0].n, 0);
  assert.equal((await pool.query('SELECT count(*)::int n FROM ledger_entries')).rows[0].n, 0);
  assert.equal((await engine.reconcile(pool)).ok, true);
});

test('the ledger and audit log are append-only', async () => {
  await engine.submitPayment(pool, pay());
  await assert.rejects(pool.query('UPDATE ledger_entries SET amount = 1'), /append-only/);
  await assert.rejects(pool.query('DELETE FROM ledger_entries'), /append-only/);
  await assert.rejects(pool.query('DELETE FROM audit_log'), /append-only/);
});

test('cancel works on queued payments only', async () => {
  const q = (await engine.submitPayment(pool, pay({ debtor: 'BANKD', amount: 99999999 }))).payment;
  assert.equal(q.status, 'QUEUED');
  assert.equal((await engine.cancelPayment(pool, q.id)).status, 'CANCELLED');
  const s = (await engine.submitPayment(pool, pay())).payment;
  await assert.rejects(engine.cancelPayment(pool, s.id), { code: 'INVALID_STATE' });
});

test('end of day: closing cancels the queue and rejects new payments; reopening resumes', async () => {
  const q = (await engine.submitPayment(pool, pay({ debtor: 'BANKD', amount: 99999999 }))).payment;
  const r = await engine.closeSystem(pool);
  assert.equal(r.cancelled, 1);
  assert.equal((await engine.getPayment(pool, q.id)).reason, 'END_OF_DAY');
  const rejected = (await engine.submitPayment(pool, pay())).payment;
  assert.equal(rejected.status, 'REJECTED');
  assert.equal(rejected.reason, 'SYSTEM_CLOSED');
  await engine.openSystem(pool);
  assert.equal((await engine.submitPayment(pool, pay())).payment.status, 'SETTLED');
});

test('CONCURRENCY: 400 random payments across 4 banks keep every invariant', async () => {
  const banks = ['BANKA', 'BANKB', 'BANKC', 'BANKD'];
  const jobs = Array.from({ length: 400 }, (_, i) => {
    const d = banks[i % 4]; const c = banks[(i * 7 + 1 + (i % 3)) % 4 === (i % 4) ? (i + 1) % 4 : (i * 7 + 1 + (i % 3)) % 4];
    return engine.submitPayment(pool, pay({ debtor: d, creditor: c, amount: 1000000 + (i % 13) * 700000, priority: i % 10, idempotencyKey: `conc-${i}-${Date.now()}` }));
  });
  const res = await Promise.all(jobs);
  await engine.drainQueue(pool);
  const rec = await engine.reconcile(pool);
  assert.equal(rec.ok, true, JSON.stringify(rec.checks.filter((c) => !c.ok)));
  const { rows } = await pool.query('SELECT status, count(*)::int n FROM payments GROUP BY status');
  const by = Object.fromEntries(rows.map((r) => [r.status, r.n]));
  assert.equal((by.SETTLED || 0) + (by.QUEUED || 0), 400);
  assert.ok((by.SETTLED || 0) > 100, `expected many settlements, got ${JSON.stringify(by)}`);
  assert.equal(res.length, 400);
  console.log('    concurrency run:', JSON.stringify(by));
});

test('GRIDLOCK: two banks each queued behind the other stay safe (no negative balances)', async () => {
  // Empty both accounts into BANKA so BANKC and BANKD have 0 liquidity, then cross-queue them.
  await engine.submitPayment(pool, pay({ debtor: 'BANKC', creditor: 'BANKA', amount: 50000000 }));
  await engine.submitPayment(pool, pay({ debtor: 'BANKD', creditor: 'BANKA', amount: 25000000 }));
  const x = (await engine.submitPayment(pool, pay({ debtor: 'BANKC', creditor: 'BANKD', amount: 1000 }))).payment;
  const y = (await engine.submitPayment(pool, pay({ debtor: 'BANKD', creditor: 'BANKC', amount: 1000 }))).payment;
  assert.deepEqual([x.status, y.status], ['QUEUED', 'QUEUED']);
  assert.equal((await engine.reconcile(pool)).ok, true);
  // Real systems resolve this with liquidity injection or bilateral offsetting; here, an injection releases both.
  await engine.submitPayment(pool, pay({ debtor: 'BANKA', creditor: 'BANKC', amount: 1000 }));
  assert.equal((await engine.getPayment(pool, x.id)).status, 'SETTLED');
  assert.equal((await engine.getPayment(pool, y.id)).status, 'SETTLED');
});
