# V8 testnet validation

V8 was staged from a block-pinned V7 snapshot before either public manifest was
changed. It preserves the six existing Deeds, creates all 1,111 DAOs, freezes
the Runtime oracle, and moves Paymaster and Treasury administration to a
48-hour timelock.

| Component | Address |
| --- | --- |
| Protocol timelock | `0x039af9921906165619ae2135f46471c19fa987c9` |
| Deed | `0xd19f35353c4bb25d179724d762c7fe3b06408e0e` |
| VOID | `0x7defce421374496709d470b17d37118028888dc5` |
| Mint | `0x1ca182f625aaa06c35e2f5019821ebaa4b83c539` |
| Runtime | `0x2912f4a8943e4a1434087ba78f18e102cce303d2` |
| Paymaster | `0xf66e7c04afc17f65526c325a089b87c15130bc06` |
| NFT/VOID market | `0x1a13cc77070b43b98fdd1e0e6f5d349c2c9fda6d` |

Acceptance on Robinhood Chain Testnet, chain ID 46630:

- 19 core contracts recompiled and verified by Blockscout.
- 1,111 DAO creation events accounted for without a missing Deed ID.
- Six existing owners and one-mint-per-wallet state preserved.
- Two market-custody Deeds restored as live NFT/VOID inventory.
- Five Chain #1 applications registered, including the NFT market and DEX.
- Six successful sponsored executions reconciled with Runtime statistics.
- One billion VOID fixed supply and nonzero VOID/ETH reserves.
- All genesis LP units assigned to the permanent lock, with token and ETH
  balances equal to recorded reserves.

This is live testnet evidence, not an external audit or a mainnet approval.
