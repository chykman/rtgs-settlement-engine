'use strict';
const fs = require('node:fs');
const { createPool } = require('./db');
const { makeKafka, ensureTopics, TOPIC } = require('./kafka');
const { publishPending } = require('./relay');

const HEARTBEAT = '/tmp/healthy';          // mtime is checked by the container HEALTHCHECK
const POLL_MS = Number(process.env.RELAY_POLL_MS || 500);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const beat = () => { try { fs.writeFileSync(HEARTBEAT, String(Date.now())); } catch { /* read-only fs in dev */ } };

async function main() {
  const pool = createPool();
  const kafka = makeKafka(process.env, 'rtgs-outbox-relay');
  await ensureTopics(kafka, [TOPIC]);
  // Idempotent producer: broker-side de-duplication of retried sends within a session.
  const producer = kafka.producer({ idempotent: true, maxInFlightRequests: 1 });
  await producer.connect();

  let running = true;
  const stop = () => { running = false; };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  console.log(`outbox relay started, topic=${TOPIC}`);

  while (running) {
    try {
      const n = await publishPending(pool, producer, { topic: TOPIC });
      beat();
      if (n === 0) await sleep(POLL_MS);       // drained: wait; otherwise loop straight into the next batch
    } catch (e) {
      console.error(`relay error: ${e.message}`);
      await sleep(2000);
    }
  }
  await producer.disconnect().catch(() => {});
  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
