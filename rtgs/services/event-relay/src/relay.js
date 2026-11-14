'use strict';

const RELAY_LOCK = 4343;

/**
 * Publish one batch of unpublished outbox rows to Kafka, then mark them published.
 * - One relay at a time (advisory lock) so per-payment ordering is preserved.
 * - Rows are only marked published after Kafka acknowledges them. If we crash between the send and the
 *   COMMIT the batch is sent again: delivery is at-least-once, and the consumer de-duplicates on outboxId.
 * - Kafka key = payment id, so all events of one payment land on one partition, in order.
 * `producer` is any object with kafkajs' `send({ topic, messages })`.
 * Returns the number of rows published.
 */
async function publishPending(pool, producer, { topic, batchSize = 100 }) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const { rows: [lock] } = await c.query('SELECT pg_try_advisory_xact_lock($1) AS got', [RELAY_LOCK]);
    if (!lock.got) { await c.query('ROLLBACK'); return 0; }

    const { rows } = await c.query(
      `SELECT id, aggregate_type, aggregate_id, event_type, payload
         FROM outbox WHERE published_at IS NULL ORDER BY id LIMIT $1`,
      [batchSize],
    );
    if (rows.length === 0) { await c.query('COMMIT'); return 0; }

    await producer.send({
      topic,
      messages: rows.map((r) => ({
        key: r.aggregate_id,
        value: JSON.stringify({
          outboxId: r.id,
          aggregateType: r.aggregate_type,
          aggregateId: r.aggregate_id,
          eventType: r.event_type,
          payload: r.payload,
        }),
        headers: { 'outbox-id': String(r.id), 'event-type': r.event_type },
      })),
    });

    await c.query('UPDATE outbox SET published_at = now() WHERE id = ANY($1)', [rows.map((r) => r.id)]);
    await c.query('COMMIT');
    return rows.length;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

module.exports = { publishPending };
