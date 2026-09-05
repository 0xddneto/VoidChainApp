import { readSecurityState } from '@/lib/security-state';

export const dynamic = 'force-dynamic';

export async function GET() {
  const state = await readSecurityState();
  return Response.json(state, {
    status: state.error ? 503 : state.checked ? 200 : 409,
    headers: { 'Cache-Control': 'no-store, max-age=0' },
  });
}
