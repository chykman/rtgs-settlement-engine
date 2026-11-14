-- RTGS core schema. Amounts are integer minor units (cents). SIMULATION ONLY.
CREATE TABLE IF NOT EXISTS accounts (
  id               TEXT PRIMARY KEY,
  name             TEXT   NOT NULL,
  opening_balance  BIGINT NOT NULL CHECK (opening_balance >= 0),
  balance          BIGINT NOT NULL CHECK (balance >= 0)          -- a settlement account can never go negative
);

CREATE TABLE IF NOT EXISTS payments (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key  TEXT   NOT NULL UNIQUE,
  request_hash     TEXT   NOT NULL,
  end_to_end_id    TEXT,
  debtor           TEXT   NOT NULL REFERENCES accounts(id),
  creditor         TEXT   NOT NULL REFERENCES accounts(id),
  amount           BIGINT NOT NULL CHECK (amount > 0),
  currency         TEXT   NOT NULL,
  priority         INT    NOT NULL DEFAULT 5,
  status           TEXT   NOT NULL CHECK (status IN ('RECEIVED','QUEUED','SETTLED','REJECTED','CANCELLED')),
  reason           TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  settled_at       TIMESTAMPTZ,
  CHECK (debtor <> creditor)
);
CREATE INDEX IF NOT EXISTS payments_queue_idx ON payments (priority DESC, created_at, id) WHERE status = 'QUEUED';
CREATE INDEX IF NOT EXISTS payments_status_idx ON payments (status, created_at DESC);

-- Double-entry ledger: every settled payment writes exactly one debit and one credit.
CREATE TABLE IF NOT EXISTS ledger_entries (
  id          BIGSERIAL PRIMARY KEY,
  payment_id  UUID   NOT NULL REFERENCES payments(id),
  account_id  TEXT   NOT NULL REFERENCES accounts(id),
  direction   TEXT   NOT NULL CHECK (direction IN ('D','C')),
  amount      BIGINT NOT NULL CHECK (amount > 0),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ledger_account_idx ON ledger_entries (account_id, id);

-- Append-only audit trail of every state change.
CREATE TABLE IF NOT EXISTS audit_log (
  id          BIGSERIAL PRIMARY KEY,
  payment_id  UUID,
  from_status TEXT,
  to_status   TEXT NOT NULL,
  detail      JSONB NOT NULL DEFAULT '{}',
  at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_payment_idx ON audit_log (payment_id, id);

CREATE TABLE IF NOT EXISTS system_state (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
INSERT INTO system_state (key, value) VALUES ('status', 'OPEN') ON CONFLICT DO NOTHING;

-- Make the ledger and audit log tamper-evident: no UPDATE or DELETE.
CREATE OR REPLACE FUNCTION forbid_mutation() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION 'append-only table: % not allowed on %', TG_OP, TG_TABLE_NAME; END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS ledger_append_only ON ledger_entries;
CREATE TRIGGER ledger_append_only BEFORE UPDATE OR DELETE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
DROP TRIGGER IF EXISTS audit_append_only ON audit_log;
CREATE TRIGGER audit_append_only BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
