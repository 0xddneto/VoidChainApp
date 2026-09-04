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
        +--> VoidPaymaster (required route for every official app action)
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
from the ERC-721 at call time. A transfer changes the right to propose and
manage NFT identity metadata, without granting custody of third-party app
assets or unilateral chain-policy power.

`runtime ID` in VoidScan is a deterministic per-deed identifier retained for
the collection's internal namespace and possible future migration. It is not a
live EIP-155 network ID, and a wallet must not be asked to add it as an RPC
network.

## VOID-only application invariant

Every official VoidScan/VoidDEX action is a signed request to `VoidPaymaster`:
the relayer supplies parent-chain ETH, the Runtime collects that chain's fee in
VOID, and the paymaster charges a bounded VOID gas reimbursement. The user
must never be routed by an official app to a bare token faucet, pool, or
runtime call that bypasses the chain fee or asks them to supply ETH.

For an application asset that moves during the call, the official interface
first checks the existing allowance. On first use it may request an EIP-2612
setup permit to the immutable Runtime or Paymaster; it does not request that
permit again while sufficient allowance remains. Every actual action still
requires a separate `SponsoredCall` signature containing an exact, one-call
budget. The Runtime can spend an allowance only while executing that signed
budget for the same user, chain and registered app. `sponsorWithAssetPermits`
rejects any setup permit not tied to a token needed by that signed action and
to either the Runtime or Paymaster. Non-compliant ERC-20 assets require a
separately reviewed adapter or an ordinary one-time approval.

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

DAO-controlled policy is mandatory for every active chain. The first holder
sets the original transaction fee while activating its deed, after its DAO has
been created. Every later transaction-fee or new-app publishing change can be
made only by that same DAO after a passed five-day vote. There is no switch to
return this power to a holder. Identity metadata remains holder-managed, since
changing a label or social link does not rewrite execution rules or custody.

The collection genesis mint is protocol infrastructure, outside every deed's
runtime. It takes ETH because it creates the Deed and starts the VOID economy;
the chain is still inactive, so no chain transaction fee exists yet. The V7
mint imported the verified ownership of the earlier test deployment and then
continued a one-mint-per-wallet supply from the next Deed ID. Mint proceeds are
split by the immutable genesis rules into liquidity and time-locked protocol
or builder buckets. Once a Deed exists, its NFT/VOID market trades are ordinary
Chain 1 app actions and therefore use the signed VOID Paymaster route.

## What a real independent chain would require

Promotion from this runtime to a rollup is a new protocol project. At minimum it
needs a supported rollup stack on the chosen parent, sequencer and batch
submission operations, data availability and finality rules, a node/RPC service,
block explorer/indexer, bridge and canonical asset rules, EIP-155 chain ID,
native-gas policy, incident response, monitoring and a new audit scope.

The NFT may remain the economic and configuration deed through that migration,
but no current contract makes that migration automatic. Calling the current
runtime a separate L2/L3 would hide those requirements and is incorrect.
