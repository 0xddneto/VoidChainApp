// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IVoidChainDeed {
    function ownerOf(uint256 tokenId) external view returns (address);
}

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

interface IVoidChainTreasury {
    function settle(uint256 tokenId, uint256 amount) external;
    function settleTo(uint256 tokenId, address beneficiary, uint256 amount) external;
    function creditTo(address beneficiary, uint256 amount) external;
    function protocolTreasury() external view returns (address);
}

/// @notice The minimum a contract has to expose to be an application of a chain.
/// @dev    It lets the registry VERIFY the target instead of accepting any
///         address. Without this check, someone would publish the VOID token's
///         own contract as an "application" and make the runtime sign transfers
///         of the balance that belongs to every chain.
interface IERC721Minimal {
    function transferFrom(address from, address to, uint256 tokenId) external;
}

interface IVoidPriceOracle {
    function usdToVoid(uint256 usdAmount) external view returns (uint256);
}

interface IChainApp {
    function chainId() external view returns (uint256);
    function runtime() external view returns (address);
}

/// @title VoidChainAppRuntime
/// @notice A VOID Chain in its initial state: its own economy, its own rules and
///         its own revenue, running on the parent chain's EVM.
///
/// @dev    WHY THIS EXISTS.
///
///         A real L3 needs a sequencer, a node, disk and RPC — about $1 per
///         chain per month, measured. For chains that get used, that pays for
///         itself out of their own gas. For a collection of 1,111 where most
///         will go months without a transaction, it is pure cost, every month,
///         forever.
///
///         Here the chain has none of that because it does not need it: what
///         orders the transactions is the parent chain's sequencer, what runs
///         them is its EVM, what holds the state is its storage and what answers
///         queries are its RPCs. All of it is already standing and already paid
///         for.
///
///         WHAT A CHAIN IS HERE.
///
///         An isolated execution environment with an economy of its own. Anyone
///         may publish applications on it, the owner sets what a call costs and
///         collects it, and no chain can reach into another. That isolation is
///         a property of this code and verifiable line by line: there is no path
///         below that takes a call on one chain to a contract of another.
///
///         What it does not have is consensus of its own — ordering, execution
///         and settlement are the parent chain's, which is exactly what makes a
///         chain here free to run. A chain that outgrows that arrangement is
///         promoted; see THE WAY OUT.
///
///         THE WAY OUT.
///
///         A chainapp that gains traction becomes a real L3: the owner pays for
///         the promotion, the state migrates, and the same NFT remains the deed.
///         This contract is a chain's initial state, not a substitute for one.
contract VoidChainAppRuntime is ReentrancyGuard {
    IVoidChainDeed public immutable deed;
    IERC20 public immutable voidToken;
    IVoidChainTreasury public immutable treasury;

    struct ChainApp {
        bool active;
        /// @notice Toll per call, IN DOLLARS, with 18 decimals.
        ///
        /// @dev    IT USED TO BE IN VOID, and that had a silent defect: a 10x
        ///         appreciation of the token multiplied the real cost of using
        ///         the chain by ten, overnight, without the owner having decided
        ///         anything. Whoever builds on the chain woke up to a bill ten
        ///         times larger.
        ///
        ///         In dollars, the owner controls the real price and the user
        ///         always pays the same in real terms. The conversion to VOID
        ///         happens at call time, through the oracle.
        uint256 feePerCallUsd;
        /// @notice Whether anyone may publish applications on this chain.
        ///
        /// @dev    On by default, and that is not a detail: on a real blockchain
        ///         nobody asks permission to deploy a contract. A chain where
        ///         only the owner publishes is not a chain, it is their website
        ///         — and no developer builds where the owner can simply say no.
        ///
        ///         It stays an option because there are legitimate cases for a
        ///         closed chain (a company's internal use, for instance), but
        ///         whoever closes it takes on the cost: nobody builds there
        ///         without permission, and therefore almost nobody builds.
        bool permissionlessDeploy;
        /// @notice The OWNER's share (98%), already net, waiting to be settled.
        /// @dev    The protocol's 2% is NOT here — it is split off in `execute`
        ///         and goes to `protocolAccrued`. This balance belongs to the
        ///         owner alone, and it is what `flush` credits to them.
        uint256 pending;
        /// @notice Who was the owner when the current `pending` was generated.
        ///
        /// @dev    `pending` belongs to whoever GENERATED it, not to whoever
        ///         holds the deed at settlement time. Without this record, the
        ///         buyer of a chain would take the revenue the seller produced —
        ///         it would be enough to buy and flush before them. By recording
        ///         the generator, settlement credits the right person even if the
        ///         sale happens in between.
        address pendingOwner;
        /// @notice All-time gross revenue, for the explorer.
        ///
        /// @dev    IT IS NOT PROOF OF ORGANIC DEMAND, and that is a fundamental
        ///         limitation, not a bug with a fix inside the contract.
        ///
        ///         The owner can inflate this number by using their own chain and
        ///         paying the toll to themselves: the VOID leaves them, 98% comes
        ///         back (2% protocol), and the number goes up. Restricting by
        ///         `msg.sender` does not solve it — a second wallet would be
        ///         enough. It is the same wash trading that exists on any DEX or
        ///         NFT marketplace: on-chain there is no way to tell a
        ///         third-party user from the owner's alt wallet.
        ///
        ///         The real defense is OFF-CHAIN: VoidScan should flag volume
        ///         whose payer coincides with the owner (or is funded by them)
        ///         and show third-party revenue separately. A buyer who treats
        ///         this raw number as guaranteed demand is being naive — it is a
        ///         ceiling on the claim, not a proof of it.
        uint256 lifetimeRevenue;
        uint256 callCount;
    }

    /// @notice Everything a call authorizes the applications to move.
    ///
    /// @dev    One struct, and not eight loose parameters, for a concrete
    ///         reason: the version with loose parameters did not fit in the
    ///         EVM's stack. The struct also keeps the API stable — adding a new
    ///         kind of authorization later does not change the function
    ///         signatures.
    struct SpendAuth {
        /// @notice ERC-20 tokens and how much of each.
        address[] tokens;
        uint256[] limits;
        /// @notice ERC-721 collections and WHICH tokenIds. By id, never by
        ///         quantity: an NFT's value lies in not being fungible, so "may
        ///         move 1 of this collection" would let the app pick which one.
        address[] collections;
        uint256[] nftIds;
    }

    mapping(uint256 tokenId => ChainApp) public apps;

    /// @notice Which contracts belong to which chain.
    /// @dev    A contract is only reachable through ITS OWN chain's `execute`.
    ///         That is what makes the isolation a property of the code rather
    ///         than a promise: there is no path in this contract that takes a
    ///         call from chain A to a contract of chain B.
    mapping(uint256 tokenId => mapping(address app => bool)) public belongsTo;

    /// @notice Who published each application.
    /// @dev    Recorded so that only that person can withdraw it. Without this
    ///         record, either nobody could withdraw anything, or the chain owner
    ///         could erase other people's work.
    mapping(uint256 tokenId => mapping(address app => address)) public publisherOf;

    /// @notice Which chain is executing at this instant.
    /// @dev    Apps read this to know on whose behalf they act. Outside an
    ///         execution it is zero, and that is why an app contract called
    ///         directly — without going through the toll — does not work.
    uint256 public executingChain;

    /// @notice Who called `execute`, so apps know who the user is.
    /// @dev    Without this, every app would see `msg.sender` as this runtime and
    ///         could not tell one user from another.
    address public executingCaller;

    /// @notice The oracle that converts the toll from dollars into VOID.
    /// @dev    Replaceable by the deed's governance: oracles break, and an
    ///         immutable one here would stop all 1,111 chains at once.
    IVoidPriceOracle public oracle;

    /// @notice THERE IS NO GLOBAL TOLL CEILING ANY MORE.
    ///
    /// @dev    There was a `MAX_FEE` of 100 VOID, immutable. It was removed by
    ///         decision of the protocol owner, and the reason is sound: the
    ///         user's real protection was never that ceiling, it is the `maxFee`
    ///         they declare on EVERY call. Whoever signs sees the price and
    ///         refuses anything above it.
    ///
    ///         The global ceiling was belt and braces for people who do not look
    ///         at what they sign — and, in exchange, it stopped a legitimate
    ///         chain from charging a lot for something worth a lot. Each chain's
    ///         ceiling becomes a matter for its own governance.

    /// @notice The protocol fee, split off from EVERY toll on the spot.
    /// @dev    2%, the same as the treasury's. The split happens here, in
    ///         `execute`, and not at settlement — this is the design decision the
    ///         owner asked for: the 2% leaves the toll at the instant of the
    ///         transaction and never enters the owner's balance.
    /// @dev Ceiling on budgeted tokens per call. It exists so the cleanup loop
    ///      has predictable cost — a request with a thousand tokens would make
    ///      finalization expensive enough to become a weapon against the relayer.
    uint256 public constant MAX_BUDGETED_TOKENS = 8;

    uint256 public constant PROTOCOL_BPS = 200;
    uint256 public constant BPS = 10_000;

    /// @notice The protocol's share, already split off, waiting to go to the
    ///         treasury.
    ///
    /// @dev    THIS IS THE PROTOCOL'S PROFIT SYSTEM. The 2% of every toll lands
    ///         here in `execute`, NEVER in the owner's `pending`. The owner does
    ///         not see it, cannot claim it and never comes to hold it.
    ///         `sweepProtocol` takes it to the treasury; anyone may call, the
    ///         destination is fixed.
    uint256 public protocolAccrued;

    /// @notice Revenue parked in the name of whoever generated it, waiting to be
    ///         taken to the treasury by `claimOwed`.
    /// @dev    See `_parkPending`. It exists so that a change of a chain's owner
    ///         does not charge the trip to the treasury to whoever happens to be
    ///         using the chain at the time.
    mapping(address beneficiary => uint256) public owed;

    /// @notice How much of each token the applications may spend from the user IN
    ///         THIS call. Cleared at the end of it, always.
    ///
    /// @dev    THIS CLOSES THE HOLE AT THE FRONT DOOR. The bubble covered
    ///         execution, but every application that moves the user's tokens
    ///         needed an `approve` from them — and granting permission is a
    ///         transaction, which a user without ETH cannot send. Every new app
    ///         required them to find ETH once. The bubble leaked at each app's
    ///         door.
    ///
    ///         Now the user authorizes ONE spender — this runtime — and does it
    ///         by signature (EIP-2612), with no transaction at all. Applications
    ///         pull through `spendFrom`.
    ///
    ///         And the result is MORE secure than the `approve` they would have
    ///         given before, not less: an ordinary `approve` is permanent and
    ///         unlimited, and stays valid long after you forget about it. This
    ///         budget comes inside the signed request, is valid only for that
    ///         call, and dies with it. A hostile app cannot touch anything beyond
    ///         what the user declared for the call in which they invoked it.
    mapping(address token => uint256) public spendBudget;

    /// @dev List of tokens with an open budget, so all of them can be cleared at
    ///      the end of the call. Without it, a leftover budget would survive the
    ///      execution and the next caller would inherit the previous one's
    ///      permission.
    address[] private budgetedTokens;

    /// @notice Which specific NFTs the applications may move IN THIS call.
    ///
    /// @dev    WHY BY `tokenId`, AND NOT BY QUANTITY. For ERC-20 the budget is an
    ///         amount: "may spend up to 10". For ERC-721 that does not work —
    ///         authorizing "may move 1 NFT of this collection" would let the app
    ///         choose WHICH, and an NFT's value lies precisely in not being
    ///         fungible. The user authorizes the token they meant to move.
    ///
    ///         This path is OFFERED, not mandatory. An application may keep using
    ///         `transferFrom` directly if it prefers the user to authorize it
    ///         with `setApprovalForAll` — only then the user needs ETH once, and
    ///         the bubble does not close for it.
    mapping(address collection => mapping(uint256 tokenId => bool)) public nftBudget;

    /// @dev List to clear at the end of the call, for the same reason as ERC-20.
    address[] private budgetedCollections;
    uint256[] private budgetedNftIds;

    /// @notice The only contract authorized to execute on behalf of others.
    ///
    /// @dev    THIS IS THE MOST DANGEROUS PIECE OF THE CONTRACT. Whoever sits
    ///         here can call `executeFor` declaring any address as the user —
    ///         that is, can impersonate anyone inside any chain.
    ///
    ///         That is why there is no function to change it. It is written once,
    ///         by the deployer, and freezes. An ordinary `setForwarder` would
    ///         hand the protocol a key capable of robbing everyone — exactly the
    ///         kind of administrative power the rest of this system avoids.
    ///
    ///         Changing paymasters means deploying a new runtime. It is expensive
    ///         on purpose: the cost sits on the right side of the scale.
    address public forwarder;

    /// @notice The factory that gives each chain its DAO.
    ///
    /// @dev    Written once, like the forwarder, and for the same reason: what
    ///         decides which contract speaks for a chain is not something to
    ///         leave behind a setter. Replacing it means a new runtime.
    address public daoFactory;

    /// @notice Each chain's own DAO. One contract per chain, so a proposal on
    ///         one cannot reach another and a chain's governance can be replaced
    ///         without touching the other 1,110.
    mapping(uint256 tokenId => address) public daoOf;

    /// @notice The most a chain may charge per call, in dollars, as its own DAO
    ///         decided. Zero when no ceiling has been set.
    ///
    /// @dev    Paired with a flag rather than read as "zero means unlimited",
    ///         because a DAO voting a ceiling of zero — forcing its chain to be
    ///         free — is a decision it is allowed to make, and it must not be
    ///         indistinguishable from never having voted at all.
    mapping(uint256 tokenId => uint256) public tollCeilingUsd;
    mapping(uint256 tokenId => bool) public hasTollCeiling;

    /// @notice Whether this chain chose to make its economic configuration DAO-only.
    ///
    /// @dev    A DAO ceiling alone prevents an excessive fee, but it does not
    ///         stop the deed holder from changing a fee or closing deployments
    ///         without a vote. Once this switch is on, those policy changes can
    ///         only arrive through the DAO registered for this exact chain. The
    ///         DAO may also vote to switch it off; the holder never can.
    ///
    ///         This deliberately does not govern the deed's display name,
    ///         image or social links. Those are identity metadata, not an
    ///         economic or execution rule.
    mapping(uint256 tokenId => bool) public governanceControlsConfig;

    /// @dev    Kept only for the one-time write of the forwarder and the DAO
    ///         factory. After that it grants no power at all.
    address private immutable deployer;

    event ChainAppActivated(uint256 indexed tokenId, address activator);
    event ForwarderSet(address forwarder);
    event DaoFactorySet(address factory);
    event DaoRegistered(uint256 indexed tokenId, address dao);
    event TollCeilingSet(uint256 indexed tokenId, uint256 ceilingUsd);
    event GovernanceControlChanged(uint256 indexed tokenId, bool daoRequired);
    event ProtocolSwept(address treasury, uint256 amount);
    event AppRegistered(uint256 indexed tokenId, address app, address publisher);
    event DeploymentPolicyChanged(uint256 indexed tokenId, bool permissionless);
    event AppUnregistered(uint256 indexed tokenId, address app);
    event FeeUpdated(uint256 indexed tokenId, uint256 previousUsd, uint256 nextUsd);
    event OracleUpdated(address oracle);
    event Executed(uint256 indexed tokenId, address indexed caller, address target, uint256 fee);
    event RevenueFlushed(uint256 indexed tokenId, uint256 amount);
    event RevenueParked(uint256 indexed tokenId, address indexed beneficiary, uint256 amount);
    event OwedClaimed(address indexed beneficiary, uint256 amount);
    event NftSpent(
        uint256 indexed tokenId,
        address indexed user,
        address collection,
        address app,
        address to,
        uint256 nftId
    );
    event Spent(
        uint256 indexed tokenId,
        address indexed user,
        address token,
        address app,
        address to,
        uint256 amount
    );

    error NotDeedHolder(uint256 tokenId, address caller);
    error NotActive(uint256 tokenId);
    error AlreadyActive(uint256 tokenId);
    error NotThisChainsApp(uint256 tokenId, address target);
    error ZeroAddress();
    error NothingToFlush();
    error DeploymentClosed(uint256 tokenId, address who);
    error NotThePublisher(uint256 tokenId, address app, address who);
    error NotAChainApp(address target);
    error AppBelongsElsewhere(address app, uint256 declared, uint256 expected);
    error AppOfAnotherRuntime(address app, address declared);
    error TollAboveLimit(uint256 toll, uint256 limit);
    error CallFailed(bytes reason);
    error Reentered();
    error NotTheForwarder(address who);
    error ForwarderAlreadySet(address current);
    error DaoFactoryAlreadySet(address current);
    error NotTheDaoFactory(address who);
    error NotThisChainsDao(uint256 tokenId, address who);
    error DaoAlreadyRegistered(uint256 tokenId, address current);
    error FeeAboveCeiling(uint256 feeUsd, uint256 ceilingUsd);
    error NotTheDeployer(address who);
    error NoExecutionInProgress();
    error BudgetExceeded(address token, uint256 wanted, uint256 budget);
    error BudgetLengthMismatch();
    error TooManyBudgetedTokens(uint256 given, uint256 max);
    error NftNotAuthorized(address collection, uint256 tokenId);

    constructor(IVoidChainDeed deed_, IERC20 voidToken_, IVoidChainTreasury treasury_) {
        if (
            address(deed_) == address(0) || address(voidToken_) == address(0)
                || address(treasury_) == address(0)
        ) revert ZeroAddress();
        deed = deed_;
        voidToken = voidToken_;
        treasury = treasury_;
        deployer = msg.sender;
    }

    /// @notice Writes the authorized paymaster. Once only, forever.
    /// @dev    See the comment on `forwarder`. There is no way back, and that is
    ///         precisely what keeps the authorization from becoming a key.
    function setForwarderOnce(address forwarder_) external {
        if (msg.sender != deployer) revert NotTheDeployer(msg.sender);
        if (forwarder != address(0)) revert ForwarderAlreadySet(forwarder);
        if (forwarder_ == address(0)) revert ZeroAddress();
        forwarder = forwarder_;
        emit ForwarderSet(forwarder_);
    }

    /// @notice Writes the DAO factory. Once only, forever.
    /// @dev    See the comment on `daoFactory`. Same shape as the forwarder:
    ///         what decides who speaks for a chain is not a key to keep.
    function setDaoFactoryOnce(address factory) external {
        if (msg.sender != deployer) revert NotTheDeployer(msg.sender);
        if (daoFactory != address(0)) revert DaoFactoryAlreadySet(daoFactory);
        if (factory == address(0)) revert ZeroAddress();
        daoFactory = factory;
        emit DaoFactorySet(factory);
    }

    /// @notice Records which contract is a chain's DAO.
    ///
    /// @dev    Only the factory, and only once per chain. Once a chain has a
    ///         DAO, nothing in this contract can point it at a different one:
    ///         a governance that the protocol could swap is not governance.
    function registerDao(uint256 tokenId, address dao) external {
        if (msg.sender != daoFactory) revert NotTheDaoFactory(msg.sender);
        address current = daoOf[tokenId];
        if (current != address(0)) revert DaoAlreadyRegistered(tokenId, current);
        if (dao == address(0)) revert ZeroAddress();
        daoOf[tokenId] = dao;
        emit DaoRegistered(tokenId, dao);
    }

    /// @notice A chain's own DAO sets what that chain's owner may not charge
    ///         above.
    ///
    /// @dev    It bounds future prices and never touches the current one. A
    ///         ceiling voted below what a chain already charges leaves that toll
    ///         standing and stops it rising further — retroactively cutting a
    ///         price somebody signed a request against would be the same
    ///         surprise, in the other direction.
    ///
    ///         The caller has to be the DAO OF THAT CHAIN. Accepting any
    ///         registered DAO would let chain #7's electorate price chain #9,
    ///         which is the isolation failing at the top.
    function setTollCeiling(uint256 tokenId, uint256 ceilingUsd) external {
        if (msg.sender != daoOf[tokenId]) revert NotThisChainsDao(tokenId, msg.sender);
        tollCeilingUsd[tokenId] = ceilingUsd;
        hasTollCeiling[tokenId] = true;
        emit TollCeilingSet(tokenId, ceilingUsd);
    }

    /// @notice Makes fee, activation and app-admission policy require a passed DAO vote.
    /// @dev    There is intentionally no deed-holder escape hatch. Otherwise a
    ///         holder could turn DAO control off immediately after the vote that
    ///         enabled it. A future change in either direction is itself a DAO
    ///         action, visible for five days before it can execute.
    function setGovernanceControl(uint256 tokenId, bool daoRequired) external {
        if (msg.sender != daoOf[tokenId]) revert NotThisChainsDao(tokenId, msg.sender);
        governanceControlsConfig[tokenId] = daoRequired;
        emit GovernanceControlChanged(tokenId, daoRequired);
    }

    /// @dev Applies DAO control once a chain has explicitly opted into it. Until
    ///      then, the deed holder remains the chain controller and its own DAO
    ///      may execute an approved action as well.
    modifier onlyChainController(uint256 tokenId) {
        if (governanceControlsConfig[tokenId]) {
            if (daoOf[tokenId] != msg.sender) revert NotThisChainsDao(tokenId, msg.sender);
        } else if (deed.ownerOf(tokenId) != msg.sender && daoOf[tokenId] != msg.sender) {
            revert NotDeedHolder(tokenId, msg.sender);
        }
        _;
    }

    function _isChainController(uint256 tokenId, address caller) private view returns (bool) {
        if (governanceControlsConfig[tokenId]) return daoOf[tokenId] == caller;
        return deed.ownerOf(tokenId) == caller || daoOf[tokenId] == caller;
    }

    // ---------------------------------------------------------------------
    // The deed owner commands their chainapp
    // ---------------------------------------------------------------------

    /// @notice Turns on a deed's chainapp. Costs no infrastructure at all.
    /// @param feePerCallUsd The toll IN DOLLARS, with 18 decimals (1e15 = $0.001).
    function activate(uint256 tokenId, uint256 feePerCallUsd) external onlyChainController(tokenId) {
        if (apps[tokenId].active) revert AlreadyActive(tokenId);
        // A ceiling can be voted before a chain is switched on, and activating
        // above it would leave the chain permanently over its own limit.
        if (hasTollCeiling[tokenId] && feePerCallUsd > tollCeilingUsd[tokenId]) {
            revert FeeAboveCeiling(feePerCallUsd, tollCeilingUsd[tokenId]);
        }

        apps[tokenId].active = true;
        apps[tokenId].feePerCallUsd = feePerCallUsd;
        apps[tokenId].permissionlessDeploy = true; // open, like any chain

        emit ChainAppActivated(tokenId, msg.sender);
        emit FeeUpdated(tokenId, 0, feePerCallUsd);
    }

    /// @notice Changes the chain's toll.
    /// @dev    No timelock, unlike what happens on real chains, and the reason is
    ///         that here the user sees the price BEFORE signing: the value is
    ///         read at call time and charged in the same transaction. On an L3
    ///         the gas price changes underneath whoever is already using it; here
    ///         there is no such interval to protect.
    function setFee(uint256 tokenId, uint256 feePerCallUsd) external onlyChainController(tokenId) {
        if (!apps[tokenId].active) revert NotActive(tokenId);

        // The owner prices their chain freely, up to what the people holding the
        // token that pays its tolls decided. Without this the `maxToll` a payer
        // signs would be the only protection, and that guards one call — not a
        // business built on top of the chain.
        if (hasTollCeiling[tokenId] && feePerCallUsd > tollCeilingUsd[tokenId]) {
            revert FeeAboveCeiling(feePerCallUsd, tollCeilingUsd[tokenId]);
        }

        emit FeeUpdated(tokenId, apps[tokenId].feePerCallUsd, feePerCallUsd);
        apps[tokenId].feePerCallUsd = feePerCallUsd;
    }

    /// @notice Points at the oracle. Protocol governance, not the chain owner's.
    function setOracle(IVoidPriceOracle oracle_) external {
        if (msg.sender != deployer) revert NotTheDeployer(msg.sender);
        if (address(oracle_) == address(0)) revert ZeroAddress();
        oracle = oracle_;
        emit OracleUpdated(address(oracle_));
    }

    /// @notice What a call on this chain costs RIGHT NOW, in VOID.
    /// @dev    The owner sets it in dollars; this is what the payer will actually
    ///         hand over at the current rate. It is the number the wallet should
    ///         show.
    function feeInVoid(uint256 tokenId) public view returns (uint256) {
        uint256 usd = apps[tokenId].feePerCallUsd;
        if (usd == 0) return 0;
        return oracle.usdToVoid(usd);
    }

    /// @notice Publishes an application on a chain. Open to anyone.
    ///
    /// @dev    It is the equivalent of deploying a contract on a real chain: the
    ///         contract itself was already deployed on the parent chain, and the
    ///         registration says which chain it answers to.
    ///
    ///         ANYONE PUBLISHES, and it is essential that it works that way. A
    ///         first version of this required being the chain owner — which would
    ///         have made the owner a gatekeeper able to decide who builds on
    ///         their network. A network like that attracts no developers, and
    ///         without developers there is no use, and without use the chain is
    ///         worth nothing even to the owner.
    ///
    ///         The owner earns from the activity, not from controlling the door.
    function registerApp(uint256 tokenId, address app) external {
        ChainApp storage chain = apps[tokenId];
        if (!chain.active) revert NotActive(tokenId);
        if (app == address(0)) revert ZeroAddress();

        // On a closed chain, the controller publishes. Once the DAO-control
        // switch is on, that means a passed proposal, never the deed holder
        // acting on their own.
        if (!chain.permissionlessDeploy && !_isChainController(tokenId, msg.sender)) {
            revert DeploymentClosed(tokenId, msg.sender);
        }

        // THE TARGET IS VERIFIED, not accepted in good faith.
        //
        // Without this, anyone would publish the VOID token's contract as an
        // "application" of their own chain and call `transfer` through the
        // runtime — which signs with the balance of EVERY chain. The runtime is a
        // rich address; letting it call arbitrary contracts is handing that
        // balance to whoever asks.
        //
        // The application has to declare which chain and which runtime it belongs
        // to, and the two declarations have to match. A contract that does not
        // answer these questions simply is not a chain application.
        try IChainApp(app).chainId() returns (uint256 declared) {
            if (declared != tokenId) revert AppBelongsElsewhere(app, declared, tokenId);
        } catch {
            revert NotAChainApp(app);
        }

        try IChainApp(app).runtime() returns (address declaredRuntime) {
            if (declaredRuntime != address(this)) revert AppOfAnotherRuntime(app, declaredRuntime);
        } catch {
            revert NotAChainApp(app);
        }

        belongsTo[tokenId][app] = true;
        publisherOf[tokenId][app] = msg.sender;
        emit AppRegistered(tokenId, app, msg.sender);
    }

    /// @notice Withdraws one's own application from circulation.
    ///
    /// @dev    ONLY THE PUBLISHER can withdraw it — not even the chain owner
    ///         touches someone else's app. It is the same limit that already
    ///         holds on real chains: the holder rules the network's economy,
    ///         never what third parties built on top of it. If they could erase
    ///         other people's apps, buying the NFT would grant the power to
    ///         destroy the work of whoever trusted the chain, and nobody would
    ///         risk building there.
    function unregisterApp(uint256 tokenId, address app) external {
        if (publisherOf[tokenId][app] != msg.sender) {
            revert NotThePublisher(tokenId, app, msg.sender);
        }
        belongsTo[tokenId][app] = false;
        emit AppUnregistered(tokenId, app);
    }

    /// @notice Opens or closes application publishing on this chain.
    /// @dev    Closing does not affect what was already published — whoever
    ///         already built stays up. Closing prevents new publications, it does
    ///         not confiscate old ones.
    function setPermissionlessDeploy(uint256 tokenId, bool open)
        external
        onlyChainController(tokenId)
    {
        apps[tokenId].permissionlessDeploy = open;
        emit DeploymentPolicyChanged(tokenId, open);
    }

    // ---------------------------------------------------------------------
    // Using the chain
    // ---------------------------------------------------------------------

    /// @notice Runs an action inside a chainapp, paying its toll.
    ///
    /// @dev    The toll is charged BEFORE the call. If it came after, a hostile
    ///         app could burn all the gas and leave without paying — and the
    ///         chain would have worked for free.
    ///
    ///         `executingChain` and `executingCaller` are written and cleared
    ///         around the call. Clearing is not hygiene: it is what stops a
    ///         contract called later, outside any execution, from passing itself
    ///         off as an app acting on someone's behalf.
    /// @param  maxFee The most the caller accepts paying as a toll.
    ///
    /// @dev    WITHOUT THIS, THE CHAIN OWNER CHARGES WHATEVER THEY LIKE TO
    ///         SOMEONE WHO ALREADY SIGNED.
    ///
    ///         The argument that "the user sees the price before signing" is
    ///         false: between signing and executing there is the queue, and the
    ///         owner can act inside it — see the transaction coming, raise the
    ///         toll to the ceiling, and charge a hundred VOID to someone who
    ///         expected to pay a hundredth.
    ///
    ///         The defense is not a delay, it is the payer declaring their limit,
    ///         exactly as a DEX swap declares the slippage it tolerates.
    function execute(uint256 tokenId, address target, bytes calldata data, uint256 maxFee)
        external
        nonReentrant
        returns (bytes memory result)
    {
        return _execute(tokenId, msg.sender, target, data, maxFee);
    }

    /// @notice The same `execute`, but acting for someone who has no ETH.
    ///
    /// @dev    THIS IS THE BUBBLE'S PATH. A user holding only VOID cannot send
    ///         any transaction — gas on the parent chain is paid in ETH, and no
    ///         contract can change that. So they do not send: they sign an
    ///         authorization, and the paymaster sends for them, fronting the ETH
    ///         and charging the equivalent in VOID.
    ///
    ///         WHOEVER PAYS THE TOLL IS STILL `msg.sender` (the paymaster, which
    ///         already collected from the user). The only thing that changes is
    ///         `executingCaller`: apps need to see the real user, not the
    ///         paymaster. Without that separation, a DEX swap would credit the
    ///         paymaster — the money would go to the postman.
    ///
    ///         THE TRUST HERE IS TOTAL AND THAT IS WHY IT IS UNIQUE: the
    ///         forwarder declares who the user is and this contract believes it.
    ///         What validates the signature is the paymaster, not the runtime.
    ///         That is why the address is written once and freezes.
    function executeFor(
        address user,
        uint256 tokenId,
        address target,
        bytes calldata data,
        uint256 maxFee
    ) external nonReentrant returns (bytes memory result) {
        if (msg.sender != forwarder) revert NotTheForwarder(msg.sender);
        if (user == address(0)) revert ZeroAddress();
        return _execute(tokenId, user, target, data, maxFee);
    }

    /// @notice `execute` opening a budget, for those paying their own gas.
    /// @dev    The direct path needs the same door as the sponsored one: an
    ///         application that uses `spendFrom` would not work here without a
    ///         budget. The caller declares their own ceiling — it is the owner of
    ///         the money deciding, just like on the signed path.
    function executeWithBudget(
        uint256 tokenId,
        address target,
        bytes calldata data,
        uint256 maxFee,
        SpendAuth calldata auth
    ) external nonReentrant returns (bytes memory result) {
        _openAuth(auth);
        return _execute(tokenId, msg.sender, target, data, maxFee);
    }


    /// @notice An application moves an NFT from the current user, if they
    ///         authorized THIS one.
    ///
    /// @dev    The same three conditions as `spendFrom`, with the third one
    ///         narrower: it is not enough for the collection to have a budget,
    ///         the `tokenId` has to be exactly the one the user signed.
    function spendNftFrom(address collection, address to, uint256 tokenId) external {
        uint256 chain = executingChain;
        if (chain == 0) revert NoExecutionInProgress();
        if (!belongsTo[chain][msg.sender]) revert NotThisChainsApp(chain, msg.sender);
        if (!nftBudget[collection][tokenId]) revert NftNotAuthorized(collection, tokenId);

        nftBudget[collection][tokenId] = false;
        IERC721Minimal(collection).transferFrom(executingCaller, to, tokenId);
        emit NftSpent(chain, executingCaller, collection, msg.sender, to, tokenId);
    }

    function _openAuth(SpendAuth calldata auth) private {
        if (auth.tokens.length != auth.limits.length) revert BudgetLengthMismatch();
        if (auth.collections.length != auth.nftIds.length) revert BudgetLengthMismatch();
        if (auth.tokens.length > MAX_BUDGETED_TOKENS || auth.collections.length > MAX_BUDGETED_TOKENS) {
            revert TooManyBudgetedTokens(auth.tokens.length + auth.collections.length, MAX_BUDGETED_TOKENS);
        }

        for (uint256 i; i < auth.tokens.length; ++i) {
            if (auth.tokens[i] == address(0)) revert ZeroAddress();
            spendBudget[auth.tokens[i]] = auth.limits[i];
            budgetedTokens.push(auth.tokens[i]);
        }
        for (uint256 i; i < auth.collections.length; ++i) {
            if (auth.collections[i] == address(0)) revert ZeroAddress();
            nftBudget[auth.collections[i]][auth.nftIds[i]] = true;
            budgetedCollections.push(auth.collections[i]);
            budgetedNftIds.push(auth.nftIds[i]);
        }
    }

    /// @notice The same, opening a spending budget for the applications.
    /// @param  auth What this call authorizes the applications to move.
    /// @dev    The limits come from the request the USER signed — the forwarder
    ///         only carries them. Who decides how much may be spent is always the
    ///         owner of the money, and only for the call they authorized.
    function executeForWithBudget(
        address user,
        uint256 tokenId,
        address target,
        bytes calldata data,
        uint256 maxFee,
        SpendAuth calldata auth
    ) external nonReentrant returns (bytes memory result) {
        if (msg.sender != forwarder) revert NotTheForwarder(msg.sender);
        if (user == address(0)) revert ZeroAddress();
        _openAuth(auth);
        return _execute(tokenId, user, target, data, maxFee);
    }

    /// @notice An application spends, from the current user, within what they
    ///         authorized.
    ///
    /// @dev    THREE CONDITIONS, AND NONE IS OPTIONAL.
    ///
    ///         There has to be an execution under way; the caller has to be an
    ///         application REGISTERED on the executing chain; and the amount has
    ///         to fit in the budget the user signed.
    ///
    ///         Without the second, any contract in the world would spend the
    ///         balance of whoever happened to be passing through. Without the
    ///         third, the chain's app would spend everything the user had
    ///         authorized to the runtime — which is exactly what an unlimited
    ///         `approve` does today, and what this mechanism exists not to
    ///         repeat.
    function spendFrom(address token, address to, uint256 amount) external {
        uint256 chain = executingChain;
        if (chain == 0) revert NoExecutionInProgress();
        if (!belongsTo[chain][msg.sender]) revert NotThisChainsApp(chain, msg.sender);

        uint256 budget = spendBudget[token];
        if (amount > budget) revert BudgetExceeded(token, amount, budget);
        spendBudget[token] = budget - amount;

        if (!IERC20(token).transferFrom(executingCaller, to, amount)) {
            revert CallFailed("spend refused by the token");
        }
        emit Spent(chain, executingCaller, token, msg.sender, to, amount);
    }

    function _execute(
        uint256 tokenId,
        address caller,
        address target,
        bytes calldata data,
        uint256 maxFee
    ) private returns (bytes memory result) {
        ChainApp storage app = apps[tokenId];
        if (!app.active) revert NotActive(tokenId);
        if (!belongsTo[tokenId][target]) revert NotThisChainsApp(tokenId, target);

        // An execution inside another would confuse whose turn it is; the
        // nonReentrant guard already blocks it, but the explicit check documents
        // why.
        if (executingChain != 0) revert Reentered();

        // THE CONVERSION HAPPENS HERE, at call time. The owner fixed it in
        // dollars; the payer hands over the equivalent in VOID at the current
        // rate.
        uint256 fee = app.feePerCallUsd == 0 ? 0 : oracle.usdToVoid(app.feePerCallUsd);
        if (fee > maxFee) revert TollAboveLimit(fee, maxFee);
        if (fee > 0) {
            if (!voidToken.transferFrom(msg.sender, address(this), fee)) {
                revert CallFailed("toll not paid");
            }

            // THE PROTOCOL'S 2% IS SPLIT OFF HERE, AT THE MOMENT OF THE
            // TRANSACTION.
            //
            // The toll arrives already divided: the protocol's share goes to
            // `protocolAccrued`, and only the owner's share (98%) enters their
            // `pending`. That way the 2% never appears in the owner's balance nor
            // is claimable by them — it is the protocol's profit system,
            // automatic on every use. The 1-wei floor closes the dust: any toll
            // > 0 pays the protocol.
            uint256 protocolCut = (fee * PROTOCOL_BPS) / BPS;
            if (protocolCut == 0) protocolCut = 1;
            uint256 ownerCut = fee - protocolCut;
            protocolAccrued += protocolCut;

            // If the deed changed hands and there is revenue pending for the
            // previous owner, it is parked NOW, for them — before the new toll
            // adds to a pending that would start being credited to the new owner.
            // It is what stops the buyer from taking what the seller generated.
            address currentOwner = deed.ownerOf(tokenId);
            if (app.pending > 0 && app.pendingOwner != currentOwner) {
                _parkPending(tokenId);
            }

            app.pending += ownerCut;
            app.pendingOwner = currentOwner;
            app.lifetimeRevenue += fee; // gross, for the metric
        }
        app.callCount += 1;

        executingChain = tokenId;
        executingCaller = caller;

        (bool ok, bytes memory returned) = target.call(data);

        executingChain = 0;
        executingCaller = address(0);

        // The budget dies with the call. A surviving leftover would be a
        // permission the next caller inherits without ever having signed
        // anything.
        uint256 n = budgetedTokens.length;
        for (uint256 i; i < n; ++i) delete spendBudget[budgetedTokens[i]];
        if (n > 0) delete budgetedTokens;

        uint256 m = budgetedCollections.length;
        for (uint256 i; i < m; ++i) {
            delete nftBudget[budgetedCollections[i]][budgetedNftIds[i]];
        }
        if (m > 0) { delete budgetedCollections; delete budgetedNftIds; }

        if (!ok) revert CallFailed(returned);

        emit Executed(tokenId, caller, target, fee);
        return returned;
    }

    // ---------------------------------------------------------------------
    // The revenue
    // ---------------------------------------------------------------------

    /// @notice Settles to the protocol's treasury what the chainapp collected.
    ///
    /// @dev    Open to anyone, like the `sweep` on real chains: the destination
    ///         is fixed and so is the `tokenId`, so the caller chooses nothing —
    ///         they only pay the gas for a transfer already decided.
    ///
    ///         And note what is NOT here: no bridge, no dispute period, no
    ///         seven-day wait. A chainapp's revenue is born on the parent chain,
    ///         where the treasury lives. It is the least obvious advantage of
    ///         this model, and perhaps the biggest for whoever lives off the
    ///         income.
    function flush(uint256 tokenId) external nonReentrant returns (uint256 amount) {
        if (apps[tokenId].pending == 0) revert NothingToFlush();
        amount = _settlePending(tokenId);
    }

    /// @notice Takes the protocol's accrued 2% to the treasury. Open to anyone.
    ///
    /// @dev    The destination is fixed (the treasury's `protocolTreasury`), so
    ///         the caller chooses nothing — they only pay the gas for a transfer
    ///         already decided, just like `flush`. This is the tap of the
    ///         protocol's profit: the 2% was split off on every transaction into
    ///         `protocolAccrued`, and here it is sent to that public recipient.
    ///         The chain owners never touch that value at any point along the way.
    function sweepProtocol() external nonReentrant returns (uint256 amount) {
        amount = protocolAccrued;
        if (amount == 0) revert NothingToFlush();
        protocolAccrued = 0;

        address sink = treasury.protocolTreasury();
        voidToken.approve(address(treasury), amount);
        treasury.creditTo(sink, amount);

        emit ProtocolSwept(sink, amount);
    }

    /// @notice Parks the previous owner's revenue without going to the treasury.
    ///
    /// @dev    THIS USED TO BE A FULL SETTLEMENT, INSIDE SOMEBODY ELSE'S CALL.
    ///         When the deed changed hands, the chain's next call bore an
    ///         `approve` plus a `creditTo` plus a `transferFrom` — and on the
    ///         sponsored path that bill landed on whichever user happened to be
    ///         passing through. Measured: 33% more on that same call, and the one
    ///         choosing the moment was the chain owner, transferring the deed
    ///         whenever they liked.
    ///
    ///         Now the handover costs two writes: the value sits parked in the
    ///         name of whoever generated it, and the trip to the treasury happens
    ///         when that person calls `claimOwed` themselves. The guarantee does
    ///         not change — the revenue still belongs to whoever generated it, and
    ///         the deed's buyer still cannot reach it.
    function _parkPending(uint256 tokenId) private {
        ChainApp storage app = apps[tokenId];
        uint256 amount = app.pending;
        address beneficiary = app.pendingOwner;

        // `pendingOwner` is deliberately NOT cleared here: the caller overwrites
        // both fields on the next line, and one extra write at this point is gas
        // charged to somebody who was only passing through.
        app.pending = 0;
        owed[beneficiary] += amount;

        emit RevenueParked(tokenId, beneficiary, amount);
    }

    /// @notice Takes to the treasury the revenue parked in your name.
    /// @dev    Anyone may pay the gas, but the destination is always the owner of
    ///         the value — the caller does not choose where it goes.
    function claimOwed(address beneficiary) external nonReentrant returns (uint256 amount) {
        amount = owed[beneficiary];
        if (amount == 0) revert NothingToFlush();
        owed[beneficiary] = 0;

        voidToken.approve(address(treasury), amount);
        treasury.creditTo(beneficiary, amount);

        emit OwedClaimed(beneficiary, amount);
    }

    /// @dev Settles a chain's `pending` (already net, 98%) to the treasury,
    ///      crediting WHOEVER GENERATED IT (`pendingOwner`), not whoever holds the
    ///      deed now. Used by `flush`.
    ///
    ///      Uses `creditTo` (a pure credit, without splitting again), because the
    ///      2% was already separated in `execute`. Clears the state BEFORE the
    ///      external call — checks-effects-interactions.
    function _settlePending(uint256 tokenId) internal returns (uint256 amount) {
        ChainApp storage app = apps[tokenId];
        amount = app.pending;
        address beneficiary = app.pendingOwner;

        app.pending = 0;
        app.pendingOwner = address(0);

        voidToken.approve(address(treasury), amount);
        treasury.creditTo(beneficiary, amount);

        emit RevenueFlushed(tokenId, amount);
    }

    // ---------------------------------------------------------------------
    // Reading
    // ---------------------------------------------------------------------

    /// @notice What a call on this chain costs, IN VOID, at the current rate.
    /// @dev    It is the number whoever is about to sign needs to see. The owner
    ///         fixes it in dollars; this is the conversion. See also `feeInVoid`,
    ///         which is the same — this name stays for compatibility with
    ///         anything already reading `feeOf`.
    function feeOf(uint256 tokenId) external view returns (uint256) {
        return feeInVoid(tokenId);
    }

    /// @notice The toll as the owner set it: in dollars, with 18 decimals.
    function feeUsdOf(uint256 tokenId) external view returns (uint256) {
        return apps[tokenId].feePerCallUsd;
    }

    function statsOf(uint256 tokenId)
        external
        view
        returns (bool active, uint256 fee, uint256 pending, uint256 lifetime, uint256 calls)
    {
        ChainApp memory a = apps[tokenId];
        return (a.active, a.feePerCallUsd, a.pending, a.lifetimeRevenue, a.callCount);
    }
}
