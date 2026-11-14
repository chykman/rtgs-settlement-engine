'use strict';
const crypto = require('node:crypto');
const { ValidationError } = require('./money');
const iso = require('./iso20022');

class ConflictError extends Error {
  constructor(message) { super(message); this.code = 'IDEMPOTENCY_CONFLICT'; this.status = 422; }
}
class NotFoundError extends Error {
  constructor(message) { super(message); this.code = 'NOT_FOUND'; this.status = 404; }
}
class StateError extends Error {
  constructor(message) { super(message); this.code = 'INVALID_STATE'; this.status = 409; }
}

// Transactional outbox: queue the ISO 20022 event on the caller's transaction. Nothing here talks to
// Kafka; the event-relay worker publishes committed rows. Rolled-back work leaves no event behind.
async function emitEvent(c, paymentId, toStatus) {
  const { rows } = await c.query('SELECT * FROM payments WHERE id=$1', [paymentId]);
  const { eventType, payload } = iso.eventFor(rows[0], toStatus);
  await c.query(
    `INSERT INTO outbox (aggregate_type, aggregate_id, event_type, payload) VALUES ('payment',$1,$2,$3)`,
    [paymentId, eventType, JSON.stringify(payload)],
  );
}

// Every state change calls audit() AFTER updating the payment row, inside the same transaction.
async function audit(c, paymentId, from, to, detail = {}) {
  await c.query(
    'INSERT INTO audit_log (payment_id, from_status, to_status, detail) VALUES ($1,$2,$3,$4)',
    [paymentId, from, to, JSON.stringify(detail)],
  );
  if (paymentId) await emitEvent(c, paymentId, to);
}

async function systemOpen(c) {
  const { rows } = await c.query(`SELECT value FROM system_state WHERE key='status'`);
  return rows[0]?.value === 'OPEN';
}

// Lock both accounts in a fixed (alphabetical) order so concurrent payments can never deadlock.
async function lockAccounts(c, ids) {
  const { rows } = await c.query(
    'SELECT id, balance FROM accounts WHERE id = ANY($1) ORDER BY id FOR UPDATE',
    [ids],
  );
  return Object.fromEntries(rows.map((r) => [r.id, r.balance]));
}

/**
 * Try to settle one payment inside the caller's transaction.
 * Returns 'SETTLED' or 'QUEUED'. Debit, credit, ledger rows and the status change are one atomic unit.
 * `fault` is a test hook used to prove atomicity (rollback of a half-applied settlement).
 */
async function trySettle(c, p, { fault, fromStatus }) {
  const bal = await lockAccounts(c, [p.debtor, p.creditor]);
  if (bal[p.debtor] === undefined || bal[p.creditor] === undefined) return 'REJECT_UNKNOWN_ACCOUNT';

  // Queue discipline: do not let a new payment overtake an equal-or-higher priority payment
  // from the same debtor that is already waiting.
  const { rowCount: ahead } = await c.query(
    `SELECT 1 FROM payments WHERE status='QUEUED' AND debtor=$1 AND priority >= $2 AND id <> $3 LIMIT 1`,
    [p.debtor, p.priority, p.id],
  );
  const hasLiquidity = bal[p.debtor] >= p.amount;
  if (!hasLiquidity || (ahead > 0 && fromStatus === 'RECEIVED')) {
    if (fromStatus !== 'QUEUED') {
      await c.query(`UPDATE payments SET status='QUEUED', reason='INSUFFICIENT_LIQUIDITY' WHERE id=$1`, [p.id]);
      await audit(c, p.id, fromStatus, 'QUEUED', { debtorBalance: bal[p.debtor], needed: p.amount });
    }
    return 'QUEUED';
  }

  await c.query('UPDATE accounts SET balance = balance - $1 WHERE id = $2', [p.amount, p.debtor]);
  if (fault === 'after-debit') throw new Error('injected fault after debit');
  await c.query('UPDATE accounts SET balance = balance + $1 WHERE id = $2', [p.amount, p.creditor]);
  await c.query(
    `INSERT INTO ledger_entries (payment_id, account_id, direction, amount) VALUES ($1,$2,'D',$3), ($1,$4,'C',$3)`,
    [p.id, p.debtor, p.amount, p.creditor],
  );
  await c.query(`UPDATE payments SET status='SETTLED', reason=NULL, settled_at=now() WHERE id=$1`, [p.id]);
  await audit(c, p.id, fromStatus, 'SETTLED', { debtor: p.debtor, creditor: p.creditor, amount: p.amount });
  return 'SETTLED';
}

function hashRequest(input) {
  return crypto.createHash('sha256').update(JSON.stringify([
    input.debtor, input.creditor, input.amount, input.currency, input.priority, input.endToEndId ?? null,
  ])).digest('hex');
}

function validateShape(input) {
  if (!input || typeof input !== 'object') throw new ValidationError('body required');
  if (typeof input.idempotencyKey !== 'string' || !/^[\w.:-]{8,100}$/.test(input.idempotencyKey)) {
    throw new ValidationError('idempotencyKey must be 8-100 chars of [A-Za-z0-9_.:-]');
  }
  for (const f of ['debtor', 'creditor', 'currency']) {
    if (typeof input[f] !== 'string' || !input[f]) throw new ValidationError(`${f} required`);
  }
  if (!Number.isSafeInteger(input.amount) || input.amount <= 0) throw new ValidationError('amount must be a positive integer (minor units)');
  if (!Number.isInteger(input.priority) || input.priority < 0 || input.priority > 9) throw new ValidationError('priority must be an integer 0-9');
}

async function getPayment(db, id) {
  const { rows } = await db.query('SELECT * FROM payments WHERE id=$1', [id]);
  if (!rows[0]) throw new NotFoundError('payment not found');
  return rows[0];
}

/** Submit a payment. Idempotent on idempotencyKey. */
async function submitPayment(pool, input, { fault } = {}) {
  validateShape(input);
  const requestHash = hashRequest(input);
  const c = await pool.connect();
  let result;
  try {
    await c.query('BEGIN');

    // Lock the participants FIRST, in a fixed order, before inserting the payment row.
    // (Inserting first takes FOR KEY SHARE locks via the foreign keys; two payments on the same
    // accounts would then each hold a share lock and wait for the other's FOR UPDATE -> deadlock.)
    await lockAccounts(c, [input.debtor, input.creditor]);

    const ins = await c.query(
      `INSERT INTO payments (idempotency_key, request_hash, end_to_end_id, debtor, creditor, amount, currency, priority, status)
       SELECT $1,$2,$3,$4,$5,$6,$7,$8,'RECEIVED'
       WHERE EXISTS (SELECT 1 FROM accounts WHERE id=$4) AND EXISTS (SELECT 1 FROM accounts WHERE id=$5) AND $4 <> $5
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING *`,
      [input.idempotencyKey, requestHash, input.endToEndId ?? null, input.debtor, input.creditor, input.amount, input.currency, input.priority],
    );

    if (!ins.rows[0]) {
      const { rows } = await c.query('SELECT * FROM payments WHERE idempotency_key=$1', [input.idempotencyKey]);
      if (rows[0]) {
        if (rows[0].request_hash !== requestHash) throw new ConflictError('idempotencyKey reused with a different request');
        await c.query('COMMIT');
        return { payment: rows[0], replay: true };
      }
      // Not a replay: the insert was filtered out -> unknown account or same-account payment.
      // Record the rejection without FK-violating columns, in the audit trail only.
      await audit(c, null, null, 'REJECTED', { reason: 'INVALID_PARTICIPANTS', debtor: input.debtor, creditor: input.creditor, idempotencyKey: input.idempotencyKey });
      await c.query('COMMIT');
      throw Object.assign(new ValidationError('unknown participant or debtor equals creditor', 'INVALID_PARTICIPANTS'), { status: 422 });
    }

    let p = ins.rows[0];
    await audit(c, p.id, null, 'RECEIVED', { idempotencyKey: p.idempotency_key });

    if (!(await systemOpen(c))) {
      await c.query(`UPDATE payments SET status='REJECTED', reason='SYSTEM_CLOSED' WHERE id=$1`, [p.id]);
      await audit(c, p.id, 'RECEIVED', 'REJECTED', { reason: 'SYSTEM_CLOSED' });
    } else {
      await trySettle(c, p, { fault, fromStatus: 'RECEIVED' });
    }
    p = await getPayment(c, p.id);
    await c.query('COMMIT');
    result = { payment: p, replay: false };
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
  if (result.payment.status === 'SETTLED') await drainQueue(pool);   // incoming funds may release queued payments
  if (result.payment.status === 'SETTLED' || result.payment.status === 'QUEUED') {
    result.payment = await getPayment(pool, result.payment.id);
  }
  return result;
}

/**
 * Release queued payments in priority/FIFO order until nothing more can settle.
 * Serialised with an advisory lock; account locks use the same order as submitPayment, so no deadlocks.
 */
async function drainQueue(pool) {
  const c = await pool.connect();
  let settled = 0;
  try {
    await c.query('BEGIN');
    await c.query('SELECT pg_advisory_xact_lock(4242)');
    if (await systemOpen(c)) {
      // Take every account lock up front in id order: later lock requests are no-ops,
      // so the drain can never form a lock cycle with concurrent submissions.
      await c.query('SELECT id FROM accounts ORDER BY id FOR UPDATE');
      let progress = true;
      while (progress) {
        progress = false;
        const { rows } = await c.query(`SELECT * FROM payments WHERE status='QUEUED' ORDER BY priority DESC, created_at, id`);
        for (const p of rows) {
          const r = await trySettle(c, p, { fromStatus: 'QUEUED' });
          if (r === 'SETTLED') { settled += 1; progress = true; }
        }
      }
    }
    await c.query('COMMIT');
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
  return settled;
}

async function cancelPayment(pool, id, reason = 'CANCELLED_BY_PARTICIPANT') {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const { rows } = await c.query('SELECT * FROM payments WHERE id=$1 FOR UPDATE', [id]);
    if (!rows[0]) throw new NotFoundError('payment not found');
    if (rows[0].status !== 'QUEUED') throw new StateError(`only QUEUED payments can be cancelled (status is ${rows[0].status})`);
    await c.query(`UPDATE payments SET status='CANCELLED', reason=$2 WHERE id=$1`, [id, reason]);
    await audit(c, id, 'QUEUED', 'CANCELLED', { reason });
    await c.query('COMMIT');
    return getPayment(pool, id);
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
}

/** End of day: stop accepting payments and cancel everything still waiting in the queue. */
async function closeSystem(pool) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query('SELECT pg_advisory_xact_lock(4242)');
    await c.query(`UPDATE system_state SET value='CLOSED' WHERE key='status'`);
    const { rows } = await c.query(`UPDATE payments SET status='CANCELLED', reason='END_OF_DAY' WHERE status='QUEUED' RETURNING id`);
    for (const r of rows) await audit(c, r.id, 'QUEUED', 'CANCELLED', { reason: 'END_OF_DAY' });
    await c.query('COMMIT');
    return { status: 'CLOSED', cancelled: rows.length };
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
}

async function openSystem(pool) {
  await pool.query(`UPDATE system_state SET value='OPEN' WHERE key='status'`);
  return { status: 'OPEN' };
}

/** Independent re-computation of the books. ok=false means money was created, lost or half-applied. */
async function reconcile(pool) {
  const q = async (sql) => (await pool.query(sql)).rows;
  const [tot] = await q(`SELECT COALESCE(SUM(opening_balance),0)::bigint AS opening, COALESCE(SUM(balance),0)::bigint AS current FROM accounts`);
  const [led] = await q(`SELECT COALESCE(SUM(amount) FILTER (WHERE direction='D'),0)::bigint AS debits, COALESCE(SUM(amount) FILTER (WHERE direction='C'),0)::bigint AS credits FROM ledger_entries`);
  const drift = await q(`
    SELECT a.id, a.balance, a.opening_balance + COALESCE(SUM(CASE l.direction WHEN 'C' THEN l.amount ELSE -l.amount END),0)::bigint AS expected
    FROM accounts a LEFT JOIN ledger_entries l ON l.account_id = a.id
    GROUP BY a.id HAVING a.balance <> a.opening_balance + COALESCE(SUM(CASE l.direction WHEN 'C' THEN l.amount ELSE -l.amount END),0)`);
  const [neg] = await q(`SELECT COUNT(*)::int AS n FROM accounts WHERE balance < 0`);
  const [bad] = await q(`
    SELECT COUNT(*)::int AS n FROM payments p
    WHERE (p.status='SETTLED' AND (SELECT COUNT(*) FROM ledger_entries l WHERE l.payment_id=p.id) <> 2)
       OR (p.status<>'SETTLED' AND EXISTS (SELECT 1 FROM ledger_entries l WHERE l.payment_id=p.id))`);
  const checks = [
    { name: 'money_conserved', ok: tot.opening === tot.current, detail: { opening: tot.opening, current: tot.current } },
    { name: 'ledger_balanced', ok: led.debits === led.credits, detail: led },
    { name: 'balances_match_ledger', ok: drift.length === 0, detail: drift },
    { name: 'no_negative_balances', ok: neg.n === 0, detail: { count: neg.n } },
    { name: 'settled_iff_two_entries', ok: bad.n === 0, detail: { violations: bad.n } },
  ];
  return { ok: checks.every((x) => x.ok), checks };
}

module.exports = {
  submitPayment, drainQueue, cancelPayment, closeSystem, openSystem, reconcile, getPayment,
  ConflictError, NotFoundError, StateError,
};
