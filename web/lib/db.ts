import pg from 'pg';

/**
 * Pool shared across requests.
 *
 * Kept in global scope because in development Next reloads modules on every
 * change, and without this each reload would open a new pool until Postgres ran
 * out of connections.
 */
const globalForDb = globalThis as unknown as { voidscanPool?: pg.Pool };

export const pool =
  globalForDb.voidscanPool ??
  new pg.Pool({
    connectionString:
      process.env.DATABASE_URL ?? 'postgres://voidscan:voidscan@localhost:5433/voidscan',
    max: 5,
  });

if (process.env.NODE_ENV !== 'production') globalForDb.voidscanPool = pool;

/** BYTEA comes back as a Buffer; the interface wants hexadecimal. */
export const toHex = (bytes: Buffer | null): string | null =>
  bytes ? `0x${bytes.toString('hex')}` : null;
