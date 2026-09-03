# Governance rules

This file records product rules that alter the contracts or the user-facing
application. A new implementation must follow these rules unless the decision
is explicitly changed here.

## Per-chain DAO

- Every deed has one DAO with its own address and state.
- The current holder of that deed creates proposals for its DAO.
- A proposal contains a human-readable subject and zero to eight zero-ETH
  on-chain actions. A proposal with no action is a signal vote.
- The DAO does not impose a subject list. It can propose a transaction-fee
  change, a fee limit, the rule for new app deployments, or another action that
  a target contract expressly authorizes.
- The target enforces authority. The runtime accepts configuration only from
  the DAO registered for that same deed; a DAO cannot alter another chain,
  remove a publisher's app, seize assets, or change protocol/paymaster roles.
- The first holder sets the original transaction fee when activating the
  chain. After activation, the DAO rule is permanent: only that chain's DAO
  can change its transaction fee or whether new apps are open to anyone. There
  is no action that returns this power to the holder. The holder still controls
  display metadata such as the name, image and social links; those fields do
  not change chain execution or economics.
- Any wallet holding VOID at the proposal snapshot can vote for or against it.
- VOID never enters the DAO: there is no staking, lock, approval, or withdrawal
  to participate in governance.
- Voting power is the wallet's VOID balance at the last completed block before
  the proposal. This prevents the same VOID from being transferred to another
  wallet and counted twice.
- Each vote lasts exactly five days. A proposal needs 10% quorum and more votes
  for than against. Anyone can execute a passed proposal. Every action must
  succeed or the proposal remains unexecuted.

## Token requirement

The vote token must expose verifiable historical wallet balances. The testnet
VOID token stores these snapshots on-chain. Before mainnet, the token deployed
by the collection market must provide compatible historical-balance reads, or
the DAO must use a separately audited snapshot system. A live `balanceOf` vote
is not acceptable because transferred VOID could vote more than once.
