# Paymaster reserve operations

`VoidPaymaster` lets a user sign a VOID-funded runtime transaction while a
relayer pays the parent-chain ETH. It keeps the VOID charged for gas in
`reimbursableVoid`; that balance is not revenue and must be converted back to
ETH to keep the reserve solvent.

## Required execution path

The product must submit every official chain-app action through the Paymaster.
The signed request binds the chain ID, app address, calldata, chain-fee cap,
gas cap, expiry and exact per-token budgets. The Runtime then splits the
actual chain fee on every successful call: 98% is accrued to that deed's
current holder and 2% to the protocol treasury.

Apps which spend assets besides VOID must use EIP-2612 permits (or a reviewed
equivalent adapter). `sponsorWithAssetPermits` only accepts a permit to the
Paymaster for VOID gas/toll, or a permit to the Runtime for an asset explicitly
listed in that signed call. It rejects arbitrary spenders, duplicate permits
and insufficient limits. Do not add a direct-wallet fallback to an official
app: it reintroduces ETH gas and can bypass the product's UX guarantee.

## Automatic refill

The refill is deliberately outside a user transaction. The user path only
checks a signed cap, charges VOID and reimburses the relayer. A swap there
would put DEX availability, price movement and sandwich risk on every user.

The governor configures four things only after the real VOID/ETH market exists:

1. A `VoidPriceOracle` for the same VOID/ETH pool. It uses a 30-minute TWAP and
   a fresh ETH/USD Chainlink feed.
2. The exact approved router, WETH address and pool fee using `setSwapRoute`.
3. A refill threshold, target and slippage ceiling using `setRefillPolicy`.
   The contract accepts at most 5% below its own TWAP quote.
4. A dedicated, low-funded keeper wallet. It has no governance permission and
   can only pay gas to call the already permissionless `refill` function.

When the reserve is below the threshold, the contract's `refillPlan()` returns
the largest permitted VOID input and the minimum ETH output. The keeper sends
those exact values. It cannot sell more replacement VOID, choose a worse
minimum output, move assets to itself, or execute while the reserve is healthy.
The router allowance is reset to zero after every swap.

Run the keeper from `script/`:

```bash
npm run paymaster:keeper -- --once
npm run paymaster:keeper
```

Copy `script/.env.example` to the ignored `script/.env`. A healthy `--once`
check is read-only. If a refill is required, writes are refused unless a
separate `KEEPER_PRIVATE_KEY` is set.

## Current testnet boundary

The deployed Robinhood **testnet** stack intentionally uses `VoidTestOracle`;
there is no deep VOID/ETH market or production Chainlink feed there. Its route
must remain unset, so a keeper reports `healthy/idle` and cannot sell test VOID
into a fictitious pool. The production route is enabled only after the real
VOID/ETH liquidity, matching TWAP pool and verified Chainlink feed exist.

This is an operational safety boundary, not a feature gap: sending the current
test token to an arbitrary router would not prove a real self-refill system.
