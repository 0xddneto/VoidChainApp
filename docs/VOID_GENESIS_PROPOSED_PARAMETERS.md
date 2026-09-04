# Proposed VOID genesis parameters

Status: design record. A V6 testnet launch now exists; this document is not
proof that all requirements were implemented. See [V6 validation](TESTNET_V6_VALIDATION.md)
for deployed behavior, tests and the blocking NFT AMM migration issue.

This is an Anvil-inspired global-token design, not a claim that the Anvil
factory itself is used. VOID must serve all VoidChains, so it needs explicit
global liquidity and builder reserves in addition to the collection AMM.

## Fixed values

| Parameter | Value | Why |
| --- | ---: | --- |
| Deed supply | 1,111 | fixed collection cap |
| NFT AMM base rate | 500,000 VOID / Deed | defines an NFT market floor, not an airdrop |
| Total VOID supply | 1,000,000,000 | round fixed global supply, no post-genesis mint |
| NFT AMM reserve | 555,500,000 VOID | exactly 1,111 × 500,000; enough for every Deed to enter the AMM |
| Locked VOID/ETH LP | 222,200,000 VOID | 40% of the AMM ceiling; paired only with the ETH liquidity share |
| Builder emissions | 150,000,000 VOID | timelocked, DAO-approved programs only; no owner withdrawal |
| Protocol reserve | 72,300,000 VOID | timelocked protocol operations, with an immutable release schedule |

The four buckets sum exactly to 1,000,000,000 VOID.

## ETH mint and the first VOID price

The normal ETH mint stays separate from the post-genesis VOID path.

| Mint ETH | Split | Destination |
| --- | ---: | --- |
| 40% | initial LP | paired with the 222,200,000 locked VOID only |
| 20% | Paymaster reserve | pays parent-chain ETH for signed VOID operations |
| 40% | protocol treasury | timelocked operating reserve |

If every Deed mints at price `P ETH`, the LP has `1,111 × P × 40% ETH` and
`222,200,000 VOID`. Its opening rate is exactly `500,000 VOID / P ETH`, so one
Deed's 500,000-VOID AMM base rate starts at the same implied price as its ETH
mint. This is the important consistency condition missing from the rejected
candidate.

## Hard rules for the replacement contracts

1. The escrow can release the NFT-AMM bucket only after it receives a specific
   Deed, and cannot release more than 500,000 VOID per Deed.
2. The LP bucket can seed only one precommitted pool and its LP position must
   be locked. It can never be sent to a wallet.
3. Builder and protocol buckets need a timelock plus on-chain governance;
   neither a deployer nor an NFT holder may withdraw them directly.
4. The Paymaster gets ETH from the mint split. It does not receive a secret
   extra VOID allocation; it rebuilds ETH by selling user-paid VOID through
   the locked pool under the TWAP/slippage policy.
5. No post-genesis app, listing or purchase asks the user to send ETH. The
   Deed uses ERC-4494 permit; ERC-20 spends use EIP-2612 permit; the relayer
   sends the parent-chain transaction.
6. The marketplace is deployed only after a Deed holder activates their
   chain; this keeps the market inside a real VoidChain and makes its chain
   fee/revenue accounting enforceable.
