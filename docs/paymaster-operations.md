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

The official frontend checks allowances and requests setup only when needed.
For EIP-2612 assets, setup is a gasless permit to the immutable Paymaster or
Runtime. Once sufficient allowance exists, each later action needs only its
single `SponsoredCall` signature. The exact per-action budget is never inferred
from a broad allowance: it is signed independently and exists inside the
Runtime only for that call. `sponsorWithAssetPermits` rejects arbitrary
spenders, duplicate permits and insufficient limits. Do not add a direct-wallet
fallback to an official app: it reintroduces ETH gas and can bypass the product
fee path.

## Automatic refill

The refill is deliberately outside a user transaction. The user path only
checks a signed cap, charges VOID and reimburses the relayer. A swap there
would put DEX availability, price movement and sandwich risk on every user.

The governor configures four things only after the real VOID/ETH market exists:

1. A `VoidTwapOracleV6` for the permanently locked VOID/ETH pool, wrapped by a
   freshness guard. The current testnet observation interval is five minutes;
   production parameters require a fresh market and separate review.
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

The V7 Robinhood **testnet** deployment uses its permanently locked genesis
VOID/ETH pool, a TWAP oracle and a freshness guard. The Paymaster exit route is
pinned once to that pool; governance cannot redirect it later. A permissionless
keeper calls `refill` only below the configured reserve threshold and must use
the contract's bounded plan. This proves the route mechanics with valueless
test assets; it does not prove production liquidity depth, oracle economics or
mainnet solvency.
