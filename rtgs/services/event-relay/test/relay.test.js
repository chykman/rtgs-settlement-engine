'use strict';
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
// Reuse the core's schema/engine so the relay is tested against the real outbox rows.
const { createPool, migrate, reset } = require('../../rtgs-core/src/db');
const engine = require('../../rtgs-core/src/engine');
const { publishPending } = require('../src/relay');
const { storeMessage, processMessage, PoisonMessageError } = require('../src/sink');

const URL = process.env.DATABASE_URL || 'postgres://postgres@localhost:5433/rtgs_test';
let pool; let n = 0;
const pay = (o) => ({ idempotencyKey: `relay-key-${Date.now()}-${++n}`, debtor: 'BANKA', creditor: 'BANKB', amount: 100000, currency: 'XTS', priority: 5, ...o });
const silent = { error() {} };

class FakeProducer {
  constructor() { this.sent = []; this.fail = false; }
  async send({ topic, messages }) {
    if (this.fail) throw new Error('broker unavailable');
    this.sent.push(...messages.map((m) => ({ topic, ...m })));
  }
}
const unpublished = async () => (await pool.query('SELECT count(*)::int AS n FROM outbox WHERE published_at IS NULL')).rows[0].n;

before(async () => { pool = createPool(URL); await migrate(pool); });
beforeEach(async () => { await reset(pool); });
after(async () => { await pool.end(); });

test('relay publishes in outbox order, keyed by payment id, then marks rows published', async () => {
  const { payment } = await engine.submitPayment(pool, pay());
  const prod = new FakeProducer();
  assert.equal(await publishPending(pool, prod, { topic: 't' }), 2);
  assert.deepEqual(prod.sent.map((m) => m.headers['event-type']), ['pacs.008.001.08', 'pacs.002.001.10']);
  assert.ok(prod.sent.every((m) => m.key === payment.id));
  assert.equal(await unpublished(), 0);
  assert.equal(await publishPending(pool, prod, { topic: 't' }), 0);       // nothing left
  assert.equal(prod.sent.length, 2);
});

test('broker outage: nothing is marked published, and the backlog drains once Kafka is back', async () => {
  await engine.submitPayment(pool, pay());
  const prod = new FakeProducer(); prod.fail = true;
  await assert.rejects(publishPending(pool, prod, { topic: 't' }), /broker unavailable/);
  assert.equal(await unpublished(), 2);                                      // no message lost
  prod.fail = false;
  assert.equal(await publishPending(pool, prod, { topic: 't' }), 2);
  assert.equal(await unpublished(), 0);
});

test('batch size is respected', async () => {
  await engine.submitPayment(pool, pay());
  await engine.submitPayment(pool, pay({ debtor: 'BANKB', creditor: 'BANKC' }));
  const prod = new FakeProducer();
  assert.equal(await publishPending(pool, prod, { topic: 't', batchSize: 3 }), 3);
  assert.equal(await unpublished(), 1);
});

test('only one relay publishes at a time (advisory lock)', async () => {
  await engine.submitPayment(pool, pay());
  const holder = await pool.connect();
  try {
    await holder.query('BEGIN');
    await holder.query('SELECT pg_advisory_xact_lock(4343)');
    const prod = new FakeProducer();
    assert.equal(await publishPending(pool, prod, { topic: 't' }), 0);
    assert.equal(prod.sent.length, 0);
  } finally { await holder.query('ROLLBACK'); holder.release(); }
});

test('sink stores every message and is idempotent under redelivery', async () => {
  await engine.submitPayment(pool, pay());
  const prod = new FakeProducer();
  await publishPending(pool, prod, { topic: 't' });
  const deliver = (m, offset) => storeMessage(pool, { topic: 't', partition: 0, offset: String(offset), value: Buffer.from(m.value) });

  const first = await Promise.all(prod.sent.map((m, i) => deliver(m, i)));
  assert.deepEqual(first, ['stored', 'stored']);
  const replay = await Promise.all(prod.sent.map((m, i) => deliver(m, i + 10)));   // at-least-once duplicate
  assert.deepEqual(replay, ['duplicate', 'duplicate']);
  const { rows } = await pool.query('SELECT event_type FROM message_store ORDER BY outbox_id');
  assert.deepEqual(rows.map((r) => r.event_type), ['pacs.008.001.08', 'pacs.002.001.10']);
});

test('storeMessage rejects malformed messages as poison', async () => {
  for (const bad of ['not json', '{"x":1}', 'null']) {
    await assert.rejects(storeMessage(pool, { topic: 't', partition: 0, offset: '1', value: Buffer.from(bad) }), PoisonMessageError);
  }
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM message_store')).rows[0].n, 0);
});

test('processMessage dead-letters a poison message with its origin in headers', async () => {
  const dlq = new FakeProducer();
  const r = await processMessage(pool, dlq, { topic: 'src', partition: 2, offset: '41', key: Buffer.from('k'), value: Buffer.from('garbage') },
    { dlqTopic: 'dead', log: silent });
  assert.equal(r, 'dead-lettered');
  assert.equal(dlq.sent.length, 1);
  assert.equal(dlq.sent[0].topic, 'dead');
  assert.equal(dlq.sent[0].value.toString(), 'garbage');                     // original bytes preserved
  assert.deepEqual(dlq.sent[0].headers, {
    'dlq-reason': 'not valid JSON', 'source-topic': 'src', 'source-partition': '2', 'source-offset': '41',
  });
});

test('processMessage: a failing DLQ send propagates so the message is retried, not lost', async () => {
  const dlq = new FakeProducer(); dlq.fail = true;
  await assert.rejects(
    processMessage(pool, dlq, { topic: 's', partition: 0, offset: '1', value: Buffer.from('garbage') }, { dlqTopic: 'dead', log: silent }),
    /broker unavailable/,
  );
});

test('processMessage: a good message is stored and never touches the DLQ', async () => {
  await engine.submitPayment(pool, pay());
  const prod = new FakeProducer();
  await publishPending(pool, prod, { topic: 't' });
  const dlq = new FakeProducer();
  const out = [];
  for (const [i, m] of prod.sent.entries()) {
    out.push(await processMessage(pool, dlq, { topic: 't', partition: 0, offset: String(i), key: m.key, value: Buffer.from(m.value) }, { dlqTopic: 'dead', log: silent }));
  }
  assert.deepEqual(out, ['stored', 'stored']);
  assert.equal(dlq.sent.length, 0);
});
