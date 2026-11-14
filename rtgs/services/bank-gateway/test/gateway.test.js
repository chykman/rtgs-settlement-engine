'use strict';
// Unit tests with a stubbed core: no database, no network.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createApp, parseCreditTransfer } = require('../src/app');

const KEYS = { 'key-a': { role: 'bank', bank: 'BANKA' }, 'key-b': { role: 'bank', bank: 'BANKB' }, 'key-op': { role: 'operator' } };
const msg = (o = {}) => ({ msgId: 'MSG-1', creditTransfer: { endToEndId: 'INV-1', amount: { value: '1250.50', currency: 'XTS' }, debtorAgent: 'BANKA', creditorAgent: 'BANKB', priority: 'NORM', ...o } });

async function withServer(fetchImpl, fn) {
  const app = createApp({ coreUrl: 'http://core', internalToken: 'tok', keys: KEYS, fetchImpl });
  const server = http.createServer(app).listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  try { await fn(base); } finally { server.close(); }
}
const coreOk = (calls) => async (url, init) => {
  calls.push({ url, init });
  return new Response(JSON.stringify({ id: 'p1', status: 'SETTLED', debtor: 'BANKA', creditor: 'BANKB', amount: '1250.50' }), { status: 201, headers: { 'content-type': 'application/json' } });
};
const post = (base, body, headers = {}) => fetch(`${base}/v1/payments`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'key-a', 'idempotency-key': 'abcdefgh-1', ...headers }, body: JSON.stringify(body) });

test('parseCreditTransfer maps decimals to minor units and priorities to numbers', () => {
  const r = parseCreditTransfer(msg({ priority: 'URGT' }));
  assert.deepEqual([r.amount, r.priority, r.debtor, r.creditor], [125050, 9, 'BANKA', 'BANKB']);
});

test('rejects unauthenticated and wrongly keyed requests', async () => {
  await withServer(coreOk([]), async (base) => {
    assert.equal((await fetch(`${base}/v1/balance`)).status, 401);
    assert.equal((await fetch(`${base}/v1/balance`, { headers: { 'x-api-key': 'nope' } })).status, 401);
  });
});

test('a bank cannot send from another bank\'s account (spoofing)', async () => {
  const calls = [];
  await withServer(coreOk(calls), async (base) => {
    const r = await post(base, msg({ debtorAgent: 'BANKB', creditorAgent: 'BANKA' }));
    assert.equal(r.status, 403);
    assert.equal(calls.length, 0);                                // never reached the core
  });
});

test('requires Idempotency-Key and validates message content', async () => {
  await withServer(coreOk([]), async (base) => {
    assert.equal((await post(base, msg(), { 'idempotency-key': '' })).status, 400);
    for (const bad of [{ amount: { value: '0', currency: 'XTS' } }, { amount: { value: '1.234', currency: 'XTS' } }, { amount: { value: '5', currency: 'USD' } }, { priority: 'WHENEVER' }, { endToEndId: '' }]) {
      assert.equal((await post(base, msg(bad))).status, 400, JSON.stringify(bad));
    }
  });
});

test('forwards the internal token and a namespaced idempotency key to the core', async () => {
  const calls = [];
  await withServer(coreOk(calls), async (base) => {
    const r = await post(base, msg());
    assert.equal(r.status, 201);
    const sent = JSON.parse(calls[0].init.body);
    assert.equal(calls[0].init.headers['x-internal-token'], 'tok');
    assert.equal(sent.idempotencyKey, 'BANKA:abcdefgh-1');       // two banks can reuse the same client key safely
    assert.equal(sent.amount, 125050);
  });
});

test('core outage becomes 503 with retry guidance, not a hang or a 500', async () => {
  const dead = async () => { throw new Error('ECONNREFUSED'); };
  await withServer(dead, async (base) => {
    const r = await post(base, msg());
    assert.equal(r.status, 503);
    assert.match((await r.json()).message, /same Idempotency-Key/);
    assert.equal((await fetch(`${base}/health`)).status, 503);
  });
});

test('banks cannot use operator endpoints; banks only see payments they are part of', async () => {
  const fetchImpl = async () => new Response(JSON.stringify({ id: 'p1', debtor: 'BANKC', creditor: 'BANKD', status: 'SETTLED' }), { status: 200, headers: { 'content-type': 'application/json' } });
  await withServer(fetchImpl, async (base) => {
    assert.equal((await fetch(`${base}/v1/operator/accounts`, { headers: { 'x-api-key': 'key-a' } })).status, 403);
    assert.equal((await fetch(`${base}/v1/payments/00000000-0000-0000-0000-000000000000`, { headers: { 'x-api-key': 'key-a' } })).status, 404);
    assert.equal((await fetch(`${base}/v1/payments/00000000-0000-0000-0000-000000000000`, { headers: { 'x-api-key': 'key-op' } })).status, 200);
  });
});

test('a rejected internal token is reported as 502, never as a 401 to the bank', async () => {
  const fetchImpl = async () => new Response(JSON.stringify({ error: 'UNAUTHORIZED' }), { status: 401, headers: { 'content-type': 'application/json' } });
  await withServer(fetchImpl, async (base) => {
    const r = await post(base, msg());
    assert.equal(r.status, 502);
    assert.equal((await r.json()).error, 'UPSTREAM_AUTH_FAILURE');
  });
});
