import type { Address } from 'viem';

export const DEX = {
  chainId: 46_630,
  rpc: 'https://robinhood-testnet.drpc.org',
  voidToken: '0x2a64fa56c1de6f7c737b4a964b5b693ed3841ff4' as Address,
  runtime: '0x3ba040ac9a971737dda330fc39999c45af84ccb8' as Address,
  paymaster: '0xd72e36792f3f26201ee677e165ee19da3aa58201' as Address,
  pools: [
    { name: 'VOID / tUSD', address: '0xb63b890113f49c00f830ec9328739f3273691723' as Address, token0: '0x2a64fa56c1de6f7c737b4a964b5b693ed3841ff4' as Address, token1: '0x70db8af53329dde92c7809000622b1fd838a7460' as Address, symbol0: 'VOID', symbol1: 'tUSD', name1: 'Void Test Dollar' },
    { name: 'VOID / tLINK', address: '0xfd64be3f4f96f473fc049e66a42d8a9868add8b3' as Address, token0: '0x2a64fa56c1de6f7c737b4a964b5b693ed3841ff4' as Address, token1: '0x6b364149805d9f496301d675ff41889296286836' as Address, symbol0: 'VOID', symbol1: 'tLINK', name1: 'Void Test Link' },
  ],
} as const;
export const RH_NETWORK = { chainId: '0xb626', chainName: 'Robinhood Chain Testnet', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: [DEX.rpc] };
