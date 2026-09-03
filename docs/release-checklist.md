# Release checklist

## Testnet gate

- [ ] Install exactly the locked Node and Solidity dependencies from a clean clone.
- [ ] Run `forge build` and `forge test`, including `MegaLoadTest`.
- [ ] Deploy with `script/deploy-testnet.ts` using a dedicated test-only key.
- [ ] Confirm the deployment creates the runtime, fixes the DAO factory once,
  and creates all 1,111 deterministic DAO clones before user activation.
- [ ] Verify deployed source and constructor arguments in the parent-chain
  explorer; compare the generated deployment file with the web configuration.
- [ ] Run the indexer against that deployment and exercise VoidScan's registry,
  detail, profile and claim routes with a disposable wallet.

## Mainnet gate

- [ ] Obtain an independent security audit covering the runtime, deed, DAO
  factory, paymaster, treasury, oracle and all deployment privileges.
- [ ] Resolve every audit finding and publish the exact audited commit and
  bytecode verification record.
- [ ] Define ownership, oracle, relayer reserve, rate-limit, monitoring,
  incident-response and key-rotation procedures.
- [ ] Create the real VOID/ETH liquidity, verify the matching 30-minute-TWAP
  pool and fresh ETH/USD Chainlink feed, then have governance set the exact
  router/WETH/pool-fee route and refill threshold/target.
- [ ] Run at least two independent low-funded permissionless keeper wallets;
  prove a bounded refill and alert on reserve, TWAP/feed failure and missed
  refill before admitting value-bearing sponsored transactions.
- [ ] Decide the real VOID supply, distribution, liquidity, permit support and
  gas-sponsorship reserve model. Testnet faucet behavior is not a mainnet model.
- [ ] If claiming independent per-NFT networks, complete the rollup requirements
  in `architecture.md`; do not ship the shared runtime under that claim.
