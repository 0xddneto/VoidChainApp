# Security policy

VoidChainApp is pre-audit testnet software. Do not deposit assets you cannot
lose. The current execution spaces share Robinhood Chain Testnet, a runtime and
an RPC; they are not independent blockchains or security domains.

## Reporting

Report a suspected vulnerability privately to the repository owner through
GitHub Security Advisories. Do not include private keys, seed phrases or live
relayer credentials in an issue, commit, screenshot or chat.

Include the affected contract or route, the current testnet address, exact
reproduction steps and the impact. Avoid exploiting accounts or assets that you
do not control. Public disclosure should wait until a fix and migration are
available.

## Current trust boundary

- Deed-level fees and publishing policy become DAO-controlled after activation.
- The Runtime oracle is configured once and cannot be replaced.
- Paymaster and Treasury administration use a public 48-hour timelock.
- The testnet timelock proposer is one project wallet. Mainnet requires a
  hardware-backed multisig and an independent audit.
- Relayers hold ETH and submit bounded EIP-712 requests. A relayer cannot alter
  the signed chain, app, calldata, budgets, fee cap, nonce or deadline.
- The official interfaces use two read RPC endpoints. The indexer and hosted
  relayers remain availability dependencies, not consensus authorities.

Verified active addresses are versioned in `web/lib/deployment.json`.
