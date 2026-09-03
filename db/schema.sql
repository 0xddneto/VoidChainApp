-- VoidScan — data model
--
-- Principle: one row per (chain, entity). Every table carries chain_id because
-- the 1,111 chains are isolated and nothing in them is comparable across chains
-- without that qualification. A transaction hash is NOT unique across chains.

-- ---------------------------------------------------------------------------
-- Chains
-- ---------------------------------------------------------------------------

CREATE TABLE chains (
    -- The NFT's tokenId, 1..1111. The natural key of the whole system.
    id              SMALLINT PRIMARY KEY CHECK (id BETWEEN 1 AND 1111),

    -- Immutable, derived on-chain: CHAIN_ID_BASE + id - 1
    chain_id        BIGINT NOT NULL UNIQUE,

    -- A mirror of the VoidChainDeed contract. Updated by event, never edited here.
    name            TEXT,
    description     TEXT,
    image_uri       TEXT,
    external_url    TEXT,
    owner_address   BYTEA,

    -- Lifecycle. The four states are distinct on purpose:
    --   reserved — minted, no runtime; no cost, nobody can call it
    --   live     — activated in VoidChainAppRuntime, accepting calls
    --   paused   — deactivated by the owner; state and history remain
    --   created  — inherited from the L3 model ("rollup up, no node"). A
    --              chainapp never passes through it: activation is one call.
    -- Active does NOT mean "producing blocks". A chainapp has no blocks of its
    -- own; it is ordered by Robinhood's blocks.
    -- These names mirror ChainStatus in apps/web/lib/chains.ts. Diverging
    -- between the two makes the indexer violate the constraint on its first write.
    status          TEXT NOT NULL DEFAULT 'reserved'
                    CHECK (status IN ('reserved', 'created', 'live', 'paused')),
    activated_at    TIMESTAMPTZ,

    rpc_url         TEXT,
    -- Chains with recent activity used to be followed over WebSocket; the rest,
    -- by sweeping. This flag is recomputed by the indexer, never edited by hand.
    is_hot          BOOLEAN NOT NULL DEFAULT FALSE,

    last_indexed_block BIGINT NOT NULL DEFAULT 0,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The sweep cursor.
--
-- Global, and not per chain: there is a single log, Robinhood's, and all 1,111
-- chains come out of the same read. While each chain was a rollup with its own
-- RPC, the position lived in chains.last_indexed_block — which stays in the
-- table, unused, because removing it does not pay for the migration.
CREATE TABLE indexer_state (
    -- A single row. The constraint makes a second indexer pointed at this
    -- database fail to insert, instead of silently keeping a parallel cursor.
    id                 BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
    last_indexed_block BIGINT NOT NULL DEFAULT 0,
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The indexer only has one valid source deployment at a time.  Keeping this
-- fingerprint prevents an old test deployment from being shown as ownership or
-- activity for a newly deployed collection that happens to reuse token IDs.
CREATE TABLE indexer_deployment (
    id                 BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
    runtime_address    BYTEA NOT NULL,
    deed_address       BYTEA NOT NULL,
    deploy_block       BIGINT NOT NULL,
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE chain_socials (
    chain_id        SMALLINT NOT NULL REFERENCES chains(id) ON DELETE CASCADE,
    platform        TEXT NOT NULL,
    handle          TEXT NOT NULL,
    PRIMARY KEY (chain_id, platform)
);

-- ---------------------------------------------------------------------------
-- The chain of activity
-- ---------------------------------------------------------------------------

CREATE TABLE blocks (
    chain_id        SMALLINT NOT NULL REFERENCES chains(id) ON DELETE CASCADE,
    number          BIGINT NOT NULL,
    hash            BYTEA NOT NULL,
    parent_hash     BYTEA NOT NULL,
    timestamp       TIMESTAMPTZ NOT NULL,
    tx_count        INTEGER NOT NULL DEFAULT 0,
    gas_used        NUMERIC(78, 0) NOT NULL DEFAULT 0,
    base_fee        NUMERIC(78, 0),
    PRIMARY KEY (chain_id, number)
);

CREATE INDEX blocks_recent ON blocks (chain_id, timestamp DESC);

CREATE TABLE transactions (
    chain_id        SMALLINT NOT NULL REFERENCES chains(id) ON DELETE CASCADE,
    hash            BYTEA NOT NULL,
    block_number    BIGINT NOT NULL,
    tx_index        INTEGER NOT NULL,
    from_address    BYTEA NOT NULL,
    to_address      BYTEA,
    value           NUMERIC(78, 0) NOT NULL DEFAULT 0,
    gas_used        NUMERIC(78, 0),
    -- Parent chain gas, in ETH. The payer is the sender of the transaction on
    -- Robinhood — or the paymaster, when the call is sponsored.
    effective_gas_price NUMERIC(78, 0),
    status          SMALLINT,
    timestamp       TIMESTAMPTZ NOT NULL,
    -- true when to_address is null: a contract creation.
    created_contract BYTEA,

    -- Index of the `Executed` log inside the parent transaction. One transaction
    -- can call the same chain several times, and without this in the key only
    -- the first call would be recorded.
    log_index       SMALLINT NOT NULL DEFAULT 0,
    -- The chain's toll, in VOID. It is not the gas: they are charges from two
    -- different systems over the same transaction, and adding them would mean
    -- nothing.
    toll            NUMERIC(78, 0) NOT NULL DEFAULT 0,

    PRIMARY KEY (chain_id, hash, log_index)
);

CREATE INDEX tx_recent   ON transactions (chain_id, timestamp DESC);
CREATE INDEX tx_from     ON transactions (chain_id, from_address, timestamp DESC);
CREATE INDEX tx_to       ON transactions (chain_id, to_address, timestamp DESC);

CREATE TABLE contracts (
    chain_id        SMALLINT NOT NULL REFERENCES chains(id) ON DELETE CASCADE,
    address         BYTEA NOT NULL,
    deployer        BYTEA NOT NULL,
    deployed_at     TIMESTAMPTZ NOT NULL,
    deploy_tx       BYTEA NOT NULL,
    -- Filled in by source verification, optional.
    name            TEXT,
    is_verified     BOOLEAN NOT NULL DEFAULT FALSE,
    -- Heuristic classification by detected interface (erc20, erc721, dex, ...).
    kind            TEXT,
    PRIMARY KEY (chain_id, address)
);

-- ---------------------------------------------------------------------------
-- Metrics for the home page grid
-- ---------------------------------------------------------------------------

-- Aggregated per chain and per day. The home grid reads from here, and never
-- scans the transactions table: with 1,111 chains that would be unworkable on
-- every visit.
CREATE TABLE chain_daily_stats (
    chain_id        SMALLINT NOT NULL REFERENCES chains(id) ON DELETE CASCADE,
    day             DATE NOT NULL,
    tx_count        INTEGER NOT NULL DEFAULT 0,
    active_addresses INTEGER NOT NULL DEFAULT 0,
    contracts_deployed INTEGER NOT NULL DEFAULT 0,
    gas_spent       NUMERIC(78, 0) NOT NULL DEFAULT 0,
    PRIMARY KEY (chain_id, day)
);

-- Current state, one record per chain, to sort and filter the grid.
CREATE TABLE chain_summary (
    chain_id        SMALLINT PRIMARY KEY REFERENCES chains(id) ON DELETE CASCADE,
    total_txs       BIGINT NOT NULL DEFAULT 0,
    total_contracts INTEGER NOT NULL DEFAULT 0,
    total_addresses BIGINT NOT NULL DEFAULT 0,
    txs_24h         INTEGER NOT NULL DEFAULT 0,
    -- Activity index normalized 0..100, used by the grid's default ordering.
    activity_score  SMALLINT NOT NULL DEFAULT 0,
    last_block_at   TIMESTAMPTZ,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Visitor profile — off-chain on purpose
-- ---------------------------------------------------------------------------

-- A nickname and an avatar, held in a database like any other site holds them.
-- Nothing here carries weight: authority over a chain is NEVER read from this
-- table, always from ownerOf().
CREATE TABLE user_profiles (
    address         BYTEA PRIMARY KEY,
    display_name    TEXT,
    avatar_uri      TEXT,
    bio             TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE user_socials (
    address         BYTEA NOT NULL REFERENCES user_profiles(address) ON DELETE CASCADE,
    platform        TEXT NOT NULL,
    handle          TEXT NOT NULL,
    PRIMARY KEY (address, platform)
);

-- ---------------------------------------------------------------------------
-- Governance — a read mirror of VoidChainGovernor
-- ---------------------------------------------------------------------------

CREATE TABLE proposals (
    chain_id        SMALLINT NOT NULL REFERENCES chains(id) ON DELETE CASCADE,
    proposal_id     BIGINT NOT NULL,
    proposer        BYTEA NOT NULL,
    description     TEXT NOT NULL,
    action_hash     BYTEA NOT NULL,
    snapshot_block  BIGINT NOT NULL,
    deadline        TIMESTAMPTZ NOT NULL,
    for_votes       NUMERIC(78, 0) NOT NULL DEFAULT 0,
    against_votes   NUMERIC(78, 0) NOT NULL DEFAULT 0,
    executed        BOOLEAN NOT NULL DEFAULT FALSE,
    PRIMARY KEY (chain_id, proposal_id)
);

-- ---------------------------------------------------------------------------
-- The owner's financial panel — revenue and expenses per chain
-- ---------------------------------------------------------------------------

-- Revenue: an exact mirror of VoidChainTreasury's RevenueSettled events. Every
-- value here is verifiable on-chain; nothing is estimated.
CREATE TABLE chain_revenue (
    chain_id        SMALLINT NOT NULL REFERENCES chains(id) ON DELETE CASCADE,
    settled_at      TIMESTAMPTZ NOT NULL,
    tx_hash         BYTEA NOT NULL,
    gross           NUMERIC(78, 0) NOT NULL,
    -- The AEP licence is NOT collected by our treasury: Arbitrum's own
    -- RewardDistributor splits it at the source, before the revenue ever
    -- reaches us. The column stays at zero on the chainapp path and exists for
    -- an L3 whose revenue arrives gross across the bridge.
    aep_fee         NUMERIC(78, 0) NOT NULL,
    protocol_fee    NUMERIC(78, 0) NOT NULL,   -- 2% VOIDS, see PROTOCOL_BPS
    holder_share    NUMERIC(78, 0) NOT NULL,   -- the rest, to the NFT owner
    holder_address  BYTEA NOT NULL,            -- who owned it at the time
    PRIMARY KEY (chain_id, tx_hash)
);

CREATE INDEX revenue_by_chain ON chain_revenue (chain_id, settled_at DESC);
CREATE INDEX revenue_by_holder ON chain_revenue (holder_address, settled_at DESC);

-- Expenses. Unlike revenue, NOTHING here is on-chain: these are real-world
-- operating costs. Two origins, and the distinction has to stay visible in the
-- interface so the owner does not confuse what is measured with what is declared.
CREATE TABLE chain_expenses (
    id              BIGSERIAL PRIMARY KEY,
    chain_id        SMALLINT NOT NULL REFERENCES chains(id) ON DELETE CASCADE,
    period_start    DATE NOT NULL,
    period_end      DATE NOT NULL,
    category        TEXT NOT NULL
                    CHECK (category IN ('node', 'rpc', 'storage', 'indexer', 'activation', 'other')),
    -- 'measured' = billed by us, the exact amount we charged.
    -- 'declared' = entered by the owner themselves (they host it on their own,
    --              hired a developer, and so on). Informational; it never enters
    --              a fee calculation.
    source          TEXT NOT NULL CHECK (source IN ('measured', 'declared')),
    amount_usd      NUMERIC(18, 6) NOT NULL,
    note            TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX expenses_by_chain ON chain_expenses (chain_id, period_start DESC);
