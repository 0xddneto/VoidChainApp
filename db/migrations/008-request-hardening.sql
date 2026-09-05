BEGIN;
CREATE TABLE IF NOT EXISTS relay_attempts (
  user_address BYTEA NOT NULL,
  client_hash BYTEA NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS relay_attempts_user_recent ON relay_attempts(user_address, created_at DESC);
CREATE INDEX IF NOT EXISTS relay_attempts_client_recent ON relay_attempts(client_hash, created_at DESC);
CREATE TABLE IF NOT EXISTS profile_nonces (
  user_address BYTEA NOT NULL,
  nonce TEXT NOT NULL,
  used_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(user_address, nonce)
);
COMMIT;
