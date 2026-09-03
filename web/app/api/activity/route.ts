import { NextResponse } from 'next/server';

import { recentEvents } from '@/lib/chains';

export const dynamic = 'force-dynamic';

/** Lightweight live source for the activity strip. */
export async function GET() {
  return NextResponse.json(await recentEvents(30));
}
