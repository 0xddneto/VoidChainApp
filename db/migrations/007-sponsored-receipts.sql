BEGIN;
CREATE TABLE IF NOT EXISTS sponsored_transactions (
    chain_id        SMALLINT NOT NULL REFERENCES chains(id) ON DELETE CASCADE,
    tx_hash         BYTEA NOT NULL,
    log_index       INTEGER NOT NULL,
    block_number    BIGINT NOT NULL,
    user_address    BYTEA NOT NULL,
    relayer_address BYTEA NOT NULL,
    target_address  BYTEA,
    success         BOOLEAN NOT NULL,
    toll            NUMERIC(78, 0) NOT NULL,
    gas_void        NUMERIC(78, 0) NOT NULL,
    margin_void     NUMERIC(78, 0) NOT NULL,
    eth_reimbursed  NUMERIC(78, 0) NOT NULL,
    failure_reason  BYTEA,
    timestamp       TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (chain_id, tx_hash, log_index)
);
CREATE INDEX IF NOT EXISTS sponsored_recent ON sponsored_transactions (chain_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS sponsored_failures ON sponsored_transactions (success, timestamp DESC);
COMMIT;
