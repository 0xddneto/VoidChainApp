import { NextRequest, NextResponse } from 'next/server';

import { indexOnePass } from '@/lib/chain-indexer';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * Called only by Vercel Cron. `CRON_SECRET` is checked before any RPC or
 * database work, so a public request cannot spend the indexer's RPC budget.
 */
export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json({ error: 'Cron is not configured.' }, { status: 503 });
  }
  if (request.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
  }

  try {
    return NextResponse.json(await indexOnePass());
  } catch (error) {
    console.error('VoidScan indexer failed', error);
    return NextResponse.json({ error: 'Indexer pass failed.' }, { status: 500 });
  }
}
