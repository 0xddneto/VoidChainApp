import { NextRequest, NextResponse } from 'next/server';
import { isAddress, type Address } from 'viem';
import { poolState } from '../pool-state';
export const dynamic = 'force-dynamic';
export async function GET(request: NextRequest) {
  const index = Number(request.nextUrl.searchParams.get('pair') ?? '0');
  const input = request.nextUrl.searchParams.get('account');
  try {
    return NextResponse.json(await poolState(index, input && isAddress(input) ? input as Address : undefined), { headers: { 'Cache-Control': 'no-store' } });
  } catch {
    return NextResponse.json({ error: 'Pool data is temporarily unavailable.' }, { status: 503 });
  }
}
