import VoidDex from './DexClient';
import { DEX } from './dex-config';
import { poolState } from './pool-state';

export const dynamic = 'force-dynamic';
export default async function Page() {
  try {
    const states = await Promise.all(DEX.pools.map((_, index) => poolState(index)));
    return <VoidDex initialStates={states} />;
  } catch {
    return <main className="shell"><h1>VoidDEX</h1><p>Pool data is temporarily unavailable. Please reload shortly.</p><a href="https://voidscan-nu.vercel.app">Open VoidScan</a></main>;
  }
}
