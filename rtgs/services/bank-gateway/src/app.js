'use strict';
const crypto = require('node:crypto');
const express = require('express');

const PRIORITY = { URGT: 9, HIGH: 8, NORM: 5, LOW: 2 };
const AMOUNT_RE = /^\d{1,13}(\.\d{1,2})?$/;
const CURRENCY = 'XTS';                                 // ISO 4217 code reserved for testing

class HttpError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a || '')); const y = Buffer.from(String(b || ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/**
 * Validate a simplified pacs.008-style credit transfer and map it to the core's request.
 * Real ISO 20022 is XML with ~100 fields; this keeps the ones that matter for settlement.
 */
function parseCreditTransfer(body) {
  const ct = body?.creditTransfer;
  if (!body || typeof body.msgId !== 'string' || !ct) throw new HttpError(400, 'VALIDATION_ERROR', 'msgId and creditTransfer are required');
  if (typeof ct.endToEndId !== 'string' || !ct.endToEndId || ct.endToEndId.length > 35) throw new HttpError(400, 'VALIDATION_ERROR', 'creditTransfer.endToEndId required (max 35 chars)');
  if (!AMOUNT_RE.test(ct.amount?.value ?? '') || Number(ct.amount.value) <= 0) throw new HttpError(400, 'VALIDATION_ERROR', 'amount.value must be a positive decimal string with at most 2 fraction digits');
  if (ct.amount.currency !== CURRENCY) throw new HttpError(400, 'VALIDATION_ERROR', `amount.currency must be ${CURRENCY}`);
  if (typeof ct.debtorAgent !== 'string' || typeof ct.creditorAgent !== 'string') throw new HttpError(400, 'VALIDATION_ERROR', 'debtorAgent and creditorAgent required');
  const priority = PRIORITY[ct.priority ?? 'NORM'];
  if (priority === undefined) throw new HttpError(400, 'VALIDATION_ERROR', `priority must be one of ${Object.keys(PRIORITY).join(', ')}`);
  const [whole, frac = ''] = ct.amount.value.split('.');
  return {
    debtor: ct.debtorAgent, creditor: ct.creditorAgent, currency: CURRENCY, priority,
    amount: Number(whole) * 100 + Number(frac.padEnd(2, '0')), endToEndId: ct.endToEndId,
  };
}

function createApp({ coreUrl, internalToken, keys, demoMode = false, gitSha = 'dev', fetchImpl = fetch, timeoutMs = 5000, log = () => {} }) {
  if (!coreUrl || !internalToken || !keys) throw new Error('coreUrl, internalToken and keys are required');
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '16kb' }));

  app.use((req, res, next) => {
    req.id = req.get('x-request-id') || crypto.randomUUID();
    res.set('x-request-id', req.id);
    const t0 = Date.now();
    res.on('finish', () => log({ level: 'info', msg: 'request', id: req.id, method: req.method, path: req.path, status: res.statusCode, ms: Date.now() - t0 }));
    next();
  });

  async function core(req, method, path, body) {
    let r;
    try {
      r = await fetchImpl(`${coreUrl}${path}`, {
        method,
        headers: { 'content-type': 'application/json', 'x-internal-token': internalToken, 'x-request-id': req.id },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      // The outcome of a write is UNKNOWN here. Safe because the client retries with the same Idempotency-Key.
      throw new HttpError(503, 'SETTLEMENT_UNAVAILABLE', 'settlement engine unreachable; retry with the same Idempotency-Key');
    }
    const data = await r.json().catch(() => ({}));
    // The gateway's own credential being rejected is OUR fault, not the caller's: never show it as a 401 to a bank.
    if (r.status === 401 || r.status === 403) throw new HttpError(502, 'UPSTREAM_AUTH_FAILURE', 'gateway is not authorised to call the settlement engine');
    if (!r.ok) throw new HttpError(r.status, data.error || 'CORE_ERROR', data.message || 'core error');
    return { status: r.status, data };
  }

  app.get('/health', async (req, res) => {
    try { await core(req, 'GET', '/health'); res.json({ status: 'ok', service: 'bank-gateway', version: gitSha, core: 'ok' }); }
    catch { res.status(503).json({ status: 'degraded', service: 'bank-gateway', core: 'unreachable' }); }
  });

  if (demoMode) {
    // DEMO ONLY: lets the sample dashboard offer a "send as bank X" picker. Never enable outside a test environment.
    app.get('/v1/demo/keys', (_req, res) => res.json(Object.entries(keys).map(([k, v]) => ({ key: k, role: v.role, bank: v.bank || null }))));
  }

  const auth = (req, _res, next) => {
    const presented = req.get('x-api-key');
    const hit = Object.entries(keys).find(([k]) => safeEqual(k, presented));
    if (!hit) return next(new HttpError(401, 'UNAUTHORIZED', 'missing or invalid x-api-key'));
    req.principal = hit[1];
    next();
  };
  const operatorOnly = (req, _res, next) => (req.principal.role === 'operator' ? next() : next(new HttpError(403, 'FORBIDDEN', 'operator only')));
  const involved = (p, who) => p.debtor === who || p.creditor === who;

  app.use('/v1', (req, res, next) => (req.path.startsWith('/demo/') ? next() : auth(req, res, next)));

  // ---- participant API ------------------------------------------------------------------
  app.post('/v1/payments', async (req, res) => {
    const key = req.get('idempotency-key');
    if (!key || !/^[\w.:-]{8,100}$/.test(key)) throw new HttpError(400, 'VALIDATION_ERROR', 'Idempotency-Key header required (8-100 chars of [A-Za-z0-9_.:-])');
    const ct = parseCreditTransfer(req.body);
    // A bank may only send FROM its own account. Operators may initiate test payments for any bank.
    if (req.principal.role === 'bank' && ct.debtor !== req.principal.bank) throw new HttpError(403, 'FORBIDDEN', 'debtorAgent must be your own institution');
    const { status, data } = await core(req, 'POST', '/v1/payments', { idempotencyKey: `${ct.debtor}:${key}`, ...ct });
    res.status(status).json({ msgId: req.body.msgId, ...data });
  });

  app.get('/v1/payments/:id', async (req, res) => {
    const { data } = await core(req, 'GET', `/v1/payments/${encodeURIComponent(req.params.id)}`);
    if (req.principal.role === 'bank' && !involved(data, req.principal.bank)) throw new HttpError(404, 'NOT_FOUND', 'payment not found');
    res.json(data);
  });

  app.post('/v1/payments/:id/cancel', async (req, res) => {
    if (req.principal.role === 'bank') {
      const { data } = await core(req, 'GET', `/v1/payments/${encodeURIComponent(req.params.id)}`);
      if (data.debtor !== req.principal.bank) throw new HttpError(404, 'NOT_FOUND', 'payment not found');
    }
    res.json((await core(req, 'POST', `/v1/payments/${encodeURIComponent(req.params.id)}/cancel`)).data);
  });

  app.get('/v1/balance', async (req, res) => {
    if (req.principal.role !== 'bank') throw new HttpError(400, 'VALIDATION_ERROR', 'use /v1/operator/accounts');
    const { data } = await core(req, 'GET', '/v1/accounts');
    res.json({ ...data.find((a) => a.id === req.principal.bank), currency: CURRENCY });
  });

  app.get('/v1/statement', async (req, res) => {
    if (req.principal.role !== 'bank') throw new HttpError(400, 'VALIDATION_ERROR', 'banks only');
    res.json((await core(req, 'GET', `/v1/accounts/${req.principal.bank}/statement`)).data);
  });

  // ---- operator API ---------------------------------------------------------------------
  const op = express.Router();
  op.use(operatorOnly);
  op.get('/accounts', async (req, res) => res.json((await core(req, 'GET', '/v1/accounts')).data));
  op.get('/queue', async (req, res) => res.json((await core(req, 'GET', '/v1/queue')).data));
  op.get('/payments', async (req, res) => res.json((await core(req, 'GET', `/v1/payments?limit=${Math.min(Number(req.query.limit) || 30, 100)}`)).data));
  op.get('/reconcile', async (req, res) => res.json((await core(req, 'GET', '/v1/reconcile')).data));
  op.get('/system', async (req, res) => res.json((await core(req, 'GET', '/v1/system')).data));
  op.post('/system/close', async (req, res) => res.json((await core(req, 'POST', '/v1/system/close')).data));
  op.post('/system/open', async (req, res) => res.json((await core(req, 'POST', '/v1/system/open')).data));
  op.post('/reset', async (req, res) => res.json((await core(req, 'POST', '/v1/test/reset')).data));
  app.use('/v1/operator', op);

  app.use((_req, res) => res.status(404).json({ error: 'NOT_FOUND' }));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => {
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'INVALID_JSON' });
    if (err.status && err.status < 600) return res.status(err.status).json({ error: err.code || 'ERROR', message: err.message, requestId: req.id });
    log({ level: 'error', msg: err.message, id: req.id });
    res.status(500).json({ error: 'INTERNAL_ERROR', requestId: req.id });
  });
  return app;
}

module.exports = { createApp, parseCreditTransfer };
