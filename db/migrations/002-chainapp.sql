-- ---------------------------------------------------------------------------
-- 002 — from the L3 model to the chainapp model
-- ---------------------------------------------------------------------------
--
-- The original schema assumed every chain was an Orbit rollup with its own RPC
-- and its own blocks. It is not any more: a chain is a row in
-- VoidChainAppRuntime, on Robinhood, and its activity is `Executed` events
-- tagged with the tokenId.
--
-- What changes as a consequence:
--
--   * One Robinhood transaction can contain SEVERAL `Executed` events for the
--     same chain (a batched call). The key (chain_id, hash) would drop all but
--     the first without complaint. The log index enters the key.
--
--   * The toll is charged in VOID and has nothing to do with the gas in ETH
--     Robinhood charges for the same transaction. They are two numbers, and
--     holding them in the same column would lose one of them.
--
--   * Of the four `status` values, only two describe a chainapp: 'reserved'
--     (minted, no runtime) and 'live' (activated, accepting calls). 'created'
--     meant "rollup contracts up, no node" and no longer exists. The values
--     stay in the CHECK because removing them would gain nothing; what changes
--     is who writes them and how the interface names them — 'live' is now
--     "active", not "producing blocks".

BEGIN;

ALTER TABLE transactions DROP CONSTRAINT transactions_pkey;

ALTER TABLE transactions
    ADD COLUMN log_index SMALLINT NOT NULL DEFAULT 0,
    -- The toll in VOID. Separate from effective_gas_price, which is parent gas.
    ADD COLUMN toll NUMERIC(78, 0) NOT NULL DEFAULT 0;

ALTER TABLE transactions ADD PRIMARY KEY (chain_id, hash, log_index);

-- The old rows came from the Nitro nodes that were shut down. They describe
-- nothing that still exists, and leaving them would make the home page add two
-- architectures together.
DELETE FROM transactions;
DELETE FROM blocks;
DELETE FROM contracts;
DELETE FROM chain_daily_stats;
DELETE FROM chain_summary;
DELETE FROM chains;

COMMIT;

-- The sweep cursor stops being per chain.
--
-- Before, each L3 had its own RPC and its own position, kept in
-- chains.last_indexed_block. Now there is a single log, Robinhood's, and all
-- 1,111 chains are read from the same sweep: the cursor is global, and does not
-- fit in a column of `chains`.
CREATE TABLE IF NOT EXISTS indexer_state (
    -- A single row. The constraint exists so that a second indexer pointed at
    -- the same database fails to insert instead of keeping a parallel cursor.
    id                 BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
    last_indexed_block BIGINT NOT NULL DEFAULT 0,
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
