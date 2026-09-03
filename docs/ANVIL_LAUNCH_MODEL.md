# Anvil launch model — findings before the Void relaunch

Status: design gate. This document freezes the economic facts learned from
Anvil before another VOID collection or token is deployed. The previously
staged `testnet-v5-pending.json` is an unpromoted testnet candidate, not a
launch and not a source of production parameters.

## What Anvil actually creates

Anvil attaches a market to an ERC-721 collection. Its factory deploys a
collection ERC-20, an escrow reserve, an NFT AMM vault, a loan vault, a
staking vault and optional governance. The full ERC-20 supply is minted into
the escrow, not to an operator wallet. Tokens are released only by defined,
capped routes. Source: https://anvil.clutch.market/docs

`tokensPerNFT` is the AMM's base exchange ratio: an NFT deposited into its
market can receive that many market tokens before the configured fee. It is
not an airdrop to every NFT holder, and it is not by itself the token price.
The actual VOID/ETH price starts only when a disclosed VOID/ETH pool is
seeded.

Anvil's creator flow is:

1. Set collection, market-token name/symbol, `tokensPerNFT`, total supply and
   immutable fee/bucket parameters.
2. The factory mints the supply into escrow and opens the NFT/token market.
3. The team deposits a disclosed NFT slice into that market, receives market
   tokens, and pairs those tokens with ETH on an external DEX.
4. The LP position is locked. The pool price becomes the market price source.

The protocol fee is a fixed 0.5% of AMM operations. It is fee revenue, not a
hidden allocation from token supply. The NFT swap/staker fee is separately
chosen at deployment. On Robinhood Chain, Anvil documents additional native
ETH fees for its NFT/loan operations; that is incompatible with the VOID
requirement for post-genesis app activity and cannot be copied directly.

## Frontend and fee observations

The live Robinhood Chain market UI confirms the contract model in the docs:
it shows the NFT base rate, separate sell/buy quotes, explicit market fee,
fixed protocol cut, inventory, vault contracts and the token supply. Its Relay
conversion desk separately displays a 1% relay fee. This is not the same fee
as the NFT AMM fee.

VOID adopts the separation but not Anvil's absolute fee values:

| VOID operation | Fee | Recipient |
| --- | ---: | --- |
| Random NFT AMM buy or sell | 1.00% | VOID NFT liquidity/reward bucket |
| Specific NFT AMM buy | 2.00% | VOID NFT liquidity/reward bucket |
| NFT AMM protocol cut | 0.50% | protocol treasury |
| VOID/ETH pool swap | 0.30% | locked LP |
| Paymaster refill | no extra user-facing conversion fee | pays the actual pool price, bounded by TWAP/slippage |

The user's signed chain fee remains separate from these market fees and is
split by the Void runtime (98% chain owner / 2% protocol). This prevents a
market app from hiding a second "network fee" inside a trade.

## Consequence for VOID

VOID is a global utility token for all 1,111 VoidChains, not merely a
collection token. We can borrow Anvil's escrow and solvency model, but should
not pretend its deployed factory is a drop-in dependency: it is configured for
mainnet Robinhood Chain and its native-ETH operations would break the signed
VOID-only path.

The ETH NFT mint is the one explicit exception. It creates initial ETH for
liquidity and the Paymaster. After the launch is finalized, application and
marketplace actions must go through the Runtime/Paymaster path and charge
VOID.

## Correct supply arithmetic to evaluate

At `500,000 VOID` per Deed, the full NFT-AMM redemption ceiling is:

```
1,111 Deeds × 500,000 VOID = 555,500,000 VOID
```

If total supply is exactly `555,500,000 VOID`, this is closest to an Anvil
single-collection market: every unit is explained by the NFT market reserve.

If total supply is `1,000,000,000 VOID`, the remaining `444,500,000 VOID`
must *not* be called "left over for the protocol". It needs an immutable,
published bucket and release rule. A correct global-VOID model would make the
three classes explicit:

| Bucket | Purpose | Rule |
| --- | --- | --- |
| NFT AMM | up to 555,500,000 VOID | only paid against a Deed entering the AMM |
| Loan reserve | at most 5% of total supply if loans ship | only paid against collateral under fixed terms |
| Global reserve | the remaining fixed supply | no administrator withdrawal; only timelocked, DAO-approved programs such as a published emissions schedule or a Paymaster liquidity route |

There is no valid fourth rule saying "the owner can withdraw what remains".
That is the exact drain path Anvil's escrow model avoids.

## Required finalization sequence

1. Deploy Deed with ERC-4494 permit, fixed supply 1,111, and the ETH mint
   contract. No collection token is user-spendable yet.
2. Deploy fixed-supply VOID plus a token escrow that enforces the final bucket
   caps and conservation invariant.
3. Mint Deeds for ETH. Each wallet may mint one. The mint price, split and
   finalization threshold are immutable and visible before a buyer signs.
4. At finalization, seed a disclosed VOID/ETH pool, lock the LP, and point the
   TWAP oracle at that pool. Do not use a manually typed price once the pool
   exists.
5. Fund the Paymaster from its immutable ETH share, then open sponsored
   Runtime operations. The relayer pays parent-chain ETH; the user signs and
   pays VOID.
6. Publish the NFT market inside the first activated VoidChain. Listings use
   Deed `permit` plus the signed NFT budget; buyers use a signed VOID budget.
   Neither needs an ETH approval.

## Parameters deliberately not yet locked

- Whether Void uses the strict Anvil-equivalent `555,500,000` supply or the
  global-token `1,000,000,000` supply with hard escrow buckets.
- The ETH mint price and finalization threshold.
- The exact initial NFT inventory used to obtain VOID for the LP, its LP lock,
  and the launch fee/staking configuration.

These are economic commitments, not front-end defaults. The replacement
contract suite must be written and adversarially tested only after they are
specified as immutable inputs.
