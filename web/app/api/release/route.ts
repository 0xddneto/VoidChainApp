import { CANONICAL_ORIGIN, CONTRACTS, EXPLORER, RELEASE, MANIFEST_HASH, SOURCE_REPOSITORY } from '@/lib/public-release';
export const dynamic = 'force-dynamic';
export function GET() {
  const commit = process.env.VERCEL_GIT_COMMIT_SHA ?? null;
  return Response.json({ version: RELEASE, chainId: 46630, manifestHash: MANIFEST_HASH,
    canonicalOrigin: CANONICAL_ORIGIN, explorer: EXPLORER, contracts: CONTRACTS, commit,
    source: { repository: SOURCE_REPOSITORY, ref: commit ?? 'main',
      url: `${SOURCE_REPOSITORY}/tree/${commit ?? 'main'}` } },
    { headers: { 'Cache-Control': 'no-store, max-age=0' } });
}
