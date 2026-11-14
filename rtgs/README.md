# RTGS test platform (simulation only)

Fake money (XTS), fictional banks. Three services behind one published port.

```
services/rtgs-core     settlement engine: double-entry ledger, liquidity queue, idempotency, audit, reconcile
services/bank-gateway  participant API: pacs.008-style JSON, API-key auth, spoofing protection
web                    nginx + operator console
tests/e2e.test.js      gateway -> core -> Postgres over HTTP, incl. a core-outage drill
```

## Run the tests (needs Postgres; default postgres://postgres@localhost:5433/rtgs_test)
    (cd services/rtgs-core && npm ci) && (cd services/bank-gateway && npm ci)
    DATABASE_URL=postgres://... npm test

## Run with Docker
    cp .env.example .env     # edit secrets
    docker compose up -d --build --wait
    open http://localhost:8081

## Key behaviours
- A payment settles only if the debtor has liquidity, otherwise it waits in a queue (priority, then arrival).
- Debit + credit + ledger rows + status change are one database transaction.
- Same Idempotency-Key => same payment, never a second debit. Same key + different body => 422.
- Accounts are locked in a fixed order *before* the payment row is inserted (see engine.js) to avoid deadlocks.
- ledger_entries and audit_log are append-only (trigger). /v1/operator/reconcile recomputes the books independently.
- Only `web` is published; the core and DB sit on an internal network.

## Event pipeline: transactional outbox -> Kafka -> database

```
rtgs-core --(same DB transaction)--> payments + ledger + outbox
event-relay  --reads unpublished outbox rows--> Kafka topic rtgs.payment-events
event-consumer <-- Kafka --writes--> message_store  (idempotent on outbox_id)
```

- **Outbox:** `engine.js` calls `audit()` on every state change, which also inserts an ISO 20022 event into `outbox` in the same transaction. Core never talks to Kafka. A rollback leaves no event; a commit guarantees one.
- **Messages:** `pacs.008.001.08` when a payment is received, `pacs.002.001.10` (ACSC / PDNG / RJCT) on every later status. Payload holds the JSON-mapped document and the XML (`src/iso20022.js`).
- **Delivery:** at-least-once. The relay marks `published_at` only after Kafka acks, uses an advisory lock (single publisher, so ordering holds) and keys by payment id. The consumer's primary key on `outbox_id` absorbs duplicates.
- **Idempotency:** `payments.idempotency_key` is `UNIQUE NOT NULL`; the same key with a different body is a 422.
- **Images:** `services/kafka` (Kafka 3.6.2, KRaft, SASL/PLAIN, non-root UID 1001, read-only rootfs), `services/db` (postgres:16-alpine + migrations as init scripts), `services/event-relay`.

Extra secrets for deploy: `RTGS_KAFKA_CLUSTER_ID`, `RTGS_KAFKA_ADMIN_PASSWORD`, `RTGS_KAFKA_APP_PASSWORD`.

Known limits (simulation): SASL authenticates but there are no topic ACLs; the default listener is SASL_PLAINTEXT on a private network (set `KAFKA_SECURITY_PROTOCOL=SASL_SSL` and mount keystores for TLS); single broker, replication factor 1; malformed messages go to the `rtgs.dlq` topic (with reason and origin in headers) but nothing consumes or alerts on it yet.
