'use strict';
const fs = require('node:fs');
const { Kafka, logLevel } = require('kafkajs');

const TOPIC = process.env.KAFKA_TOPIC || 'rtgs.payment-events';
const DLQ_TOPIC = process.env.KAFKA_DLQ_TOPIC || 'rtgs.dlq';

/** Build a kafkajs client from env. KAFKA_SECURITY_PROTOCOL: SASL_PLAINTEXT (default) | SASL_SSL. */
function makeKafka(env = process.env, clientId = 'rtgs-events') {
  const protocol = env.KAFKA_SECURITY_PROTOCOL || 'SASL_PLAINTEXT';
  const cfg = {
    clientId,
    brokers: (env.KAFKA_BROKERS || 'kafka:9092').split(','),
    logLevel: logLevel.WARN,
    retry: { initialRetryTime: 300, retries: 10 },
  };
  if (protocol.includes('SSL')) {
    cfg.ssl = env.KAFKA_CA_FILE ? { ca: [fs.readFileSync(env.KAFKA_CA_FILE, 'utf8')] } : true;
  }
  if (protocol.startsWith('SASL')) {
    cfg.sasl = { mechanism: 'plain', username: env.KAFKA_USERNAME, password: env.KAFKA_PASSWORD };
  }
  return new Kafka(cfg);
}

/**
 * Create topics if missing (auto-create is disabled on the broker). Idempotent, so every service that
 * needs a topic calls it on start-up instead of relying on another container having run first.
 * `topics` is a list of names or { topic, numPartitions } objects.
 */
async function ensureTopics(kafka, topics) {
  const admin = kafka.admin();
  await admin.connect();
  try {
    await admin.createTopics({
      waitForLeaders: true,
      topics: topics.map((t) => {
        const spec = typeof t === 'string' ? { topic: t } : t;
        return {
          numPartitions: Number(process.env.KAFKA_PARTITIONS || 3),
          replicationFactor: Number(process.env.KAFKA_REPLICATION || 1),
          ...spec,
        };
      }),
    });
  } finally {
    await admin.disconnect();
  }
}

module.exports = { makeKafka, ensureTopics, TOPIC, DLQ_TOPIC };
