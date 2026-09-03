# Governance rules

This file records product rules that alter the contracts or the user-facing
application. A new implementation must follow these rules unless the decision
is explicitly changed here.

## Per-chain DAO

- Every deed has one DAO with its own address and state.
- The current holder of that deed creates proposals for its DAO.
- A proposal can only set that chain's transaction-fee limit. It cannot take
  assets, remove applications, alter another chain, or change protocol roles.
- Any wallet holding VOID at the proposal snapshot can vote for or against it.
- VOID never enters the DAO: there is no staking, lock, approval, or withdrawal
  to participate in governance.
- Voting power is the wallet's VOID balance at the last completed block before
  the proposal. This prevents the same VOID from being transferred to another
  wallet and counted twice.
- Each vote lasts exactly five days. A proposal needs 10% quorum and more votes
  for than against. Anyone can execute a passed proposal.

## Token requirement

The vote token must expose verifiable historical wallet balances. The testnet
VOID token stores these snapshots on-chain. Before mainnet, the token deployed
by the collection market must provide compatible historical-balance reads, or
the DAO must use a separately audited snapshot system. A live `balanceOf` vote
is not acceptable because transferred VOID could vote more than once.
