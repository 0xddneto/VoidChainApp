# VOID Uniswap V2 fork notice

`contracts/apps/VoidUniswapV2Pair.sol` is a GPL-3.0-only adaptation of the
Uniswap v2-core pair design. It retains the V2 0.30% constant-product formula,
LP ERC-20 accounting, minimum liquidity, cumulative-price accounting and the
Mint/Burn/Swap/Sync event model. Its required changes are limited to routing
asset pulls through `VoidChainAppRuntime`, which is what enforces the VOID Chain
fee and lets signed one-call budgets work.

Upstream source: https://github.com/Uniswap/v2-core

The upstream repository is GPL-3.0. Any distribution of this derived contract
must retain GPL-3.0 terms and the relevant Uniswap attribution.
