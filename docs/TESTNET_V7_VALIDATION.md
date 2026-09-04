# V7 testnet genesis

V7 replaces the V6 testnet economy, not an upgrade of the old ERC-20 or ERC-721.
Only Robinhood Chain testnet (46630) is in scope. Old contracts remain on-chain.
No mainnet readiness or independent L3 claim is made.

## Migration

Snapshot: block **112590945**. Five existing NFT IDs were reissued; Chain #1 and
Chain #5 retain their activation and initial fee. The other three start inactive.

| NFT | V7 custody |
| --- | --- |
| 1 | `0x440D2340C907735632A5fa0070273AFeF3D26827` |
| 2 | `0x74a7434d584D985977b2F23805c9071Ce87A14fb` |
| 3 | `0x5B1C8e44856D0585360FfEa1D59c789f5c1D609b` |
| 4 | replacement NFT/VOID pool |
| 5 | `0xA7a12A1D7000e40Ecc18a62Af456791b89cB2770` |

The project paid 0.005 testnet ETH to back those five migrated mints using the
same 40% locked liquidity / 20% Paymaster / 40% protocol split. Holders did not
pay again. Migrated NFTs count toward 1,111 and migrated holders are marked as
already minted. The next public mint is #6. New mints cost 0.001 testnet ETH.
V6 VOID balances and app state do not carry into this new economy.

| Contract | V7 address |
| --- | --- |
| Deed | `0xedf5855ee0cdbf28616db0c074be7ecd12f56b38` |
| VOID | `0x87afe8d8c85f09345227127e610a20e732990456` |
| Mint | `0xeb841dcb2a2d8c14ab85dca4f781cc1980decf3a` |
| Runtime | `0xe42eb31583513552cde8dbd578698c3f88d3b04d` |
| Paymaster | `0x7ef30a8567e1258edca38d068e9fbac49b40bad2` |
| NFT/VOID pool | `0x639f4192b355c48d32aceac71304ecff55605900` |
| Locked VOID/ETH pool | `0x81c84fee95e4de2817e47b4993a2185c80d24ee8` |
| TWAP source | `0x9d502445a9d04efbe88f9a388d8c7447f85eb27d` |
| DEX factory | `0x2b69E20832bBf295347e5E3803D1186dcaDa6D09` |

Canonical application addresses are in `web/lib/deployment.json`,
`web/lib/genesis-v6.json` (filename retained for compatibility), and
`web/lib/dex-chain1.json`. No secrets belong in those files.

## Contract acceptance

All 27 Foundry suites passed, including the migration and repeated market-cycle
tests, 1,111-chain tests, Paymaster refill checks and custody/fee invariants.
Web and isolated DEX production builds passed.

The 1,111 DAO addresses were checked from `DaoCreated` events with no missing
token ID. Fourteen paid runtime transactions were reconciled against runtime
custody: 1,876.625173512997563219 VOID gross, 1,839.092670042737611959 VOID
for the holder and 37.532503470259951260 VOID for the protocol.

Live repeated circulation of NFT #4, with successful inner execution verified:

| Action | Transaction |
| --- | --- |
| Import pool custody, no administrator payout | `0x66e8d3c3ee44cd20e2fae21fbe61d4787eff93bf1e4b5d334dc59f3d0c079f88` |
| Buy | `0x46b7642fbb0741f6dce23428952a79fca059489a2b3c6cd5a04222e7c43c78e6` |
| Sell | `0x8293353e385d3b97ca50a6a2c09ff7c621a48b64860b0ed6de096d0fbaaea008` |
| Buy again | `0xa01c5ae850462c1061e327a3a27208356be932fa2a1d1a61b2cd32f0e2a20d28` |
| Sell again | `0x50501f686137a8a1a294d764ced9d6abe61cc6a635b69f80e5aedd9c8395488b` |

Each purchase adds 502,500 VOID to the NFT pool after its protocol share. Each
sale removes 495,000 VOID (492,500 to seller and 2,500 to protocol). Chain fees
are separate and were checked against exact runtime accounting. NFT #4 ended
back in the pool and personal NFT #5 ownership was unchanged.

The same two buy/sell cycles passed through the deployed public market relay.
A DEX swap also passed through its deployed relay and produced a matching
successful Paymaster event and exact runtime revenue:
`0x10fc21c02047721a1b2599bc48e53db2e745da55eb2214ded92089c05e4ea959`.
The final public-market deployment was rechecked with another full repeated
cycle: buy `0x4fdc2653c6bff544ee5de331cc285e4cc0df36cab4472083e97503aabb15b50d`,
sell `0xc60ff09ed9e172da0e0aa0516830222efd75bcd90a4d2d62307325bc04491ad4`,
buy `0x753aafb932fc53d4b5fd2c00326768d7d8e14ce0318b435897df6c24c6c36471`
and sell `0x890dcb54799e620a6761c96d9c0e4716d0e2e3737fcab9b2e6c769c7638f6079`.

A separate deterministic test wallet minted NFT #6 with 0.001 ETH:
`0x3106950694de1b8dce2f100412bda86830a91af31b8a714c51d1a6210fbba539`.
The emitted split was exactly 0.0004 ETH locked LP, 0.0002 ETH Paymaster and
0.0004 ETH protocol. The chain was inactive and a second mint was rejected.

Real Chain #1 fee delivery was exercised after accounting reconciliation:

| Destination | Amount | Transaction |
| --- | ---: | --- |
| Holder | 1,839.092670042737611959 VOID | `0x7f7bbb7aa946a78d72fa9dc7a8e77b56d281f3a9b18271c6d21cd7fa243a2645` |
| Protocol | 37.532503470259951260 VOID | `0xd9b510a6fe650d166312e66e98c89e8c1027afceffbc11a4b9c023732f8c516c` |

The production cron was forced into a small bounded refill test. It converted
8,381.099774500933032971 VOID and increased the Paymaster reserve from
0.00105970483 ETH to 0.001173616205695733 ETH in transaction
`0xb3e4847639a3bd340184754779bc25a37842f690116c2fa23acc247654fd8cb8`.
The normal 0.0001 ETH threshold / 0.0005 ETH target policy was restored in
`0x722519715d61cb9ffb2adac9e6f72b7064ad5e7926e06c9d51e88d63d0a22cc2`.

## Operations and limits

- Keeper checks every five minutes: update TWAP, then request the bounded
  `refillPlan` and simulate before sending `refill` if the reserve is low.
- The fresh-price guard is never bypassed. A failed quote pauses sponsored
  actions; mint supply and inventory remain readable.
- ETH/USD is a fixed **test-only** feed. Production needs an independently
  sourced feed, liquidity depth assessment, economic review and audit.
- Initial liquidity is small and price impact can be substantial.
- A successful outer transaction is not sufficient: receipts must include
  matching successful Paymaster execution and no `ExecutionFailed` event.
- Public HTTP relay and browser checks are recorded below after deployment;
  source tests alone do not establish public-site functionality.

The genesis mint, Deed, VOID, pool, oracle stack, Runtime, Paymaster, Treasury,
DAO factory, app factory, escrow, timelocks and implementation were verified on
the Robinhood testnet Blockscout. Published gateways and DEX/test-token helpers
are live bytecode but are not claimed as explorer-verified here.
