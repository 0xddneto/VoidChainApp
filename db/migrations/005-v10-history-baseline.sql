BEGIN;

CREATE TABLE IF NOT EXISTS chain_migration_baseline (
    chain_id INTEGER PRIMARY KEY,
    tx_count BIGINT NOT NULL DEFAULT 0,
    holder_revenue NUMERIC(78,0) NOT NULL DEFAULT 0,
    captured_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO chain_migration_baseline (chain_id, tx_count, holder_revenue)
SELECT c.id,
       COALESCE(s.total_txs, 0),
       COALESCE((SELECT sum(r.holder_share) FROM chain_revenue r WHERE r.chain_id = c.id), 0)
  FROM chains c
  LEFT JOIN chain_summary s ON s.chain_id = c.id
ON CONFLICT (chain_id) DO NOTHING;

-- V8 had not flushed Chain #1 at the cutoff, so its exact holder share lived
-- in Runtime.pending instead of chain_revenue. V10 imported that same on-chain
-- liability; include it once in the explorer baseline.
UPDATE chain_migration_baseline
   SET holder_revenue = 1512734364488066046500
 WHERE chain_id = 1 AND holder_revenue = 0;

COMMIT;
