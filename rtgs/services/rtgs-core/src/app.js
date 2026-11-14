'use strict';
const crypto = require('node:crypto');
const express = require('express');
const engine = require('./engine');
const { reset, seed } = require('./db');
const { toDecimal, ValidationError } = require('./money');

function view(p) {
  return {
    id: p.id, endToEndId: p.end_to_end_id, debtor: p.debtor, creditor: p.creditor,
    amount: toDecimal(p.amount), currency: p.currency, priority: p.priority,
    status: p.status, reason: p.reason, createdAt: p.created_at, settledAt: p.settled_at,
  };
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a || '')); const y = Buffer.from(String(b || ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function createApp(pool, { internalToken, allowReset = false, gitSha = 'dev', startedAt = new Date() } = {}) {
  if (!internalToken) throw new Error('internalToken is required');
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '32kb' }));

  app.get('/health', async (_req, res) => {
    try { await pool.query('SELECT 1'); res.json({ status: 'ok', service: 'rtgs-core', version: gitSha, startedAt }); }
    catch { res.status(503).json({ status: 'degraded', service: 'rtgs-core' }); }
  });

  // Everything under /v1 is internal: only the gateway (holding the shared token) may call it.
  app.use('/v1', (req, res, next) => {
    if (!safeEqual(req.get('x-internal-token'), internalToken)) return res.status(401).json({ error: 'UNAUTHORIZED' });
    next();
  });

  app.post('/v1/payments', async (req, res) => {
    const { payment, replay } = await engine.submitPayment(pool, req.body);
    res.status(replay ? 200 : 201).json({ ...view(payment), replay });
  });

  app.get('/v1/payments', async (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const params = [limit]; let where = '';
    if (req.query.status) { params.push(String(req.query.status)); where = 'WHERE status = $2'; }
    if (req.query.participant) { params.push(String(req.query.participant)); where += `${where ? ' AND' : 'WHERE'} (debtor = $${params.length} OR creditor = $${params.length})`; }
    const { rows } = await pool.query(`SELECT * FROM payments ${where} ORDER BY created_at DESC, id LIMIT $1`, params);
    res.json(rows.map(view));
  });

  app.get('/v1/payments/:id', async (req, res) => {
    if (!/^[0-9a-f-]{36}$/.test(req.params.id)) throw new ValidationError('invalid payment id');
    const p = await engine.getPayment(pool, req.params.id);
    const { rows: trail } = await pool.query('SELECT from_status, to_status, detail, at FROM audit_log WHERE payment_id=$1 ORDER BY id', [p.id]);
    res.json({ ...view(p), audit: trail });
  });

  app.post('/v1/payments/:id/cancel', async (req, res) => {
    res.json(view(await engine.cancelPayment(pool, req.params.id)));
  });

  app.get('/v1/accounts', async (_req, res) => {
    const { rows } = await pool.query(`
      SELECT a.id, a.name, a.opening_balance, a.balance,
             COALESCE((SELECT SUM(amount) FROM payments q WHERE q.debtor=a.id AND q.status='QUEUED'),0)::bigint AS queued_out
      FROM accounts a ORDER BY a.id`);
    res.json(rows.map((r) => ({ id: r.id, name: r.name, openingBalance: toDecimal(r.opening_balance), balance: toDecimal(r.balance), queuedOutgoing: toDecimal(r.queued_out) })));
  });

  app.get('/v1/accounts/:id/statement', async (req, res) => {
    const { rows } = await pool.query(
      `SELECT l.id, l.payment_id, l.direction, l.amount, l.created_at, p.end_to_end_id
       FROM ledger_entries l JOIN payments p ON p.id = l.payment_id
       WHERE l.account_id = $1 ORDER BY l.id DESC LIMIT 100`, [req.params.id]);
    res.json(rows.map((r) => ({ entryId: r.id, paymentId: r.payment_id, endToEndId: r.end_to_end_id, direction: r.direction === 'D' ? 'DEBIT' : 'CREDIT', amount: toDecimal(r.amount), at: r.created_at })));
  });

  app.get('/v1/queue', async (_req, res) => {
    const { rows } = await pool.query(`SELECT * FROM payments WHERE status='QUEUED' ORDER BY priority DESC, created_at, id`);
    res.json(rows.map(view));
  });

  app.get('/v1/system', async (_req, res) => {
    const { rows } = await pool.query(`SELECT value FROM system_state WHERE key='status'`);
    res.json({ status: rows[0].value });
  });
  app.post('/v1/system/close', async (_req, res) => res.json(await engine.closeSystem(pool)));
  app.post('/v1/system/open', async (_req, res) => { const r = await engine.openSystem(pool); await engine.drainQueue(pool); res.json(r); });
  app.get('/v1/reconcile', async (_req, res) => res.json(await engine.reconcile(pool)));

  app.post('/v1/test/reset', async (_req, res) => {
    if (!allowReset) return res.status(403).json({ error: 'RESET_DISABLED' });
    await reset(pool); res.json({ status: 'reset' });
  });

  app.use((_req, res) => res.status(404).json({ error: 'NOT_FOUND' }));
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'INVALID_JSON' });
    if (err.status && err.status < 500) return res.status(err.status).json({ error: err.code || 'ERROR', message: err.message });
    console.error(JSON.stringify({ level: 'error', msg: err.message, stack: err.stack }));
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  });
  return app;
}

module.exports = { createApp, view };
