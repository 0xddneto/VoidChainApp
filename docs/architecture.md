# Architecture boundary

## What is deployed now

VoidChainApp is a multi-tenant EVM application runtime on **Robinhood Chain
testnet**. The parent chain has one real RPC endpoint and one EIP-155 chain ID:
`46630`.

```text
wallet or relayer
        |
        v
Robinhood Chain testnet (46630)
        |
        +--> VoidPaymaster (optional signed sponsorship)
        |
        v
VoidChainAppRuntime + tokenId
        |                    |
        |                    +--> transaction-fee and revenue accounting for that deed
        v
application registered for that same tokenId
```

The Runtime rejects an app address not registered for the given `tokenId`. It
also exposes the currently executing token and caller to the application, so
each app can preserve the tenant boundary. The deed holder's authority is read
from the ERC-721 at call time. A transfer therefore changes configuration
authority without granting the holder custody of third-party app assets.

`runtime ID` in VoidScan is a deterministic per-deed identifier retained for
the collection's internal namespace and possible future migration. It is not a
live EIP-155 network ID, and a wallet must not be asked to add it as an RPC
network.

## Safety boundaries

The present design provides application-level isolation, not protocol-level
isolation. A fault in the parent chain, runtime code, shared paymaster, shared
oracle or common indexer can affect more than one deed. An owner cannot rewrite
parent-chain history, seize a publisher's app balance through the runtime, or
turn a published app into a private contract merely by transferring the deed.

The per-deed DAO accepts general proposals: the current deed holder supplies a
description and up to eight zero-ETH contract calls. Each wallet votes with the
VOID it held at the previous-block snapshot; the vote is open for five days and
VOID never leaves the wallet. The snapshot prevents the same VOID from moving
between wallets and voting twice. A passed proposal executes only as the DAO
address of that one deed. Target contracts enforce their own authority, so the
DAO can configure its own runtime but cannot alter another chain, seize a
publisher's app balance, withdraw from the protocol treasury or control the
shared paymaster.

## What a real independent chain would require

Promotion from this runtime to a rollup is a new protocol project. At minimum it
needs a supported rollup stack on the chosen parent, sequencer and batch
submission operations, data availability and finality rules, a node/RPC service,
block explorer/indexer, bridge and canonical asset rules, EIP-155 chain ID,
native-gas policy, incident response, monitoring and a new audit scope.

The NFT may remain the economic and configuration deed through that migration,
but no current contract makes that migration automatic. Calling the current
runtime a separate L2/L3 would hide those requirements and is incorrect.
