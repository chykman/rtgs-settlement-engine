-- Transactional outbox. Rows are inserted in the SAME transaction as the payment state change
-- (see engine.js audit()), so "DB commit succeeded" implies "event will eventually reach Kafka".
-- The event-relay worker publishes unpublished rows and stamps published_at. Delivery is
-- at-least-once; consumers de-duplicate on outbox.id.
CREATE TABLE IF NOT EXISTS outbox (
  id              BIGSERIAL PRIMARY KEY,
  aggregate_type  VARCHAR(50)  NOT NULL,
  aggregate_id    UUID         NOT NULL,
  event_type      VARCHAR(100) NOT NULL,      -- ISO 20022 message id, e.g. pacs.008.001.08
  payload         JSONB        NOT NULL,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  published_at    TIMESTAMPTZ NULL
);
CREATE INDEX IF NOT EXISTS outbox_unpublished_idx ON outbox (id) WHERE published_at IS NULL;
CREATE INDEX IF NOT EXISTS outbox_aggregate_idx ON outbox (aggregate_id, id);

-- Kafka -> database sink. The event-consumer writes every message it reads here.
-- PRIMARY KEY on outbox_id makes the consumer idempotent against redelivery.
CREATE TABLE IF NOT EXISTS message_store (
  outbox_id     BIGINT PRIMARY KEY,
  event_type    VARCHAR(100) NOT NULL,
  aggregate_id  UUID         NOT NULL,
  topic         TEXT         NOT NULL,
  partition_no  INT          NOT NULL,
  kafka_offset  BIGINT       NOT NULL,
  payload       JSONB        NOT NULL,
  stored_at     TIMESTAMPTZ  NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS message_store_aggregate_idx ON message_store (aggregate_id, outbox_id);
