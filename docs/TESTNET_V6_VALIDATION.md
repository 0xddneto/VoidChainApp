# V6 testnet validation — 2026-09-03

This is a testnet repair record, not a mainnet audit or a claim that every
requested flow is complete. Canonical addresses are in
`web/lib/deployment.json` and `web/lib/dex-chain1.json`.

## Implemented and exercised

- Mint supply no longer depends on a successful TWAP read. Loading is not
  represented as zero mints; existing wallet authorization is reused.
- Chain facts and the atlas are compact. Applications are public and link to
  VoidDEX or the NFT/VOID market. Revenue has an explicit VOID denomination;
  directory ordering supports state, transactions, apps and revenue.
- VoidDEX now uses the current runtime/token/paymaster and two real, funded
  gateway pools. Frontend, public state API and relay share one deployment
  manifest. The site is separate from VoidScan.
- A zero-ETH test wallet completed a sponsored swap in Chain 1:
  `0xa72f09646dc68c5b7e2042f59b7354f22da5bacc0c85ffd78dfb129f0f65b4dc`.
  The proof checked runtime transaction/revenue increments and the wallet's
  unchanged zero ETH balance. This is not proof of sustained keeper uptime.
- Both relays simulate the actual Paymaster return value before submitting.
  Both clients require a matching successful Sponsored event and reject
  ExecutionFailed, even when the outer receipt reports success.
- The published DEX HTTP relay was exercised with the project test wallet:
  `0x7d7df1250b17bfe08bd835b436d2d5053315dd3627c2b196e16fb4c338b1a6e9`.
  Its successful app event and exact runtime revenue increment were checked.
- TWAP maintenance has a separate authenticated cron endpoint. Deployment,
  configured credentials, scheduling and ETH balance are operational
  requirements; adding the route alone does not prove keeper uptime.
- Vercel showed the TWAP cron enabled every five minutes and its scheduled
  2026-09-04 00:35:13 UTC invocation returned HTTP 200. Both project deployments
  completed successfully. This observation does not guarantee future uptime.
- The local explorer's old-runtime derived tables were rebuilt with
  `node --import tsx sync-web-indexer.ts` from `script/`. No on-chain NFT,
  token balance or contract was reset by this synchronization.

## Verification

- Both Next.js production builds and TypeScript checks passed.
- All 26 Foundry suites passed, including existing invariants and load tests.
- Four added NFT AMM tests cover repeat circulation, slippage, unauthorized
  callers and ownership. The repeat test performs 20 buy/sell cycles.
- Nine receipt-validation tests passed. The helper is dependency-free so the
  DEX can build without installing the VoidScan application's dependencies.
- Local browser inspection confirmed public DEX links, current-runtime
  activity, explicit VOID revenue and real pool reserves.

## Blocking issue in the already-published NFT AMM

The deployed V6 module unconditionally requests an escrow backing release on
every deposit. Escrow correctly releases backing only once per Deed, so a
Deed bought from this pool cannot be deposited again. First deposits and
buying existing inventory are different from a complete repeatable market.

The source fix in `contracts/genesis/VoidGenesisNftAmmV6.sol` releases backing
only on the first deposit and uses the returned purchase principal thereafter.
It passes local tests, but **is not installed in the published gateway**.
Gateway implementation is immutable; escrow's AMM address is set once.
Neither a frontend update nor a new gateway address repairs existing custody.

The interface discloses this limitation and rejects repeat deposits before
signing/submitting. A new economic deployment or a separately funded,
explicit migration mechanism is required. Do not claim the public testnet
launch is ready until migration, existing ownership/custody, balances,
repeat sales and the production keeper have all been verified.

## Anvil distinction

The launch is Anvil-inspired, not an Anvil factory deployment. Current VOID
market fees are 1% pool buy, 2% selected buy and 1.5% sell, with the protocol's
0.5% carved out of those fees, plus the runtime and Paymaster costs. These are
not identical to an Anvil fee schedule that adds a protocol fee on top.
# Superseded deployment

V6 is archived. See [V7 validation](TESTNET_V7_VALIDATION.md) for the replacement
genesis and new contract addresses. V6 token balances are not V7 balances.
