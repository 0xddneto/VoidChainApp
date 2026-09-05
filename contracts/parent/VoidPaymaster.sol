// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
    function allowance(address owner, address spender) external view returns (uint256);
}

/// @notice Permission by signature (EIP-2612).
/// @dev    The mainnet VOID token MUST implement this. See the comment on
///         `sponsorWithPermit` for why: without `permit`, the bubble does not close.
interface IERC20Permit {
    function permit(
        address owner,
        address spender,
        uint256 value,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external;
}

/// @notice ArbOS's gas precompile.
/// @dev    `getCurrentTxL1GasFees` returns, in wei, what THIS transaction costs
///         to post to L1 — already including the brotli compression ArbOS applies.
interface IArbGasInfo {
    function getCurrentTxL1GasFees() external view returns (uint256);
}

interface IVoidPriceOracle {
    function voidPerEth() external view returns (uint256);
    function voidUsd() external view returns (uint256);
    function usdToVoid(uint256 usdAmount) external view returns (uint256);
}

/// @notice Uniswap V3's router, present on Robinhood Chain since day one.
interface ISwapRouter {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }
    function exactInputSingle(ExactInputSingleParams calldata params)
        external
        payable
        returns (uint256 amountOut);
}

interface IWETH {
    function withdraw(uint256 amount) external;
}

interface IVoidProtocolToken {
    function protocolTransferFrom(address from, address to, uint256 amount) external returns (bool);
    function isProtocolOperator(address account) external view returns (bool);
}

/// @notice The permanently locked VOID/ETH pool used by the V6 genesis.
/// @dev Kept deliberately smaller than a general DEX interface: the Paymaster
/// can only sell VOID into ETH and ETH is always returned to this contract.
interface IVoidEthExitPool {
    function swapVoidForEth(uint256 voidIn, uint256 minEthOut)
        external
        returns (uint256 ethOut);
}

interface IVoidChainAppRuntime {
    function feeOf(uint256 tokenId) external view returns (uint256);

    function executeFor(
        address user,
        uint256 tokenId,
        address target,
        bytes calldata data,
        uint256 maxFee
    ) external returns (bytes memory);

    struct SpendAuth {
        address[] tokens;
        uint256[] limits;
        address[] collections;
        uint256[] nftIds;
    }

    function executeForWithBudget(
        address user,
        uint256 tokenId,
        address target,
        bytes calldata data,
        uint256 maxFee,
        SpendAuth calldata auth
    ) external returns (bytes memory);

}

/// @title VoidPaymaster
/// @notice The bubble: someone holding only VOID transacts as if VOID were gas.
///
/// @dev    WHAT THIS SOLVES.
///
///         A chainapp runs on the parent chain's EVM, and there gas is paid in
///         ETH. No contract changes that: gas accounting happens in the node,
///         before and during execution, out of reach of any code we write. So a
///         user holding only VOID simply cannot send any transaction at all.
///
///         The way out is not to make VOID become gas — it is to make the user
///         not need to send the transaction. They sign an authorization; a
///         relayer sends it for them and fronts the ETH; this contract
///         reimburses the relayer in ETH and charges the user the equivalent in
///         VOID, in the same transaction.
///
///         From the user's side the bubble is real: only VOID goes in, only VOID
///         comes out, ETH never appears. From the inside, the conversion is
///         explicit and has an owner.
///
///         THE ECONOMICS, AND WHY THEY ARE SPLIT IN TWO.
///
///         The VOID charged for gas is NOT profit. It exists to replace the ETH
///         that left the reserve, and replacing it requires SELLING that VOID on
///         the market. Selling is sell pressure — unavoidable, it is the real
///         cost of the service.
///
///         The profit is the MARGIN charged above cost. That slice came from a
///         real purchase on the market (the user had to acquire VOID) and never
///         has to go back there. Only it is genuinely burnable.
///
///         That is why the take is split into two accounts from the first
///         instant, and not at the end of the month:
///
///           reimbursableVoid — has to become ETH again. Selling is mandatory.
///           surplusVoid      — margin. Burnable with nothing owed.
///
///         Mixing the two is the mistake that turns "burning" into a drain:
///         selling VOID to fund a burn of the same size applies real sell
///         pressure in exchange for a supply reduction that does not affect the
///         float. Double cost, zero benefit. The separation here exists to make
///         that mistake impossible to commit by inattention.
///
///         SOLVENCY COMES BEFORE BURNING, ALWAYS.
///
///         If the ETH reserve dries up, nobody transacts on any chainapp — the
///         whole system stops. Burning may only consume surplus above the floor.
///         It is not a preference, it is an order of precedence.
contract VoidPaymaster is ReentrancyGuard, EIP712 {
    IERC20 public immutable voidToken;
    IVoidChainAppRuntime public immutable runtime;

    /// @dev    An address with no known private key. The VOID token is external
    ///         and does not expose `burn`, so burning is done by an irreversible
    ///         send. `totalSupply` does not change; the reachable supply does —
    ///         and that is what the market prices.
    address public constant BURN_ADDRESS = 0x000000000000000000000000000000000000dEaD;

    uint256 public constant BPS = 10_000;

    /// @dev    Ceiling on what governance may declare as the fixed cost per
    ///         sponsorship. Without the ceiling, an absurd `gasOverhead` would
    ///         become a hidden fee charged to every user.
    uint256 public constant MAX_GAS_OVERHEAD = 200_000;

    /// @dev    Ceiling on the margin. Governance tunes the profit, but cannot
    ///         turn sponsorship into confiscation from those holding only VOID.
    uint256 public constant MAX_MARGIN_BPS = 3_000;

    /// @dev A refill uses the oracle's 30-minute price. This is the maximum
    ///      difference accepted from that reference, including pool fee and
    ///      execution slippage. Governance cannot turn a public refill into a
    ///      discounted sale of the replacement account.
    uint256 public constant MAX_REFILL_SLIPPAGE_BPS = 500;

    bytes32 public constant SPONSORED_CALL_TYPEHASH = keccak256(
        "SponsoredCall(address user,uint256 tokenId,address target,bytes data,uint256 maxToll,uint256 maxGasVoid,uint256 callGasLimit,Spend[] spends,SpendNft[] nftSpends,uint256 nonce,uint256 deadline)Spend(address token,uint256 amount)SpendNft(address collection,uint256 tokenId)"
    );

    bytes32 public constant SPEND_TYPEHASH = keccak256("Spend(address token,uint256 amount)");
    bytes32 public constant SPEND_NFT_TYPEHASH =
        keccak256("SpendNft(address collection,uint256 tokenId)");

    /// @dev ArbOS's gas precompile, where the real L1 cost lives.
    ///
    ///      THE FIRST VERSION OF THIS WAS WRONG, and the mistake is instructive:
    ///      it charged `data.length * 16`, which is Ethereum's rule (EIP-2028).
    ///      Arbitrum does not charge that way. There the cost of posting to L1
    ///      comes from compressing the transaction's data with brotli and
    ///      multiplying the result by ArbOS's current calldata price — a number
    ///      that depends on how compressible the data is, not on its raw size.
    ///
    ///      Counting 16 per byte therefore overcharged repetitive calldata (which
    ///      compresses well) and undercharged dense calldata. Here we ask ArbOS
    ///      itself instead of estimating.
    address public constant ARB_GAS_INFO = 0x000000000000000000000000000000000000006C;

    /// @dev Headroom reserved for the settlement after execution. Guarantees
    ///      there is gas left to charge, reimburse and return the change.
    uint256 public constant FINALIZATION_GAS = 80_000;

    /// @dev How much `voidPerEth` may move at once: at most double or halve.
    ///      Without a step limit the margin ceiling was decorative — multiplying
    ///      the rate by a hundred, at zero margin, was enough to multiply
    ///      everyone's bill by a hundred.
    uint256 public constant MAX_RATE_STEP_BPS = 20_000;

    /// @dev There are only two valid EIP-2612 spenders in a sponsored VOID
    ///      call: this contract collects the network fee and gas, and the
    ///      runtime releases the per-call app budget. Accepting a third party
    ///      here would turn this convenience function into a generic permit
    ///      delivery service and make the signing screen needlessly dangerous.
    uint256 public constant MAX_PERMITS_PER_CALL = 2;

    /// @dev One permit pays the Paymaster in VOID; at most eight further
    ///      permits open the Runtime's bounded per-call token budgets.
    uint256 public constant MAX_ASSET_PERMITS_PER_CALL = 9;

    struct SponsoredCall {
        address user;
        uint256 tokenId;
        address target;
        bytes data;
        /// @notice Ceiling on the chain's toll the user accepts paying.
        uint256 maxToll;
        /// @notice Ceiling on what they accept paying for gas, in VOID.
        /// @dev    The equivalent of `maxFeePerGas` on an ordinary transaction.
        ///         Without it, the relayer would pick both `tx.gasprice` and the
        ///         user's bill — they would be signing a blank cheque to the
        ///         postman.
        uint256 maxGasVoid;
        /// @notice Gas ceiling for the inner call.
        ///
        /// @dev    It is what makes the cost PREDICTABLE before executing.
        ///         Without a limit, the call could consume as much as it liked
        ///         and only at the end would anyone discover the user's ceiling
        ///         did not cover it — after the relayer had already paid the
        ///         bill. With the limit, the worst case is computable during
        ///         validation, and the relayer decides whether to accept.
        uint256 callGasLimit;
        /// @notice How much of each token the applications may spend IN THIS call.
        ///
        /// @dev    It is the permission that closes the hole at the front door.
        ///         Before, every application that moved the user's tokens
        ///         required an `approve` from them — a transaction someone
        ///         without ETH cannot send, which therefore punctured the bubble
        ///         at each new app.
        ///
        ///         Now the user authorizes the RUNTIME once, by signature, and
        ///         declares the ceiling of each call here. What they sign applies
        ///         to this call and dies with it — narrower than the permanent,
        ///         unlimited `approve` they would have granted before.
        Spend[] spends;
        /// @notice The specific NFTs this call may move.
        /// @dev    By `tokenId`, never by quantity — an NFT's value lies in not
        ///         being fungible. Letting the app choose which one would mean
        ///         authorizing the most expensive one by accident.
        SpendNft[] nftSpends;
        uint256 nonce;
        uint256 deadline;
    }

    struct Spend {
        address token;
        uint256 amount;
    }

    struct SpendNft {
        address collection;
        uint256 tokenId;
    }

    /// @notice A signed spending permission, in EIP-2612's format.
    /// @dev    `spender` is a field because the system has TWO spenders: the
    ///         paymaster, which charges toll and gas, and the runtime, through
    ///         which applications pull. Two signatures, no transactions.
    struct Permit {
        address spender;
        uint256 value;
        uint256 deadline;
        uint8 v;
        bytes32 r;
        bytes32 s;
    }

    /// @notice ERC-2612 permission for an explicit app asset.
    /// @dev The token is part of the permission so an asset signature can never
    ///      be interpreted as a VOID permission.
    struct AssetPermit {
        address token;
        address spender;
        uint256 value;
        uint256 deadline;
        uint8 v;
        bytes32 r;
        bytes32 s;
    }

    address public governor;

    /// @notice The oracle that prices VOID in ETH and in dollars.
    ///
    /// @dev    THIS USED TO BE A HAND-TYPED NUMBER, and the error that produces
    ///         was measured: with `voidPerEth = 10,000` and ETH at $2,411, the
    ///         paymaster valued 1 ETH at ten dollars — wrong by a factor of 241.
    ///         Every transaction drained 241x more ETH than the VOID collected
    ///         replaced.
    ///
    ///         A parameter that has to track the price of two assets will end up
    ///         wrong; the only question is when. Now it is a read.
    ///
    ///         Replaceable by governance on purpose: oracles break, feeds get
    ///         discontinued, pools migrate. An immutable oracle would be a
    ///         permanent point of failure. The price of that is that governance
    ///         can point at a lying oracle — a noted risk, and the reason the
    ///         wallet has to become a multisig before real value goes in.
    IVoidPriceOracle public oracle;

    /// @notice Router and WETH so `refill` can convert VOID into ETH on its own.
    ISwapRouter public swapRouter;
    address public weth;
    uint24 public poolFee;

    /// @notice The immutable-liquidity V6 VOID/ETH exit used for reserve refills.
    /// @dev Once pinned, refills prefer this route over a mutable external router.
    /// The route can be written only once: governance cannot silently redirect
    /// the replacement account after the genesis terms were published.
    IVoidEthExitPool public voidEthPool;

    /// @notice The public keeper acts only below this ETH balance and aims for
    ///         `refillTarget`. Zero disables automatic refills until governance
    ///         has installed both a real route and an explicit reserve policy.
    uint256 public refillThreshold;
    uint256 public refillTarget;
    uint256 public refillSlippageBps;

    function voidPerEth() public view returns (uint256) {
        return oracle.voidPerEth();
    }

    /// @notice The margin over cost, in basis points. It is the paymaster's profit.
    uint256 public marginBps;

    /// @notice Floor of the ETH reserve. Below it, nothing is burned.
    uint256 public ethFloor;

    /// @notice Estimated fixed cost outside the measured window (calldata, final
    ///         transfers, sending the ETH).
    uint256 public gasOverhead;

    /// @notice Ceiling on ETH the reserve pays per block. Zero disables the limit.
    uint256 public maxEthPerBlock;
    uint256 private blockOfLastSpend;
    uint256 private spentThisBlock;
    uint256 public dailyChainEthLimit;
    mapping(uint256 tokenId => mapping(uint256 epoch => uint256 spent)) public chainEpochEthSpent;

    /// @notice Ceiling on the accepted `tx.gasprice`.
    /// @dev    Without it, a hostile relayer sends at an enormous gas price and
    ///         drains the reserve in a handful of transactions — the
    ///         reimbursement is proportional to what they declared spending.
    uint256 public maxGasPrice;

    /// @notice Where the share of the surplus that is not burned goes.
    address public runwayTreasury;

    /// @notice Collected VOID that HAS to become ETH again. It is not profit.
    uint256 public reimbursableVoid;

    /// @notice Accrued margin. This one is genuinely burnable.
    uint256 public surplusVoid;

    mapping(address user => uint256) public nonces;

    event Sponsored(
        address indexed user,
        address indexed relayer,
        uint256 indexed tokenId,
        uint256 toll,
        uint256 gasVoid,
        uint256 marginVoid,
        uint256 ethReimbursed
    );
    event VoidEthPoolSet(address indexed pool);
    /// @notice The inner call failed, but gas was charged all the same.
    /// @dev    The reason goes in the event instead of taking the transaction
    ///         down: whoever signed needs to be able to see what happened, and
    ///         the relayer needs to be paid for the work they did.
    event ExecutionFailed(
        address indexed user, uint256 indexed tokenId, address target, bytes reason
    );
    event ReserveFunded(address from, uint256 amount);
    event ReimbursableWithdrawn(address to, uint256 amount);
    event EthWithdrawn(address to, uint256 amount);
    event SurplusBurned(uint256 burned, uint256 toRunway);
    event RateUpdated(uint256 voidPerEth, uint256 marginBps);
    event OracleUpdated(address oracle);
    event SwapRouteUpdated(address router, address weth, uint24 poolFee);
    event Refilled(uint256 voidSold, uint256 ethReceived);
    event RefillPolicyUpdated(uint256 threshold, uint256 target, uint256 slippageBps);
    event LimitsUpdated(uint256 ethFloor, uint256 gasOverhead, uint256 maxGasPrice);
    event GovernorTransferred(address previous, address next);
    event RunwayTreasuryUpdated(address previous, address next);
    event DailyChainLimitUpdated(uint256 limit);

    error NotGovernor(address who);
    error ZeroAddress();
    error Expired(uint256 deadline);
    error BadNonce(uint256 given, uint256 expected);
    error BadSignature();
    error GasAboveLimit(uint256 charge, uint256 limit);
    error GasPriceAboveLimit(uint256 price, uint256 limit);
    error ReserveTooLow(uint256 balance, uint256 needed);
    error RateNotSet();
    error MarginTooHigh(uint256 given, uint256 max);
    error OverheadTooHigh(uint256 given, uint256 max);
    error NothingToBurn();
    error PolicyOverspend(uint256 requested, uint256 available);
    error TransferFailed();
    error ReimbursementFailed();
    error AmountAboveBalance(uint256 requested, uint256 available);
    error PermitDidNotStick(address user);
    error RateTooLowToCharge(uint256 ethSpent, uint256 rate);
    error NothingUnaccounted();
    error NotEnoughGasForCall(uint256 available, uint256 needed);
    error BlockBudgetExceeded(uint256 wanted, uint256 budget);
    error RateStepTooLarge(uint256 given, uint256 min, uint256 max);
    error SwapRouteNotSet();
    error VoidEthPoolAlreadySet(address pool);
    error BadRefillPolicy(uint256 threshold, uint256 target, uint256 slippageBps);
    error RefillNotNeeded(uint256 reserve, uint256 threshold, uint256 reimbursable);
    error RefillAbovePlan(uint256 given, uint256 maximum);
    error RefillMinOutTooLow(uint256 given, uint256 minimum);
    error UnexpectedPermitSpender(address spender);
    error DuplicatePermitSpender(address spender);
    error TooManyPermits(uint256 given, uint256 max);
    error AllowanceTooLow(address user, address spender, uint256 available, uint256 needed);
    error UnexpectedAssetPermit(address token, address spender);
    error DuplicateAssetPermit(address token, address spender);
    error TollChanged(uint256 signed, uint256 current);
    error ChainDailyLimitNotSet();
    error ChainDailyBudgetExceeded(uint256 tokenId, uint256 wanted, uint256 limit);

    constructor(
        IERC20 voidToken_,
        IVoidChainAppRuntime runtime_,
        address governor_,
        address runwayTreasury_,
        IVoidPriceOracle oracle_
    ) EIP712("VoidPaymaster", "1") {
        if (
            address(voidToken_) == address(0) || address(runtime_) == address(0)
                || governor_ == address(0) || runwayTreasury_ == address(0)
                || address(oracle_) == address(0)
        ) revert ZeroAddress();
        voidToken = voidToken_;
        runtime = runtime_;
        governor = governor_;
        runwayTreasury = runwayTreasury_;
        oracle = oracle_;

        // Conservative defaults. Governance calibrates before first use; with no
        // `voidPerEth` set, `sponsor` refuses instead of charging zero.
        marginBps = 1_000; // 10%
        gasOverhead = 60_000;
        maxGasPrice = 10 gwei;
        // A usable launch default: still bounds one compromised ChainApp to a
        // finite 24-hour loss, while allowing the published 1,024-call load
        // profile. Governance must calibrate this against the funded reserve
        // before production; setting zero fails closed.
        dailyChainEthLimit = 2 ether;
    }

    modifier onlyGovernor() {
        if (msg.sender != governor) revert NotGovernor(msg.sender);
        _;
    }

    // ---------------------------------------------------------------------
    // The bubble
    // ---------------------------------------------------------------------

    /// @notice Executes for a user who has no ETH, charging them in VOID.
    ///
    /// @dev    Open to any relayer, on purpose: a sponsorship that depends on a
    ///         list of authorized relayers is a single point of failure — if our
    ///         relayer goes down, the whole bubble stops. What protects both
    ///         sides is not a list, it is the ceilings: the user declares how
    ///         much they accept paying (`maxGasVoid`, `maxToll`) and the contract
    ///         declares the maximum gas price it reimburses (`maxGasPrice`).
    ///
    ///         THE ORDER OF OPERATIONS MATTERS. The toll is collected and paid
    ///         before execution; gas can only be measured afterwards. That is why
    ///         charging happens in two stages rather than one.
    /// @return executed Whether the inner call succeeded. FALSE IS NOT AN ERROR:
    ///         the sponsorship happened, gas was charged and the nonce was spent
    ///         — like a transaction that reverts and still costs gas.
    /// @return result The inner call's return value, empty if it failed.
    function sponsor(SponsoredCall calldata req, bytes calldata signature)
        external
        nonReentrant
        returns (bool executed, bytes memory result)
    {
        return _sponsor(gasleft(), req, signature);
    }

    /// @notice The same sponsorship, opening the VOID permission by signature.
    ///
    /// @dev    WITHOUT THIS THE BUBBLE DOES NOT CLOSE, and the hole is easy to
    ///         miss: sponsoring the execution is not enough, because
    ///         `transferFrom` requires a prior permission — and granting
    ///         permission is a transaction, which costs ETH. A user holding only
    ///         VOID would be stuck at the door, before even reaching the
    ///         sponsorship.
    ///
    ///         EIP-2612 turns the permission into a signature, and the relayer
    ///         presents it alongside. Zero transactions from the user, start to
    ///         finish.
    ///
    ///         That is why the mainnet VOID token MUST implement 2612. The
    ///         test token implements it too, so the sponsored runtime path needs
    ///         only signatures from the user and no ETH from their wallet.
    function sponsorWithPermit(
        SponsoredCall calldata req,
        bytes calldata signature,
        Permit[] calldata permissions
    ) external nonReentrant returns (bool executed, bytes memory result) {
        uint256 gasStart = gasleft();
        if (permissions.length > MAX_PERMITS_PER_CALL) {
            revert TooManyPermits(permissions.length, MAX_PERMITS_PER_CALL);
        }

        bool sawPaymaster;
        bool sawRuntime;
        uint256 runtimeBudget = _voidSpendLimit(req.spends);
        for (uint256 i; i < permissions.length; ++i) {
            address spender = permissions[i].spender;
            uint256 atLeast;
            if (spender == address(this)) {
                if (sawPaymaster) revert DuplicatePermitSpender(spender);
                sawPaymaster = true;
                atLeast = req.maxToll + req.maxGasVoid;
            } else if (spender == address(runtime)) {
                if (sawRuntime) revert DuplicatePermitSpender(spender);
                sawRuntime = true;
                atLeast = runtimeBudget;
            } else {
                revert UnexpectedPermitSpender(spender);
            }
            _applyPermit(req.user, permissions[i], atLeast);
        }

        // A permit may already have been submitted before the relayer sees it,
        // or the user may be using the `sponsor` path with an existing approval.
        // Check the actual allowances, rather than requiring a permit object.
        _requireAllowance(req.user, address(this), req.maxToll + req.maxGasVoid);
        if (runtimeBudget > 0) _requireAllowance(req.user, address(runtime), runtimeBudget);
        return _sponsor(gasStart, req, signature);
    }

    /// @notice Relays a complete ChainApp action using signatures only.
    /// @dev Each permission is restricted to one of two things: VOID to this
    ///      Paymaster for the displayed toll + gas ceiling, or a token already
    ///      listed in the signed app budget to the frozen Runtime. This is not
    ///      an arbitrary permit-delivery endpoint.
    function sponsorWithAssetPermits(
        SponsoredCall calldata req,
        bytes calldata signature,
        AssetPermit[] calldata permissions
    ) external nonReentrant returns (bool executed, bytes memory result) {
        uint256 gasStart = gasleft();
        if (permissions.length > MAX_ASSET_PERMITS_PER_CALL) {
            revert TooManyPermits(permissions.length, MAX_ASSET_PERMITS_PER_CALL);
        }

        for (uint256 i; i < permissions.length; ++i) {
            AssetPermit calldata permission = permissions[i];
            if (permission.token == address(0) || permission.spender == address(0)) revert ZeroAddress();
            for (uint256 j; j < i; ++j) {
                if (permissions[j].token == permission.token && permissions[j].spender == permission.spender) {
                    revert DuplicateAssetPermit(permission.token, permission.spender);
                }
            }

            uint256 needed;
            if (permission.token == address(voidToken) && permission.spender == address(this)) {
                needed = req.maxToll + req.maxGasVoid;
            } else if (permission.spender == address(runtime)) {
                needed = _spendLimit(req.spends, permission.token);
            } else {
                revert UnexpectedAssetPermit(permission.token, permission.spender);
            }
            if (needed == 0 || permission.value < needed) {
                revert AllowanceTooLow(req.user, permission.spender, permission.value, needed);
            }
            _applyAssetPermit(req.user, permission, needed);
        }

        _requireAllowance(req.user, address(this), req.maxToll + req.maxGasVoid);
        _requireSpendAllowances(req.user, req.spends);
        return _sponsor(gasStart, req, signature);
    }

    /// @dev    The `catch` exists because of a known attack: anyone can see the
    ///         permit signature in the mempool and present it first, spending its
    ///         nonce. The permit then fails — but the permission ALREADY EXISTS,
    ///         and taking the sponsorship down over that would turn a cheap
    ///         attack into a denial of service.
    ///
    ///         The error is not swallowed: what counts is the outcome, and it is
    ///         checked right below. If the permission really did not stick, this
    ///         reverts with an error that says exactly what happened.
    function _applyPermit(address user, Permit calldata p, uint256 atLeast) private {
        if (p.spender == address(0)) revert ZeroAddress();
        try IERC20Permit(address(voidToken)).permit(
            user, p.spender, p.value, p.deadline, p.v, p.r, p.s
        ) {} catch {}

        // Checks that the permission COVERS what is coming, not merely that it
        // is non-zero. A dust allowance left over from another era would pass the
        // old test and the flow would go on to fail further down with an error
        // that says nothing about what happened.
        if (voidToken.allowance(user, p.spender) < atLeast) revert PermitDidNotStick(user);
    }

    function _applyAssetPermit(address user, AssetPermit calldata p, uint256 atLeast) private {
        try IERC20Permit(p.token).permit(user, p.spender, p.value, p.deadline, p.v, p.r, p.s) {} catch {}
        if (IERC20(p.token).allowance(user, p.spender) < atLeast) revert PermitDidNotStick(user);
    }

    // Reimburses only the submitting relayer, measured and capped by the validated
    // signed gas budget; it is not a user-selected withdrawal destination.
    // slither-disable-next-line arbitrary-send-eth
    function _sponsor(uint256 gasStart, SponsoredCall calldata req, bytes calldata signature)
        private
        returns (bool executed, bytes memory result)
    {
        // =================================================================
        // VALIDATION — everything that can refuse happens BEFORE anything runs.
        //
        // This separation is the defense against the attack that broke the
        // model: an attacker with no VOID at all signed a request pointing at a
        // gas-burning app, and any relayer that picked it up burned millions of
        // gas only to revert at the end — with no reimbursement, no charge and
        // WITHOUT SPENDING THE NONCE, so the same request worked infinitely
        // many times.
        //
        // Here nothing expensive runs before payment is secured, and once it is
        // secured nothing reverts any more.
        // =================================================================
        uint256 worstEth = _validate(req, signature);

        // =================================================================
        // PREFUND — the worst case leaves the user before execution runs.
        //
        // Charging afterwards left two gaps: the user could revoke the
        // permission between signing and being relayed, and the called app
        // itself could empty their balance during execution. In both cases the
        // relayer was left holding the bill. With the value already in custody,
        // nothing that happens from here on prevents payment.
        // =================================================================
        uint256 prefund = req.maxToll + req.maxGasVoid;
        _requireAllowance(req.user, address(this), prefund);
        _requireSpendAllowances(req.user, req.spends);
        _pull(req.user, prefund);

        if (req.maxToll > 0) {
            if (!voidToken.approve(address(runtime), req.maxToll)) revert TransferFailed();
        }

        // =================================================================
        // EXECUTION — with limited gas, and failure does NOT take the tx down.
        //
        // A call that reverts in there still costs gas, and that gas is the
        // user's, exactly as a reverted transaction costs gas on a real
        // blockchain. Propagating the failure here would hand the attacker back
        // the power to work for free.
        // =================================================================
        (executed, result) = _run(req);

        // How much of the toll was actually consumed — measured by the leftover
        // allowance, not by balance. Measuring by balance left the accounting at
        // the mercy of an app that transferred VOID to the paymaster mid-execution.
        uint256 tollPaid;
        if (req.maxToll > 0) {
            tollPaid = req.maxToll - voidToken.allowance(address(this), address(runtime));
            if (!voidToken.approve(address(runtime), 0)) revert TransferFailed();
        }

        // =================================================================
        // SETTLEMENT — nothing here may revert, and nothing exceeds the prefund.
        // =================================================================
        uint256 ethSpent = (gasStart - gasleft() + gasOverhead) * tx.gasprice + _l1Fee();
        uint256 gasVoid = _gasVoid(ethSpent);
        uint256 charge = _toVoid(ethSpent);

        // Safety latches: the worst case was already validated, so these
        // ceilings should never bite. They stay because an accounting error here
        // would come out of third parties' pockets.
        if (charge > req.maxGasVoid) {
            charge = req.maxGasVoid;
            gasVoid = (charge * BPS) / (BPS + marginBps);
        }
        if (ethSpent > worstEth) ethSpent = worstEth;

        reimbursableVoid += gasVoid;
        surplusVoid += charge - gasVoid;

        uint256 refund = prefund - tollPaid - charge;
        if (refund > 0) {
            if (!voidToken.transfer(req.user, refund)) revert TransferFailed();
        }

        (bool ok,) = msg.sender.call{value: ethSpent}("");
        if (!ok) revert ReimbursementFailed();

        emit Sponsored(
            req.user, msg.sender, req.tokenId, tollPaid, gasVoid, charge - gasVoid, ethSpent
        );
    }

    /// @notice Everything that can refuse the sponsorship, before executing
    ///         anything at all. Past this point, nothing reverts any more.
    /// @return worstEth The most ETH this call can cost the reserve.
    function _validate(SponsoredCall calldata req, bytes calldata signature)
        private
        returns (uint256 worstEth)
    {
        if (voidPerEth() == 0) revert RateNotSet();
        if (tx.gasprice > maxGasPrice) revert GasPriceAboveLimit(tx.gasprice, maxGasPrice);
        if (block.timestamp > req.deadline) revert Expired(req.deadline);

        uint256 expected = nonces[req.user];
        if (req.nonce != expected) revert BadNonce(req.nonce, expected);

        _requireSignedByUser(req, signature);

        // The worst case INCLUDES THE CALLDATA. It is chosen by whoever signs,
        // leftover bytes are discarded during decoding, and the window measured
        // by `gasleft()` does not see it — you could hang 40 KB of junk on it
        // that the relayer paid for and nobody reimbursed.
        worstEth = (req.callGasLimit + gasOverhead) * tx.gasprice + _l1Fee();

        // Does the user's ceiling cover the worst case of what they themselves
        // authorized? Checking this AFTER execution was what allowed burning the
        // relayer's gas only to then refuse the bill.
        uint256 worstCharge = _toVoid(worstEth);
        if (worstCharge > req.maxGasVoid) revert GasAboveLimit(worstCharge, req.maxGasVoid);
        if (worstEth > 0 && _gasVoid(worstEth) == 0) {
            revert RateTooLowToCharge(worstEth, voidPerEth());
        }

        if (address(this).balance < worstEth) {
            revert ReserveTooLow(address(this).balance, worstEth);
        }
        _chargeBlockBudget(worstEth);
        _chargeChainBudget(req.tokenId, worstEth);

        // The relayer brought enough gas to honor the limit the user declared.
        // Without this, a relayer that sends too little gas makes the execution
        // fail through its own fault and the bill lands on the user.
        if (gasleft() < req.callGasLimit + FINALIZATION_GAS) {
            revert NotEnoughGasForCall(gasleft(), req.callGasLimit);
        }

        nonces[req.user] = expected + 1;
    }

    /// @dev Extracted from `_sponsor` because the budget arrays did not fit on
    ///      the stack alongside the settlement accounting.
    function _run(SponsoredCall calldata req)
        private
        returns (bool executed, bytes memory result)
    {
        (address[] memory spendTokens, uint256[] memory spendLimits) = _splitSpends(req.spends);
        address[] memory collections = new address[](req.nftSpends.length);
        uint256[] memory nftIds = new uint256[](req.nftSpends.length);
        for (uint256 i; i < req.nftSpends.length; ++i) {
            collections[i] = req.nftSpends[i].collection;
            nftIds[i] = req.nftSpends[i].tokenId;
        }

        try runtime.executeForWithBudget{gas: req.callGasLimit}(
            req.user,
            req.tokenId,
            req.target,
            req.data,
            req.maxToll,
            IVoidChainAppRuntime.SpendAuth({
                tokens: spendTokens,
                limits: spendLimits,
                collections: collections,
                nftIds: nftIds
            })
        ) returns (bytes memory returned) {
            executed = true;
            result = returned;
        } catch (bytes memory reason) {
            executed = false;
            emit ExecutionFailed(req.user, req.tokenId, req.target, reason);
        }
    }

    /// @dev This transaction's L1 cost, asked of ArbOS.
    ///
    ///      Outside an Arbitrum chain the precompile does not exist, and there
    ///      the L1 cost is genuinely ZERO — there is no L1 to post anything to.
    ///      Zero is the correct answer in that environment, not a swallowed
    ///      error: it is how the local tests run, and it is why the fallback
    ///      returns zero instead of reverting.
    ///      The call is a raw `staticcall`, not `try/catch`, for a concrete
    ///      reason: Solidity inserts an `extcodesize` check BEFORE a high-level
    ///      call that returns data, and that revert happens in our own frame —
    ///      out of reach of the `catch`. In an environment without the
    ///      precompile, the `try` took the whole transaction down.
    function _l1Fee() private view returns (uint256) {
        (bool ok, bytes memory out) = ARB_GAS_INFO.staticcall(
            abi.encodeWithSelector(IArbGasInfo.getCurrentTxL1GasFees.selector)
        );
        if (ok && out.length >= 32) return abi.decode(out, (uint256));
        return 0;
    }

    function _gasVoid(uint256 ethAmount) private view returns (uint256) {
        return (ethAmount * voidPerEth()) / 1e18;
    }

    function _toVoid(uint256 ethAmount) private view returns (uint256) {
        return (_gasVoid(ethAmount) * (BPS + marginBps)) / BPS;
    }

    /// @dev Limits how much ETH leaves the reserve per block.
    ///
    ///      It does not stop the reserve from being spent — it stops it from
    ///      being emptied at once. The real risk is the rate going stale: while
    ///      `voidPerEth` is right, draining the reserve is just buying ETH while
    ///      paying the margin, which is the designed flow. When it is wrong, it
    ///      becomes arbitrage against the protocol, and this ceiling limits the
    ///      damage to one block at a time instead of a single withdrawal.
    function _chargeBlockBudget(uint256 amount) private {
        if (maxEthPerBlock == 0) return;
        if (block.number != blockOfLastSpend) {
            blockOfLastSpend = block.number;
            spentThisBlock = 0;
        }
        uint256 next = spentThisBlock + amount;
        if (next > maxEthPerBlock) revert BlockBudgetExceeded(next, maxEthPerBlock);
        spentThisBlock = next;
    }

    function _chargeChainBudget(uint256 tokenId, uint256 amount) private {
        uint256 limit = dailyChainEthLimit;
        if (limit == 0) revert ChainDailyLimitNotSet();
        // The configured absolute ceiling cannot allow one chain to exhaust
        // a small reserve. Use at most one quarter of the current balance;
        // this bound tightens automatically when the reserve falls.
        uint256 reserveLimit = address(this).balance / 4;
        if (reserveLimit < limit) limit = reserveLimit;
        uint256 epoch = block.timestamp / 1 days;
        uint256 next = chainEpochEthSpent[tokenId][epoch] + amount;
        if (next > limit) revert ChainDailyBudgetExceeded(tokenId, next, limit);
        chainEpochEthSpent[tokenId][epoch] = next;
    }

    function _requireSignedByUser(SponsoredCall calldata req, bytes calldata signature)
        private
        view
    {
        bytes32 structHash = keccak256(
            abi.encode(
                SPONSORED_CALL_TYPEHASH,
                req.user,
                req.tokenId,
                req.target,
                keccak256(req.data),
                req.maxToll,
                req.maxGasVoid,
                req.callGasLimit,
                _hashSpends(req.spends),
                _hashNftSpends(req.nftSpends),
                req.nonce,
                req.deadline
            )
        );
        address signer = ECDSA.recover(_hashTypedDataV4(structHash), signature);
        if (signer != req.user) revert BadSignature();
    }

    /// @dev A struct array in EIP-712: hash each element, concatenate, and hash
    ///      again. Without this, two requests with different budgets would have
    ///      the SAME signature — and the relayer would pick how much the user
    ///      authorized spending.
    function _hashSpends(Spend[] calldata spends) private pure returns (bytes32) {
        bytes32[] memory hashes = new bytes32[](spends.length);
        for (uint256 i; i < spends.length; ++i) {
            hashes[i] = keccak256(abi.encode(SPEND_TYPEHASH, spends[i].token, spends[i].amount));
        }
        return keccak256(abi.encodePacked(hashes));
    }

    function _hashNftSpends(SpendNft[] calldata list) private pure returns (bytes32) {
        bytes32[] memory hashes = new bytes32[](list.length);
        for (uint256 i; i < list.length; ++i) {
            hashes[i] =
                keccak256(abi.encode(SPEND_NFT_TYPEHASH, list[i].collection, list[i].tokenId));
        }
        return keccak256(abi.encodePacked(hashes));
    }

    function _splitSpends(Spend[] calldata spends)
        private
        pure
        returns (address[] memory tokens, uint256[] memory limits)
    {
        tokens = new address[](spends.length);
        limits = new uint256[](spends.length);
        for (uint256 i; i < spends.length; ++i) {
            tokens[i] = spends[i].token;
            limits[i] = spends[i].amount;
        }
    }

    // All callers use the EIP-712-authenticated user and bounded prefund after
    // _validate consumes the on-chain nonce. Never exposed as an arbitrary pull.
    // slither-disable-next-line arbitrary-send-erc20
    function _pull(address from, uint256 amount) private {
        // V9's frozen Paymaster operator removes the first-use approval while
        // the signed request still caps every amount and consumes a nonce. The
        // fallback preserves compatibility with the already deployed V8 token.
        try IVoidProtocolToken(address(voidToken)).protocolTransferFrom(from, address(this), amount) returns (bool ok) {
            if (!ok) revert TransferFailed();
        } catch {
            if (!voidToken.transferFrom(from, address(this), amount)) revert TransferFailed();
        }
    }

    /// @dev Adds the signed VOID budgets so the legacy VOID-only permit is
    ///      checked against the amount an app may actually pull.
    function _voidSpendLimit(Spend[] calldata spends) private view returns (uint256 total) {
        for (uint256 i; i < spends.length; ++i) {
            if (spends[i].token == address(voidToken)) total += spends[i].amount;
        }
    }

    function _spendLimit(Spend[] calldata spends, address token) private pure returns (uint256 total) {
        for (uint256 i; i < spends.length; ++i) {
            if (spends[i].token == token) total += spends[i].amount;
        }
    }

    /// @dev All app token permissions are proven before the relayer can spend
    ///      gas inside application code. A token is checked once even if the
    ///      signed request uses it in several budget entries.
    function _requireSpendAllowances(address user, Spend[] calldata spends) private view {
        for (uint256 i; i < spends.length; ++i) {
            address token = spends[i].token;
            bool seen;
            for (uint256 j; j < i; ++j) if (spends[j].token == token) seen = true;
            if (seen) continue;
            uint256 needed = _spendLimit(spends, token);
            if (token == address(voidToken) && _v9OperatorsReady()) continue;
            uint256 available = IERC20(token).allowance(user, address(runtime));
            if (available < needed) revert AllowanceTooLow(user, address(runtime), available, needed);
        }
    }

    function _requireAllowance(address user, address spender, uint256 needed) private view {
        if (
            _v9OperatorsReady()
                && (spender == address(this) || spender == address(runtime))
        ) return;
        uint256 available = voidToken.allowance(user, spender);
        if (available < needed) revert AllowanceTooLow(user, spender, available, needed);
    }

    function _v9OperatorsReady() private view returns (bool) {
        try IVoidProtocolToken(address(voidToken)).isProtocolOperator(address(this)) returns (bool ready) {
            return ready;
        } catch {
            return false;
        }
    }

    // ---------------------------------------------------------------------
    // The reserve
    // ---------------------------------------------------------------------

    /// @notice Tops up the ETH reserve. Open to anyone.
    function fundEth() external payable {
        emit ReserveFunded(msg.sender, msg.value);
    }

    /// @dev Receives both direct top-ups and the ETH coming out of WETH's
    ///      `withdraw` during `refill`.
    receive() external payable {
        emit ReserveFunded(msg.sender, msg.value);
    }

    /// @notice Withdraws ETH from the reserve.
    ///
    /// @dev    WITHOUT THIS THE RESERVE IS A ONE-WAY DOOR, and that was the bug:
    ///         the first version only knew how to receive ETH. Every ETH
    ///         deposited was stuck forever — there was no exit path in the
    ///         bytecode. In a paymaster migration, or simply when shutting one
    ///         down, the entire balance would be lost. Two test paymasters ended
    ///         up exactly like that.
    ///
    ///         It deliberately does NOT respect `ethFloor`. The floor exists to
    ///         stop BURNING from consuming the reserve; here it is the protocol
    ///         owner moving their own treasury, and a legitimate migration has to
    ///         take everything. The price of that is that governance can stop the
    ///         system by emptying the reserve — which is why it has to be a
    ///         multisig with a timelock before mainnet, not a single key.
    function withdrawEth(address payable to, uint256 amount) external onlyGovernor nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        if (amount > address(this).balance) {
            revert AmountAboveBalance(amount, address(this).balance);
        }
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert ReimbursementFailed();
        emit EthWithdrawn(to, amount);
    }

    /// @notice True when the permissionless keeper may rebuild the ETH reserve.
    function needsRefill() public view returns (bool) {
        return refillThreshold != 0
            && (address(voidEthPool) != address(0) || address(swapRouter) != address(0))
            && address(this).balance < refillThreshold && reimbursableVoid != 0;
    }

    /// @notice Bounded input and minimum ETH output for the next public refill.
    /// @dev The keeper submits these exact values. It cannot select a larger
    ///      sale or lower the on-chain 30-minute-TWAP slippage floor.
    function refillPlan()
        public
        view
        returns (bool shouldRefill, uint256 amountVoid, uint256 minEthOut)
    {
        if (!needsRefill()) return (false, 0, 0);

        uint256 missingEth = refillTarget - address(this).balance;
        uint256 rate = voidPerEth();
        if (rate == 0) revert RateNotSet();

        uint256 neededVoid = Math.mulDiv(missingEth, rate, 1e18, Math.Rounding.Ceil);
        amountVoid = neededVoid < reimbursableVoid ? neededVoid : reimbursableVoid;
        if (amountVoid == 0) return (false, 0, 0);

        uint256 oracleEthOut = Math.mulDiv(amountVoid, 1e18, rate);
        minEthOut = Math.mulDiv(
            oracleEthOut, BPS - refillSlippageBps, BPS, Math.Rounding.Floor
        );
        return (true, amountVoid, minEthOut);
    }

    /// @notice Sells the replacement VOID for ETH and rebuilds the reserve on
    ///         its own.
    ///
    /// @dev    THIS USED TO BE MANUAL: governance withdrew the VOID, sold it
    ///         outside, and returned the ETH. It worked and depended on somebody
    ///         remembering — which means the reserve would dry up on the first
    ///         weekend nobody looked.
    ///
    ///         WHY A SEPARATE FUNCTION, AND NOT INSIDE `sponsor`. A swap on the
    ///         sponsored path would make EVERY transaction more expensive, put
    ///         liquidity and slippage failures on the critical path, and expose
    ///         every user to sandwiching. Out here, sponsorship stays cheap and
    ///         the reserve heals itself.
    ///
    ///         `minEthOut` is mandatory and has no default: without it, the
    ///         refill itself becomes the target of the sandwich we are avoiding.
    ///
    ///         Open for anyone to call — the destination is the reserve itself,
    ///         so the caller chooses nothing beyond paying the gas.
    function refill(uint256 amountVoid, uint256 minEthOut)
        external
        nonReentrant
        returns (uint256 ethOut)
    {
        if (address(voidEthPool) == address(0) && address(swapRouter) == address(0)) {
            revert SwapRouteNotSet();
        }
        (bool shouldRefill, uint256 maxVoid, uint256 minAllowed) = refillPlan();
        if (!shouldRefill) {
            revert RefillNotNeeded(address(this).balance, refillThreshold, reimbursableVoid);
        }
        if (amountVoid == 0 || amountVoid > maxVoid) revert RefillAbovePlan(amountVoid, maxVoid);
        if (minEthOut < minAllowed) revert RefillMinOutTooLow(minEthOut, minAllowed);
        reimbursableVoid -= amountVoid;

        // Reset first and after the swap. This supports strict ERC-20s and
        // leaves no live allowance. V6 uses the locked pool; older deployments
        // preserve the external V3 route as their migration fallback.
        address spender = address(voidEthPool) != address(0)
            ? address(voidEthPool)
            : address(swapRouter);
        if (!voidToken.approve(spender, 0)) revert TransferFailed();
        if (!voidToken.approve(spender, amountVoid)) revert TransferFailed();
        if (address(voidEthPool) != address(0)) {
            ethOut = voidEthPool.swapVoidForEth(amountVoid, minEthOut);
        } else {
            ethOut = swapRouter.exactInputSingle(
                ISwapRouter.ExactInputSingleParams({
                    tokenIn: address(voidToken),
                    tokenOut: weth,
                    fee: poolFee,
                    recipient: address(this),
                    amountIn: amountVoid,
                    amountOutMinimum: minEthOut,
                    sqrtPriceLimitX96: 0
                })
            );
            IWETH(weth).withdraw(ethOut);
        }
        if (!voidToken.approve(spender, 0)) revert TransferFailed();
        emit Refilled(amountVoid, ethOut);
    }

    /// @notice Rescues VOID that arrived outside the two accounts.
    ///
    /// @dev    SAME LESSON AS `withdrawEth`, on the other side of the balance
    ///         sheet. Both VOID exits are bounded by the accounts that govern
    ///         them — `withdrawReimbursable` by `reimbursableVoid`, `burnSurplus`
    ///         by `surplusVoid`. VOID arriving by any other path (a mistaken
    ///         transfer, a donation) belongs to neither and, without this, would
    ///         never be withdrawable or burnable again.
    ///
    ///         It only reaches the excess over the two accounts, so there is no
    ///         way to use it to touch what is replacement or margin.
    function sweepUnaccounted(address to) external onlyGovernor returns (uint256 amount) {
        if (to == address(0)) revert ZeroAddress();
        uint256 accounted = reimbursableVoid + surplusVoid;
        uint256 held = voidToken.balanceOf(address(this));
        if (held <= accounted) revert NothingUnaccounted();
        amount = held - accounted;
        if (!voidToken.transfer(to, amount)) revert TransferFailed();
        emit ReimbursableWithdrawn(to, amount);
    }

    /// @notice Withdraws the VOID that has to become ETH, to be sold.
    ///
    /// @dev    THE SALE HAPPENS OUTSIDE HERE, and that is deliberate. Selling in
    ///         the contract itself would require tying it to a specific DEX and a
    ///         price path — more attack surface and less execution freedom than
    ///         the problem justifies. Here the value leaves marked as what it is
    ///         (replacement, not profit) and comes back as ETH through `fundEth`.
    function withdrawReimbursable(address to, uint256 amount) external onlyGovernor {
        if (to == address(0)) revert ZeroAddress();
        if (amount > reimbursableVoid) revert AmountAboveBalance(amount, reimbursableVoid);
        reimbursableVoid -= amount;
        if (!voidToken.transfer(to, amount)) revert TransferFailed();
        emit ReimbursableWithdrawn(to, amount);
    }

    // ---------------------------------------------------------------------
    // The burn
    // ---------------------------------------------------------------------

    /// @notice Applies the burn policy to the accrued surplus.
    /// @dev    Open to anyone: the policy is in the code, the caller chooses
    ///         nothing beyond paying the gas to run it.
    function burnSurplus() external nonReentrant returns (uint256 burned, uint256 toRunway) {
        uint256 available = surplusVoid;
        if (available == 0) revert NothingToBurn();

        (burned, toRunway) = _burnPolicy(available, address(this).balance, ethFloor);
        if (burned + toRunway > available) revert PolicyOverspend(burned + toRunway, available);
        if (burned == 0 && toRunway == 0) revert NothingToBurn();

        surplusVoid = available - burned - toRunway;

        if (burned > 0) {
            if (!voidToken.transfer(BURN_ADDRESS, burned)) revert TransferFailed();
        }
        if (toRunway > 0) {
            if (!voidToken.transfer(runwayTreasury, toRunway)) revert TransferFailed();
        }
        emit SurplusBurned(burned, toRunway);
    }

    /// @notice Decides where the surplus goes: how much burns, how much becomes
    ///         operating cash.
    ///
    /// @dev    THIS IS THE PROTOCOL'S ECONOMIC DECISION, and it carries a
    ///         trade-off with no technical answer: burning 100% returns value to
    ///         every holder but leaves the operation with no cash; burning 0%
    ///         funds the operation but returns nothing to anyone.
    ///
    ///         The ETH floor is non-negotiable and is already applied below: with
    ///         the reserve under it, nothing leaves here — neither burn nor cash.
    ///         A stopped system is worse than any burn policy.
    ///
    /// @param  surplus  Accrued margin, available to allocate.
    /// @param  reserve  The paymaster's ETH balance at this instant.
    /// @param  floor    Solvency floor below which nothing is allocated.
    function _burnPolicy(uint256 surplus, uint256 reserve, uint256 floor)
        private
        pure
        returns (uint256 burned, uint256 toRunway)
    {
        if (reserve < floor) return (0, 0);

        // Immutable V11 policy: once the ETH solvency floor is healthy, half
        // of margin is burned and the remainder funds operating runway. Odd
        // wei goes to runway so accounting always consumes the exact surplus.
        burned = surplus / 2;
        toRunway = surplus - burned;
    }

    // ---------------------------------------------------------------------
    // Governance
    // ---------------------------------------------------------------------

    /// @notice Governance only tunes the MARGIN. The rate comes from the oracle.
    /// @dev    The step limit left along with the manual rate: there is no sense
    ///         in limiting how much the market moves. What bounds abuse now is
    ///         the margin ceiling, which remains, and the `maxGasVoid` the user
    ///         signs.
    function setMargin(uint256 marginBps_) external onlyGovernor {
        if (marginBps_ > MAX_MARGIN_BPS) revert MarginTooHigh(marginBps_, MAX_MARGIN_BPS);
        marginBps = marginBps_;
        emit RateUpdated(voidPerEth(), marginBps_);
    }

    /// @notice Points at the price oracle.
    /// @dev    Replaceable because oracles break: discontinued feed, migrated
    ///         pool. Immutable here would be a permanent point of failure. The
    ///         price is trusting governance not to point at a lying oracle.
    function setOracle(IVoidPriceOracle oracle_) external onlyGovernor {
        if (address(oracle_) == address(0)) revert ZeroAddress();
        oracle = oracle_;
        emit OracleUpdated(address(oracle_));
    }

    /// @notice Sets where `refill` sells VOID for ETH.
    function setSwapRoute(ISwapRouter router_, address weth_, uint24 poolFee_)
        external
        onlyGovernor
    {
        if (address(router_) == address(0) || weth_ == address(0)) revert ZeroAddress();
        swapRouter = router_;
        weth = weth_;
        poolFee = poolFee_;
        emit SwapRouteUpdated(address(router_), weth_, poolFee_);
    }

    /// @notice Pins the V6 genesis pool used to replenish the parent-ETH reserve.
    /// @dev There is intentionally no replacement setter. A future protocol
    /// migration must deploy a new Paymaster under a published governance action
    /// rather than changing the economics under existing users.
    function setVoidEthPoolOnce(IVoidEthExitPool pool_) external onlyGovernor {
        if (address(pool_) == address(0)) revert ZeroAddress();
        if (address(voidEthPool) != address(0)) revert VoidEthPoolAlreadySet(address(voidEthPool));
        voidEthPool = pool_;
        emit VoidEthPoolSet(address(pool_));
    }

    /// @notice Sets the trigger, target and maximum TWAP slippage for public
    ///         reserve refills. A zero/zero pair intentionally disables them.
    function setRefillPolicy(uint256 threshold, uint256 target, uint256 slippageBps)
        external
        onlyGovernor
    {
        if (
            slippageBps > MAX_REFILL_SLIPPAGE_BPS
                || !((threshold == 0 && target == 0) || (threshold > 0 && threshold < target))
        ) revert BadRefillPolicy(threshold, target, slippageBps);
        refillThreshold = threshold;
        refillTarget = target;
        refillSlippageBps = slippageBps;
        emit RefillPolicyUpdated(threshold, target, slippageBps);
    }

    function setLimits(
        uint256 ethFloor_,
        uint256 gasOverhead_,
        uint256 maxGasPrice_,
        uint256 maxEthPerBlock_
    ) external onlyGovernor {
        if (gasOverhead_ > MAX_GAS_OVERHEAD) revert OverheadTooHigh(gasOverhead_, MAX_GAS_OVERHEAD);
        ethFloor = ethFloor_;
        gasOverhead = gasOverhead_;
        maxGasPrice = maxGasPrice_;
        maxEthPerBlock = maxEthPerBlock_;
        emit LimitsUpdated(ethFloor_, gasOverhead_, maxGasPrice_);
    }

    function setDailyChainEthLimit(uint256 limit) external onlyGovernor {
        if (limit == 0) revert ChainDailyLimitNotSet();
        dailyChainEthLimit = limit;
        emit DailyChainLimitUpdated(limit);
    }

    function transferGovernor(address next) external onlyGovernor {
        if (next == address(0)) revert ZeroAddress();
        emit GovernorTransferred(governor, next);
        governor = next;
    }

    function setRunwayTreasury(address next) external onlyGovernor {
        if (next == address(0)) revert ZeroAddress();
        emit RunwayTreasuryUpdated(runwayTreasury, next);
        runwayTreasury = next;
    }

}
