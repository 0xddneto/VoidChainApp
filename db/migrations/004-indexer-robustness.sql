BEGIN;

ALTER TABLE chain_revenue ADD COLUMN IF NOT EXISTS log_index INTEGER NOT NULL DEFAULT 0;
ALTER TABLE chain_revenue DROP CONSTRAINT IF EXISTS chain_revenue_pkey;
ALTER TABLE chain_revenue ADD PRIMARY KEY (chain_id, tx_hash, log_index);
ALTER TABLE indexer_state ADD COLUMN IF NOT EXISTS last_indexed_hash BYTEA;

CREATE TABLE IF NOT EXISTS profile_requests (
    client_hash BYTEA NOT NULL,
    user_address BYTEA NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS profile_requests_client_recent ON profile_requests (client_hash, created_at DESC);
CREATE INDEX IF NOT EXISTS profile_requests_user_recent ON profile_requests (user_address, created_at DESC);

COMMIT;
