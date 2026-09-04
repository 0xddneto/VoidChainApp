# Release checklist

## Testnet gate

- [ ] Install exactly the locked Node and Solidity dependencies from a clean clone.
- [ ] Run `forge build` and `forge test`, including `MegaLoadTest`.
- [ ] Snapshot the currently published supply, deploy with
  `script/deploy-testnet-v8.ts`, and require every staged proof before updating
  `web/lib/deployment.json`.
- [ ] Confirm the deployment creates the runtime, fixes the DAO factory once,
  and creates all 1,111 deterministic DAO clones before user activation.
- [ ] Verify deployed source and constructor arguments in the parent-chain
  explorer; compare the generated deployment file with the web configuration.
- [ ] Run `npm run verify:testnet-v8`, require all contracts to pass explorer
  recompilation, then run `npm run audit:testnet-v8` and reconcile supply, owners, 1,111 DAOs,
  runtime custody, owner revenue, protocol revenue and Paymaster reserve.
- [ ] Run the indexer against that deployment and exercise VoidScan's registry,
  detail, profile, DAO and owner-claim routes with a disposable wallet.
- [ ] Exercise mint, NFT buy/sell, swap, add/remove liquidity and refill. For
  every application action, prove a Paymaster event, a VOID balance delta and
  the matching indexed transaction; a wallet preview alone is not evidence.
- [ ] From a fresh wallet, record the one-time token setup prompts. Repeat the
  same action and require exactly one bounded `SponsoredCall` signature.
- [ ] Confirm `Runtime.oracle` rejects replacement and Paymaster/Treasury point
  to the 48-hour protocol timelock before changing either public manifest.
- [ ] Confirm both public origins return CSP, frame-denial, MIME-sniffing and
  referrer-policy headers and both RPC endpoints pass read-only health checks.

## Mainnet gate

- [ ] Obtain an independent security audit covering the runtime, deed, DAO
  factory, paymaster, treasury, oracle and all deployment privileges.
- [ ] Resolve every audit finding and publish the exact audited commit and
  bytecode verification record.
- [ ] Define ownership, oracle, relayer reserve, rate-limit, monitoring,
  incident-response and key-rotation procedures.
- [ ] Review the production TWAP interval and liquidity depth under manipulation
  simulations; testnet's five-minute window is not a production recommendation.
- [ ] Create the real VOID/ETH liquidity and verify every price/feed dependency,
  then pin the exact refill pool and configure the threshold/target.
- [ ] Run at least two independent low-funded permissionless keeper wallets;
  prove a bounded refill and alert on reserve, TWAP/feed failure and missed
  refill before admitting value-bearing sponsored transactions.
- [ ] Decide the real VOID supply, distribution, liquidity, permit support and
  gas-sponsorship reserve model. Testnet faucet behavior is not a mainnet model.
- [ ] Replace the single test wallet as timelock proposer with a hardware-backed
  multisig; test schedule, cancellation, delayed execution and key loss.
- [ ] If claiming independent per-NFT networks, complete the rollup requirements
  in `architecture.md`; do not ship the shared runtime under that claim.
