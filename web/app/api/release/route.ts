import { CONTRACTS, RELEASE, MANIFEST_HASH } from '@/lib/public-release';
export const dynamic = 'force-dynamic';
export function GET() {
  return Response.json({ version: RELEASE, chainId: 46630, manifestHash: MANIFEST_HASH,
    contracts: CONTRACTS, commit: process.env.VERCEL_GIT_COMMIT_SHA ?? null },
    { headers: { 'Cache-Control': 'no-store, max-age=0' } });
}
