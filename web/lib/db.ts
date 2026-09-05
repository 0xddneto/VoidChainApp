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
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    statement_timeout: 15_000,
  });

if (process.env.NODE_ENV !== 'production') globalForDb.voidscanPool = pool;

/** Session locks must bypass transaction-mode poolers. */
export function sessionDatabaseUrl(): string {
  const url = new URL(process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL ?? 'postgres://voidscan:voidscan@localhost:5433/voidscan');
  if (url.hostname.endsWith('.neon.tech')) url.hostname = url.hostname.replace('-pooler.', '.');
  return url.toString();
}

export const sessionPool = new pg.Pool({
  connectionString: sessionDatabaseUrl(), max: 2,
  connectionTimeoutMillis: 5_000, idleTimeoutMillis: 10_000, statement_timeout: 15_000,
});

/** BYTEA comes back as a Buffer; the interface wants hexadecimal. */
export const toHex = (bytes: Buffer | null): string | null =>
  bytes ? `0x${bytes.toString('hex')}` : null;
