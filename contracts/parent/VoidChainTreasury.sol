// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IVoidChainDeed {
    function ownerOf(uint256 tokenId) external view returns (address);
}

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

/// @title VoidChainTreasury
/// @notice Receives a chain's swept revenue on the parent chain and pays the
///         deed holder.
///
/// @dev    WHY THIS CONTRACT IS SO SMALL
///
///         An earlier version carried settlement debt, amortisation policy and a
///         four-way split. Almost all of it was unnecessary, for two reasons.
///
///         First, Nitro already charges the cost of posting to the parent chain
///         inside every transaction: the L1 base fee goes straight to the batch
///         poster at the moment the transaction executes. There is no month in
///         which a chain "owes" its settlement -- it is collected up front, in
///         the same payment, in the same currency the user already spent. What
///         reaches this contract is what remained after that.
///
///         Second, the protocol absorbs the one-off cost of deploying a chain's
///         rollup contracts rather than lending it to the buyer. A deed never
///         starts life in debt, so there is no debt to model.
///
///         What survives is a single 2% protocol fee. The AEP licence is taken
///         at source by Arbitrum's own router, before revenue ever reaches here.
///
///         WHY OWNERSHIP IS READ AT SETTLEMENT, NOT AT ACCRUAL
///
///         `ownerOf` is called when revenue is settled, so a deed sold mid-period
///         needs no reconciliation: the buyer earns from the moment of transfer.
///         The alternative -- crediting whoever held the deed while each block was
///         produced -- would require tracking ownership per block across 1111
///         chains to pay out the identical result.
contract VoidChainTreasury is ReentrancyGuard {
    IVoidChainDeed public immutable deed;

    /// @notice The currency the revenue actually arrives in: VOID.
    ///
    /// @dev    THIS CONTRACT NEVER TOUCHES NATIVE VALUE, AND THE REASON IS
    ///         STRUCTURAL.
    ///
    ///         On the VOID Chains, gas is paid in VOID. It is what accumulates in
    ///         each chain's fee account, and it is what crosses the bridge back.
    ///         On the parent chain, VOID is an ERC-20 — so the revenue arrives
    ///         here as a token call, never as `msg.value`.
    ///
    ///         The first version of this contract was `payable` and paid with
    ///         `call{value:}`. It compiled, and the tests passed, because the
    ///         tests sent ETH — the one asset this system will never see. It was
    ///         the same mistake that had already happened with `ERC20Inbox`:
    ///         choosing your own gas token converts EVERY "native value" in the
    ///         protocol into a "token call", and each place left behind keeps
    ///         compiling until it meets real money.
    IERC20 public immutable voidToken;

    /// @notice Recipient of the VOIDS protocol fee.
    address public protocolTreasury;

    address public governance;

    /// @dev    NOTE ON THE AEP LICENCE -- IT IS NOT COLLECTED HERE.
    ///
    ///         An earlier version of this contract deducted 10% for the Arbitrum
    ///         Foundation. That was duplication: Arbitrum's own `RewardDistributor`
    ///         already sits at each chain's fee collector address and splits
    ///         revenue at source, forwarding the licence share to a
    ///         `ChildToParentRouter` that bridges it to the Foundation without any
    ///         action from us. Deducting it again here would have charged every
    ///         chain owner the licence twice.
    ///
    ///         What arrives at this contract is therefore already net of AEP.

    /// @notice VOIDS protocol fee: 2% of gross.
    /// @dev    Levied on GROSS gas revenue, never on "profit".
    ///
    ///         This distinction is load-bearing. A contract cannot see a chain
    ///         owner's expenses -- servers, RPC, staff -- so "profit" would be a
    ///         number somebody declares, and any declared number can be inflated
    ///         until the fee rounds to zero. Gross gas revenue is measured by the
    ///         chain itself and verifiable on-chain by anyone, which makes this
    ///         fee impossible to avoid and impossible to dispute.
    uint256 public constant PROTOCOL_BPS = 200; // 2%

    uint256 public constant BPS_DENOMINATOR = 10_000;

    /// @notice Pull payments. Never push: a deed holder may be a contract that
    ///         reverts on receive, and one such holder must not be able to brick
    ///         settlement for every other chain in the same batch.
    mapping(address account => uint256) public claimable;

    /// @notice Lifetime revenue per chain, for the explorer and for price discovery.
    mapping(uint256 tokenId => uint256) public lifetimeRevenue;

    /// @notice Each settler's scope: which chain it may settle.
    ///
    /// @dev    0 = not authorized. `WILDCARD_SCOPE` = any chain (the chainapp
    ///         runtime, which serves all 1,111). Any other value N = chain N
    ///         only (an L3 router, bound to its own chain).
    ///
    ///         The authorization itself closes the original defect — an
    ///         ownerless `settle` let anyone inflate `lifetimeRevenue` by washing
    ///         at 2%. The per-chain scope is the second layer: even among
    ///         legitimate settlers, one router cannot reach another's chain.
    mapping(address settler => uint256 scope) public settlerScope;

    /// @notice The scope that authorizes settling ANY chain. The runtime only.
    uint256 internal constant WILDCARD_SCOPE = type(uint256).max;

    /// @notice Read compatibility: a settler is authorized (for any scope) if
    ///         its scope is non-zero.
    function authorizedSettler(address settler) external view returns (bool) {
        return settlerScope[settler] != 0;
    }

    event RevenueSettled(
        uint256 indexed tokenId,
        address indexed deedHolder,
        uint256 gross,
        uint256 protocolFee,
        uint256 holderShare
    );
    event Claimed(address indexed account, uint256 amount);
    event ProtocolTreasuryUpdated(address previous, address next);
    event GovernanceTransferred(address previous, address next);
    event SettlerAuthorized(address settler, uint256 scope);
    event Credited(address indexed beneficiary, uint256 amount);
    event ProtocolRevenueSent(address indexed recipient, uint256 amount);

    error NotGovernance(address caller);
    error NotAuthorizedSettler(address caller);
    error SettlerWrongChain(address caller, uint256 tokenId);
    error BadScope();
    error NothingToClaim();
    error TransferFailed();
    error ZeroAddress();
    error NothingToSettle();

    constructor(
        IVoidChainDeed deed_,
        IERC20 voidToken_,
        address protocolTreasury_,
        address governance_
    ) {
        if (address(voidToken_) == address(0)) revert ZeroAddress();
        voidToken = voidToken_;
        if (
            address(deed_) == address(0) || protocolTreasury_ == address(0)
                || governance_ == address(0)
        ) revert ZeroAddress();

        deed = deed_;
        protocolTreasury = protocolTreasury_;
        governance = governance_;
    }

    /// @notice Settles revenue crediting the deed's CURRENT owner.
    /// @dev    Serves the L3 path, where `sweep` is continuous and the gap
    ///         between generating and settling is seconds — reading `ownerOf` on
    ///         the spot is safe because the window is tiny. For revenue that
    ///         accumulates for an indefinite time (chainapps), use `settleTo`
    ///         with an explicit beneficiary.
    function settle(uint256 tokenId, uint256 amount) external nonReentrant {
        _settle(tokenId, deed.ownerOf(tokenId), amount);
    }

    /// @notice Settles revenue crediting an EXPLICIT beneficiary.
    ///
    /// @dev    THIS EXISTS BECAUSE OF A THEFT FOUND IN RED-TEAM.
    ///
    ///         `settle` credits whoever holds the deed at the instant of
    ///         settlement. In a model where revenue accrues for an indefinite
    ///         time before being settled — the chainapp runtime's `pending` —
    ///         that let the BUYER of a deed take the revenue the SELLER
    ///         generated: buying and flushing before the seller did was enough.
    ///
    ///         With this function, the runtime credits whoever REALLY generated
    ///         the revenue, recorded at the moment it was earned rather than at
    ///         settlement. It remains restricted to authorized settlers, and
    ///         `lifetimeRevenue` is per chain — it does not change with the
    ///         beneficiary.
    function settleTo(uint256 tokenId, address beneficiary, uint256 amount)
        external
        nonReentrant
    {
        if (beneficiary == address(0)) revert ZeroAddress();
        _settle(tokenId, beneficiary, amount);
    }

    /// @notice Credits a beneficiary WITHOUT splitting — the amount is already net.
    ///
    /// @dev    The chainapp runtime now separates the 2% at the instant of each
    ///         transaction (the toll arrives already divided: 98% to the owner's
    ///         pending, 2% to the protocol's account). So by settlement time the
    ///         value is already net and the treasury must NOT split it again —
    ///         only record it. This function is that pure credit for a deed
    ///         holder. The protocol recipient is the one exception: when the
    ///         runtime sweeps its already-separated 2%, it is delivered directly
    ///         to the configured public address. A treasury wallet therefore
    ///         never needs a signing key merely to make its revenue arrive.
    ///         It remains restricted to authorized settlers; since it uses the
    ///         caller's money, a hostile settler could only donate its own
    ///         balance, never divert anyone else's.
    ///
    ///         The 2%/98% split of the L3 path remains in `settle`/`settleTo`,
    ///         because there the revenue arrives gross across the bridge.
    function creditTo(address beneficiary, uint256 amount) external nonReentrant {
        if (settlerScope[msg.sender] == 0) revert NotAuthorizedSettler(msg.sender);
        if (beneficiary == address(0)) revert ZeroAddress();
        if (amount == 0) revert NothingToSettle();
        if (!voidToken.transferFrom(msg.sender, address(this), amount)) revert TransferFailed();
        if (beneficiary == protocolTreasury) {
            if (!voidToken.transfer(protocolTreasury, amount)) revert TransferFailed();
            emit ProtocolRevenueSent(protocolTreasury, amount);
            return;
        }
        claimable[beneficiary] += amount;
        emit Credited(beneficiary, amount);
    }

    /// @dev The holder's share is the residual, never a fourth percentage.
    ///      Integer division always loses a remainder; making the last leg
    ///      "whatever is left" means the parts always sum to the whole, and the
    ///      dust falls to the beneficiary rather than being stranded.
    function _settle(uint256 tokenId, address beneficiary, uint256 amount) internal {
        // Each settler only settles the chain it was authorized for.
        //
        // The chainapp runtime serves EVERY chain, so it gets the wildcard scope
        // — it is the one unavoidable trust, because a contract can only serve
        // 1,111 chains if it may touch any of them. But each L3 router belongs to
        // a single chain, and there is no reason for #5's router to touch #9.
        // Scoping them to their own chain is the same principle as the rest of
        // the protocol: authority does not cross a boundary. A buggy or
        // compromised router stays stuck on its own chain.
        uint256 scope = settlerScope[msg.sender];
        if (scope == 0) revert NotAuthorizedSettler(msg.sender);
        if (scope != WILDCARD_SCOPE && scope != tokenId) {
            revert SettlerWrongChain(msg.sender, tokenId);
        }

        uint256 gross = amount;
        if (gross == 0) revert NothingToSettle();

        // The token comes in BEFORE any credit is booked. If the transfer
        // fails, nobody is left with a claimable balance that does not exist.
        if (!voidToken.transferFrom(msg.sender, address(this), gross)) revert TransferFailed();

        uint256 protocolFee = (gross * PROTOCOL_BPS) / BPS_DENOMINATOR;
        // A 1-wei floor found in red-team: below 50 wei, 2% rounds to zero, and
        // an underpriced chain would settle revenue without paying the protocol
        // — contradicting "washing always costs 2%". It is dust, unreachable in
        // the real configuration (the minimum toll is 1e16 wei) and irrational
        // to exploit (the flush's gas exceeds the dust), but closing it costs one
        // line. It only affects sub-50-wei settlements; for any normal amount
        // `protocolFee` is already >= 1 and the residual dust still falls to the
        // owner.
        if (protocolFee == 0) protocolFee = 1;
        uint256 holderShare = gross - protocolFee;

        lifetimeRevenue[tokenId] += gross;
        claimable[protocolTreasury] += protocolFee;
        claimable[beneficiary] += holderShare;

        emit RevenueSettled(tokenId, beneficiary, gross, protocolFee, holderShare);
    }

    /// @notice Withdraws what has accrued.
    /// @dev    Clears the balance BEFORE the transfer —
    ///         checks-effects-interactions. `nonReentrant` is the second line of
    ///         defense, not the first: were the order reversed, the guard would
    ///         be the only thing between a malicious holder and the whole
    ///         treasury.
    function claim() external nonReentrant {
        uint256 amount = claimable[msg.sender];
        if (amount == 0) revert NothingToClaim();
        claimable[msg.sender] = 0;

        if (!voidToken.transfer(msg.sender, amount)) revert TransferFailed();
        emit Claimed(msg.sender, amount);
    }

    /// @notice Redirects the protocol fee to another address.
    /// @dev    Affects future settlements only. What was already credited stays
    ///         withdrawable by the old address — changing the destination should
    ///         not confiscate what was already earned.
    function setProtocolTreasury(address next) external {
        if (msg.sender != governance) revert NotGovernance(msg.sender);
        if (next == address(0)) revert ZeroAddress();
        emit ProtocolTreasuryUpdated(protocolTreasury, next);
        protocolTreasury = next;
    }

    /// @notice Transfers the protocol's governance.
    function transferGovernance(address next) external {
        if (msg.sender != governance) revert NotGovernance(msg.sender);
        if (next == address(0)) revert ZeroAddress();
        emit GovernanceTransferred(governance, next);
        governance = next;
    }

    /// @notice Authorizes a WILDCARD settler — it may settle any chain.
    /// @dev    Reserved for the chainapp runtime, which serves all 1,111 and
    ///         therefore has to reach all of them. It is the model's one
    ///         unavoidable trust: a contract that serves every chain can touch
    ///         every chain. Use `setChainSettler` for routers, which should stay
    ///         bound to their own.
    function setAuthorizedSettler(address settler, bool allowed) external {
        if (msg.sender != governance) revert NotGovernance(msg.sender);
        if (settler == address(0)) revert ZeroAddress();
        settlerScope[settler] = allowed ? WILDCARD_SCOPE : 0;
        emit SettlerAuthorized(settler, allowed ? WILDCARD_SCOPE : 0);
    }

    /// @notice Authorizes a settler BOUND TO ONE CHAIN — its L3 router.
    /// @dev    A router for chain N only settles chain N. Even buggy or
    ///         compromised, it cannot reach another chain's revenue — the
    ///         boundary is enforced by the treasury, not trusted to the router.
    function setChainSettler(address settler, uint256 tokenId, bool allowed) external {
        if (msg.sender != governance) revert NotGovernance(msg.sender);
        if (settler == address(0)) revert ZeroAddress();
        // tokenId 0 does not exist (deeds run from 1 to 1111) and the maximum is
        // the wildcard: neither is a valid chain scope.
        if (tokenId == 0 || tokenId == WILDCARD_SCOPE) revert BadScope();
        settlerScope[settler] = allowed ? tokenId : 0;
        emit SettlerAuthorized(settler, allowed ? tokenId : 0);
    }
}
