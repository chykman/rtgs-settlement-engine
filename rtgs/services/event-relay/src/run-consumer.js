'use strict';
const fs = require('node:fs');
const { createPool } = require('./db');
const { makeKafka, ensureTopics, TOPIC, DLQ_TOPIC } = require('./kafka');
const { processMessage } = require('./sink');

const HEARTBEAT = '/tmp/healthy';
const beat = () => { try { fs.writeFileSync(HEARTBEAT, String(Date.now())); } catch { /* read-only fs in dev */ } };

async function main() {
  const pool = createPool();
  const kafka = makeKafka(process.env, 'rtgs-message-sink');

  // Do not depend on the relay having created the topic first: auto-create is off, and subscribing to a
  // missing topic fails. ensureTopics is idempotent.
  await ensureTopics(kafka, [TOPIC, { topic: DLQ_TOPIC, numPartitions: 1 }]);

  const dlq = kafka.producer();
  await dlq.connect();
  const consumer = kafka.consumer({ groupId: process.env.KAFKA_GROUP_ID || 'rtgs-message-sink' });
  await consumer.connect();
  await consumer.subscribe({ topic: TOPIC, fromBeginning: true });

  // Offsets are committed only after the handler returns, i.e. after the row is in Postgres (or the
  // poison message is safely on the DLQ). A crash replays the message; the primary key makes that harmless.
  await consumer.run({
    eachMessage: async ({ topic, partition, message }) => {
      await processMessage(
        pool, dlq,
        { topic, partition, offset: message.offset, key: message.key, value: message.value },
        { dlqTopic: DLQ_TOPIC },
      );
      beat();
    },
  });
  setInterval(beat, 15000).unref();             // idle consumers are still healthy
  beat();
  console.log(`message sink started, topic=${TOPIC}, dlq=${DLQ_TOPIC}`);

  const stop = async () => {
    await consumer.disconnect().catch(() => {});
    await dlq.disconnect().catch(() => {});
    await pool.end();
    process.exit(0);
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

main().catch((e) => { console.error(e); process.exit(1); });
