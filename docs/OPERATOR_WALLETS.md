# Wallet and role topology

Private keys never belong in this repository, Vercel logs, deployment JSON or
support messages. The addresses below are public testnet identities only.

## Current Robinhood testnet

| Role | Public address | Permission |
| --- | --- | --- |
| Temporary governance/deployer | `0x440D2340C907735632A5fa0070273AFeF3D26827` | Testnet deployment and timelock proposer; must not be reused for mainnet. |
| VoidScan relayer | `0x313dE3E0180DF09684017e23a41B878fA6294633` | Broadcasts signed VoidScan actions and fronts parent-chain ETH. |
| VoidDEX relayer | `0xA7e6df3D2F2E9E6260738d33d6d042D58C6e1fd5` | Broadcasts signed DEX actions and fronts parent-chain ETH. |
| TWAP keeper | `0x4EE30a005BcD962314F9dC757F20967712256c26` | Updates the public price observation; cannot spend protocol funds. |
| Refill keeper | `0x741a518D9724361aF77D97Cc10fDd0192f5c0314` | Calls the bounded Paymaster refill; cannot choose the route or price floor. |
| Protocol revenue destination | `0x892F840aF9CFE78D4FF91D8e6D0F783264388A78` | Receives protocol revenue. It is not an operational hot key. |

Each relayer is serialized independently in Postgres. A compromise therefore
does not grant governance, treasury, oracle or another relayer role. The
Paymaster contract still enforces signed user caps, gas-price ceiling, per-block
budget and per-chain daily budget.

## Mainnet recommendation

Use two separate hardware-backed 3-of-5 Safes: one for governance and one for
treasury, with different signer sets. Add one cold deployer that relinquishes
authority, one pause-only emergency guardian and four independent hot service
keys (VoidScan relay, VoidDEX relay, TWAP keeper and refill keeper). Safes are
contract accounts and do not themselves have private keys.

The strict layout therefore needs **16 human/key wallets**: 5 governance
signers, 5 treasury signers, 1 cold deployer, 1 emergency guardian and 4 hot
operators. Reusing the same five humans for both Safes reduces it to 11 but
increases correlated-key risk. Permissionless third-party relayers may be added
without protocol authority.
