# VoidChainApp

**1,111 NFTs. Each one is a blockchain you own.**

Not a token that points at a chain. The deed **is** the chain. You set what it
costs to use. You collect what it earns. And when you sell it, the buyer commands
it in the same block — no migration, no handover, nothing to sign afterwards.

Live on [Robinhood Chain](https://docs.robinhood.com/chain/) testnet.

---

## Holding one

**You set the price.** A toll per call, denominated in dollars. The contract
converts it at the moment of the call, so a token that moves in price does not
move what your users pay.

**It costs nothing to run.** No node, no sequencer, no server, no monthly bill.
A chain nobody used this month costs you nothing this month.

**Selling it transfers everything, instantly.** Authority is read from
`ownerOf()` on every call — never stored, never cached. The moment the NFT moves,
the chain answers to the buyer and stops answering to you.

**What you earned stays yours.** Sell a chain with revenue still pending and it
settles to you, not to the buyer.

## Building on one

**Anyone can publish. No permission, no allowlist, no application.** Chains ship
open, because a chain where the owner picks who deploys is a website with extra
steps.

**Nobody can take your work.** Only whoever published a contract can withdraw it
— not the chain owner, not the protocol, not governance. An owner can close the
door to new deployments, but what is already there keeps running and stays yours.

**Your users never touch ETH.** They sign; a relayer sends the transaction and
fronts the gas; the paymaster charges them in VOID. From inside it is one
currency, and nobody has to acquire a second asset to press a button.

**One approval covers everything.** Instead of an unlimited `approve` to every
app they touch, a user authorizes the runtime once, by signature, with a budget
written into the call that dies with it.

---

## How it works

A chain is a row in `VoidChainAppRuntime`, on the parent chain. Calls to it carry
the deed's `tokenId`, and it has an economy, rules and revenue of its own.

Isolation is enforced in code, not promised: there is no path in the runtime that
takes a call on one chain to a contract of another. A contract is reachable only
through its own chain, which is what makes the toll mandatory rather than
optional.

A chain that outgrows this arrangement can be promoted to a rollup of its own,
keeping the same NFT as its title.

| | |
|---|---|
| `VoidChainDeed` | the 1,111 NFTs. Each `tokenId` derives its chain ID by formula |
| `VoidChainAppRuntime` | the chain: charges the toll, isolates execution, holds revenue |
| `VoidChainTreasury` | pays owners, by pull, so one recipient cannot block another |
| `VoidPaymaster` | lets someone holding only VOID transact |
| `VoidPriceOracle` | composes the price the dollar toll is converted at |

## Layout

```
contracts/   the protocol
test/        the test suite
script/      deploy a testnet, and verify it end to end
web/         the explorer and the mint page
indexer/     follows the runtime's events, keeps Postgres current
db/          schema and migrations
```

## Running it

The contracts:

```bash
npm install && forge install foundry-rs/forge-std
forge test
```

The site, with its database and indexer:

```bash
docker compose -f indexer/docker-compose.yml up -d
cd indexer && npm install && npm run dev
cd web && npm install && npm run dev
```

Open `/mint`, connect a wallet, take testnet VOID and buy a deed. The chain
starts answering to you on the next block. You need a small amount of testnet ETH
for the transactions you send.

The site reads its addresses from `web/lib/deployment.json`, which
`script/deploy-testnet.ts` writes. Nothing is hardcoded: redeploy and the whole
stack follows.

## Tests

229 passing, including adversarial suites that stay in the repository after the
issues they found were fixed — a test that reproduces an attack is what stops the
fix being undone by accident later. `Scale.t.sol` exercises all 1,111 chains at
once, every call sponsored, with no user holding ETH.

## Status

Testnet, chain ID 46630. The contracts have not been audited. Testnet VOID has no
value and its faucet is open, and the oracle there returns a fixed price because
that network has no market to read yet.

## Licence

MIT.
