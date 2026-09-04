-- Persistent relayer admission control.
--
-- A serverless deployment can run many isolated processes, so an in-memory
-- rate limiter is not a security boundary. This table gives VoidScan and
-- VoidDEX one atomic user/nonce reservation and stores only a hash of the
-- network client identifier.

CREATE TABLE IF NOT EXISTS relay_requests (
    surface         TEXT NOT NULL,
    user_address    BYTEA NOT NULL,
    user_nonce      NUMERIC(78, 0) NOT NULL,
    client_hash     BYTEA NOT NULL,
    request_hash    BYTEA NOT NULL,
    status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'submitted', 'failed')),
    tx_hash         BYTEA,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at      TIMESTAMPTZ NOT NULL DEFAULT now() + interval '10 minutes',
    PRIMARY KEY (surface, user_address, user_nonce)
);

CREATE INDEX IF NOT EXISTS relay_requests_user_recent
    ON relay_requests (user_address, created_at DESC);
CREATE INDEX IF NOT EXISTS relay_requests_client_recent
    ON relay_requests (client_hash, created_at DESC);

