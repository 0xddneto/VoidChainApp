BEGIN;
CREATE TABLE IF NOT EXISTS relay_ingress (
  client_hash BYTEA PRIMARY KEY,
  window_start TIMESTAMPTZ NOT NULL DEFAULT now(),
  attempts INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS relay_ingress_expiry ON relay_ingress(window_start);
ALTER TABLE relayer_transactions ADD COLUMN IF NOT EXISTS raw_transaction BYTEA;
ALTER TABLE relayer_transactions ADD COLUMN IF NOT EXISTS eoa_nonce BIGINT;
CREATE UNIQUE INDEX IF NOT EXISTS relayer_transactions_eoa_nonce
  ON relayer_transactions(relayer_address,eoa_nonce) WHERE eoa_nonce IS NOT NULL;
COMMIT;
