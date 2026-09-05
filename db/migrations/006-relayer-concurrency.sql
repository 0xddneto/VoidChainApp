BEGIN;

ALTER TABLE relay_requests ADD COLUMN IF NOT EXISTS paymaster_address BYTEA;
-- Nullable during the rolling deployment: the currently live V10 routes do
-- not send this column. New routes always do and are protected globally.
CREATE UNIQUE INDEX IF NOT EXISTS relay_requests_paymaster_nonce
    ON relay_requests (paymaster_address, user_address, user_nonce)
    WHERE paymaster_address IS NOT NULL;

CREATE TABLE IF NOT EXISTS relayer_transactions (
    tx_hash          BYTEA PRIMARY KEY,
    relayer_address  BYTEA NOT NULL,
    surface          TEXT NOT NULL,
    status           TEXT NOT NULL DEFAULT 'submitted'
                     CHECK (status IN ('submitted', 'confirmed', 'reverted')),
    submitted_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS relayer_transactions_pending
    ON relayer_transactions (relayer_address, status, submitted_at);

COMMIT;
