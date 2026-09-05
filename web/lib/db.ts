import pg from 'pg';

/**
 * Pool shared across requests.
 *
 * Kept in global scope because in development Next reloads modules on every
 * change, and without this each reload would open a new pool until Postgres ran
 * out of connections.
 */
const globalForDb = globalThis as unknown as { voidscanPool?: pg.Pool };
const DEFAULT_DATABASE_URL = 'postgres://voidscan:voidscan@localhost:5433/voidscan';

/** Keep pg v8's verified TLS behavior explicit before pg v9 changes aliases. */
export function verifiedDatabaseUrl(value: string): string {
  const url = new URL(value);
  const sslMode = url.searchParams.get('sslmode');
  if (sslMode === 'prefer' || sslMode === 'require' || sslMode === 'verify-ca') {
    url.searchParams.set('sslmode', 'verify-full');
  }
  return url.toString();
}

const databaseUrl = verifiedDatabaseUrl(process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL);

export const pool =
  globalForDb.voidscanPool ??
  new pg.Pool({
    connectionString: databaseUrl,
    max: 5,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    statement_timeout: 15_000,
  });

if (process.env.NODE_ENV !== 'production') globalForDb.voidscanPool = pool;

/** Session locks must bypass transaction-mode poolers. */
export function sessionDatabaseUrl(): string {
  const url = new URL(verifiedDatabaseUrl(process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL));
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
