/**
 * One chain's applications and recent calls.
 *
 * Fetched when the card opens a chain rather than sent with the list: the list
 * is 1,111 rows and nobody opens all of them.
 */
import { NextResponse } from 'next/server';
import { TOTAL_CHAINS, chainDetail } from '@/lib/chains';

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const n = Number(id);

  // Reject before touching the database. `Number('abc')` is NaN and would reach
  // the query as a null parameter, returning an empty result that looks like a
  // chain with no activity rather than a bad request.
  if (!Number.isInteger(n) || n < 1 || n > TOTAL_CHAINS) {
    return NextResponse.json({ error: 'no such chain' }, { status: 404 });
  }

  return NextResponse.json(await chainDetail(n));
}
