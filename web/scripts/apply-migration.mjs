import { readFileSync } from 'node:fs';
import pg from 'pg';

if (process.env.DOTENV_CONFIG_PATH) {
  for (const line of readFileSync(process.env.DOTENV_CONFIG_PATH, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^([^#=]+)=(.*)$/);
    if (!match) continue;
    let value = match[2];
    if (value.startsWith('"') && value.endsWith('"')) value = JSON.parse(value);
    process.env[match[1]] ??= value;
  }
}

const migration = process.argv[2];
if (!migration) throw new Error('Usage: node scripts/apply-migration.mjs <sql-file>');
const connectionString = process.env.DATABASE_URL ?? process.env.POSTGRES_URL;
if (!connectionString || connectionString === '[SENSITIVE]') throw new Error('Database URL is unavailable');
const client = new pg.Client({ connectionString, ssl: { rejectUnauthorized: false } });
await client.connect();
try {
  await client.query(readFileSync(migration, 'utf8'));
  const result = await client.query(`
    SELECT
      EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='chain_revenue' AND column_name='log_index') AS revenue_log_index,
      EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='indexer_state' AND column_name='last_indexed_hash') AS cursor_hash,
      to_regclass('public.profile_requests') IS NOT NULL AS profile_rate_limit,
      (SELECT count(*) FROM chain_migration_baseline) AS baseline_chains,
      (SELECT COALESCE(sum(tx_count), 0) FROM chain_migration_baseline) AS baseline_transactions,
      (SELECT COALESCE(sum(holder_revenue), 0) FROM chain_migration_baseline) AS baseline_revenue
  `);
  console.log(JSON.stringify(result.rows[0]));
} finally {
  await client.end();
}
