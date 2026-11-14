'use strict';
// End-to-end: real gateway -> real core -> real Postgres, over HTTP.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createPool, migrate, reset } = require('../services/rtgs-core/src/db');
const { createApp: createCore } = require('../services/rtgs-core/src/app');
const { createApp: createGateway } = require('../services/bank-gateway/src/app');

const DB = process.env.DATABASE_URL || 'postgres://postgres@localhost:5433/rtgs_test';
const KEYS = { 'key-a': { role: 'bank', bank: 'BANKA' }, 'key-b': { role: 'bank', bank: 'BANKB' }, 'key-d': { role: 'bank', bank: 'BANKD' }, 'key-op': { role: 'operator' } };
let pool, coreSrv, gwSrv, corePort, gw; let n = 0;

const listen = (app, port = 0) => new Promise((res) => { const s = http.createServer(app).listen(port, '127.0.0.1', () => res(s)); });
const msg = (from, to, value, extra = {}) => ({ msgId: `M-${++n}`, creditTransfer: { endToEndId: `E-${n}`, amount: { value, currency: 'XTS' }, debtorAgent: from, creditorAgent: to, priority: 'NORM', ...extra } });
const call = (key, method, path, body, headers = {}) => fetch(`${gw}${path}`, { method, headers: { 'content-type': 'application/json', 'x-api-key': key, ...headers }, body: body ? JSON.stringify(body) : undefined });
const send = (key, from, to, value, idem = `idem-${Date.now()}-${++n}`, body = msg(from, to, value)) => call(key, 'POST', '/v1/payments', body, { 'idempotency-key': idem });

before(async () => {
  pool = createPool(DB); await migrate(pool);
  coreSrv = await listen(createCore(pool, { internalToken: 'internal-secret', allowReset: true }));
  corePort = coreSrv.address().port;
  gwSrv = await listen(createGateway({ coreUrl: `http://127.0.0.1:${corePort}`, internalToken: 'internal-secret', keys: KEYS, timeoutMs: Number(process.env.GW_TIMEOUT_MS || 15000) }));
  gw = `http://127.0.0.1:${gwSrv.address().port}`;
});
beforeEach(async () => { await reset(pool); });
after(async () => { gwSrv.close(); coreSrv.close(); await pool.end(); });

test('the core refuses callers that do not hold the internal token', async () => {
  assert.equal((await fetch(`http://127.0.0.1:${corePort}/v1/accounts`)).status, 401);
  assert.equal((await fetch(`http://127.0.0.1:${corePort}/v1/accounts`, { headers: { 'x-internal-token': 'wrong' } })).status, 401);
});

test('happy path: BANKA pays BANKB, both balances move, statement shows the entries', async () => {
  const r = await send('key-a', 'BANKA', 'BANKB', '250000.00');
  assert.equal(r.status, 201);
  const p = await r.json();
  assert.equal(p.status, 'SETTLED');
  assert.equal((await (await call('key-a', 'GET', '/v1/balance')).json()).balance, '750000.00');
  assert.equal((await (await call('key-b', 'GET', '/v1/balance')).json()).balance, '1000000.00');
  const st = await (await call('key-b', 'GET', '/v1/statement')).json();
  assert.deepEqual(st.map((e) => [e.direction, e.amount]), [['CREDIT', '250000.00']]);
  assert.equal((await (await call('key-op', 'GET', '/v1/operator/reconcile')).json()).ok, true);
});

test('queue then release through the public API', async () => {
  const q = await (await send('key-d', 'BANKD', 'BANKA', '300000.00')).json();
  assert.equal(q.status, 'QUEUED');
  assert.equal((await (await call('key-op', 'GET', '/v1/operator/queue')).json()).length, 1);
  await send('key-b', 'BANKB', 'BANKD', '100000.00');                      // wrong key for BANKB? key-b IS BANKB -> ok
  const after = await (await call('key-d', 'GET', `/v1/payments/${q.id}`)).json();
  assert.equal(after.status, 'SETTLED');
  assert.deepEqual(after.audit.map((a) => a.to_status), ['RECEIVED', 'QUEUED', 'SETTLED']);
});

test('retrying with the same Idempotency-Key never double-pays', async () => {
  const body = msg('BANKA', 'BANKB', '1000.00');                          // a retry re-sends the SAME message
  const a = await (await send('key-a', 'BANKA', 'BANKB', '1000.00', 'retry-key-0001', body)).json();
  const rr = await send('key-a', 'BANKA', 'BANKB', '1000.00', 'retry-key-0001', body);
  const b = await rr.json();
  assert.equal(rr.status, 200);
  assert.equal(b.replay, true);
  assert.equal(a.id, b.id);
  assert.equal((await (await call('key-a', 'GET', '/v1/balance')).json()).balance, '999000.00');
  // Same key but a different message is a client bug and must be refused, not silently re-used.
  const bad = await send('key-a', 'BANKA', 'BANKB', '2000.00', 'retry-key-0001');
  assert.equal(bad.status, 422);
});

test('FAILURE DRILL: core goes down mid-flight -> 503; after recovery the same key completes exactly once', async () => {
  coreSrv.close(); await new Promise((r) => setTimeout(r, 50));
  const body = msg('BANKA', 'BANKB', '5000.00');
  const down = await send('key-a', 'BANKA', 'BANKB', '5000.00', 'drill-key-0001', body);
  assert.equal(down.status, 503);
  assert.equal((await fetch(`${gw}/health`)).status, 503);

  coreSrv = await listen(createCore(pool, { internalToken: 'internal-secret', allowReset: true }), corePort);   // "restart"
  const retry = await send('key-a', 'BANKA', 'BANKB', '5000.00', 'drill-key-0001', body);
  assert.equal(retry.status, 201);
  const again = await send('key-a', 'BANKA', 'BANKB', '5000.00', 'drill-key-0001', body);
  assert.equal((await again.json()).replay, true);
  assert.equal((await (await call('key-a', 'GET', '/v1/balance')).json()).balance, '995000.00');
  assert.equal((await (await call('key-op', 'GET', '/v1/operator/reconcile')).json()).ok, true);
});

test('authorisation: spoofing, cross-bank reads and operator endpoints', async () => {
  assert.equal((await send('key-a', 'BANKB', 'BANKA', '10.00')).status, 403);          // A pretending to be B
  const p = await (await send('key-a', 'BANKA', 'BANKB', '10.00')).json();
  assert.equal((await call('key-d', 'GET', `/v1/payments/${p.id}`)).status, 404);      // D is not a party
  assert.equal((await call('key-b', 'GET', `/v1/payments/${p.id}`)).status, 200);      // B is
  assert.equal((await call('key-a', 'GET', '/v1/operator/accounts')).status, 403);
  assert.equal((await call('bad', 'GET', '/v1/balance')).status, 401);
});

test('50 concurrent payments through HTTP keep the books balanced', async () => {
  const banks = [['key-a', 'BANKA'], ['key-b', 'BANKB'], ['key-d', 'BANKD']];
  await Promise.all(Array.from({ length: 50 }, (_, i) => {
    const [k, from] = banks[i % 3]; const to = banks[(i + 1) % 3][1];
    return send(k, from, to, (1000 + i * 137).toFixed(2));
  }));
  const rec = await (await call('key-op', 'GET', '/v1/operator/reconcile')).json();
  assert.equal(rec.ok, true, JSON.stringify(rec));
});
