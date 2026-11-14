'use strict';

class PoisonMessageError extends Error {
  constructor(message) { super(message); this.name = 'PoisonMessageError'; }
}

function parse(value) {
  let m;
  try { m = JSON.parse(value.toString()); } catch { throw new PoisonMessageError('not valid JSON'); }
  if (!m || !Number.isSafeInteger(m.outboxId) || !m.aggregateId || !m.eventType) {
    throw new PoisonMessageError('missing outboxId, aggregateId or eventType');
  }
  return m;
}

/**
 * Persist one Kafka message into message_store. Idempotent: outbox_id is the primary key, so a
 * redelivered message (relay retry, consumer rebalance) is a no-op.
 * Returns 'stored' or 'duplicate'. Throws PoisonMessageError for a message that can never be stored.
 * Database errors propagate: the offset is not committed and the message is retried.
 */
async function storeMessage(pool, { topic, partition, offset, value }) {
  const m = parse(value);
  const res = await pool.query(
    `INSERT INTO message_store (outbox_id, event_type, aggregate_id, topic, partition_no, kafka_offset, payload)
     VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (outbox_id) DO NOTHING`,
    [m.outboxId, m.eventType, m.aggregateId, topic, partition, Number(offset), JSON.stringify(m.payload)],
  );
  return res.rowCount === 1 ? 'stored' : 'duplicate';
}

/**
 * Store a message, or park it on the dead-letter topic if it is malformed, with the reason and its
 * origin in headers so it can be inspected later. If the DLQ send itself fails the error propagates,
 * so the message is retried rather than lost.
 * Returns 'stored' | 'duplicate' | 'dead-lettered'.
 */
async function processMessage(pool, dlqProducer, msg, { dlqTopic, log = console }) {
  try {
    return await storeMessage(pool, msg);
  } catch (e) {
    if (!(e instanceof PoisonMessageError)) throw e;
    await dlqProducer.send({
      topic: dlqTopic,
      messages: [{
        key: msg.key ?? null,
        value: msg.value,
        headers: {
          'dlq-reason': e.message,
          'source-topic': msg.topic,
          'source-partition': String(msg.partition),
          'source-offset': String(msg.offset),
        },
      }],
    });
    log.error(`dead-lettered ${msg.topic}[${msg.partition}]@${msg.offset}: ${e.message}`);
    return 'dead-lettered';
  }
}

module.exports = { storeMessage, processMessage, PoisonMessageError };
