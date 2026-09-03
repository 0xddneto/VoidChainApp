import { DEPLOY } from './testnet';

/** Fixed safety ceilings for the collection's sponsored purchase route. */
export const MARKET_CALL_GAS_LIMIT = 1_500_000n;
export const MARKET_MAX_GAS_VOID = 10_000n * 10n ** 18n;
export const MARKET_SIGNATURE_LIFETIME_SECONDS = 10n * 60n;

type MarketDeployment = {
  VoidMarketApp?: string;
  marketChainId?: number;
};

export function marketDeployment(): { app: `0x${string}`; chainId: bigint } | null {
  const testnet = DEPLOY.testnet as typeof DEPLOY.testnet & MarketDeployment;
  if (!testnet.VoidMarketApp || !testnet.marketChainId) return null;
  return { app: testnet.VoidMarketApp as `0x${string}`, chainId: BigInt(testnet.marketChainId) };
}
