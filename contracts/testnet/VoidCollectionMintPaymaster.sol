// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

interface IMintPayToken {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
    function allowance(address owner, address spender) external view returns (uint256);
}

interface IMintPayOracle {
    function voidPerEth() external view returns (uint256);
}

interface IMintPayMarket {
    function buyRandomFor(address buyer, uint256 maxCost) external returns (uint256 deedId);
}

/// @title VoidCollectionMintPaymaster
/// @notice A fixed-purpose VOID sponsor for the collection mint only.
/// @dev This is intentionally separate from `VoidPaymaster`: keeping the
///      collection route out of the general runtime sponsor keeps both pieces
///      below the EVM bytecode limit and makes it impossible to use a mint
///      signature as a generic app call.
contract VoidCollectionMintPaymaster is ReentrancyGuard, EIP712 {
    uint256 public constant BPS = 10_000;
    uint256 public constant MAX_MARGIN_BPS = 3_000;
    uint256 public constant MAX_GAS_OVERHEAD = 200_000;
    uint256 public constant FINALIZATION_GAS = 70_000;
    bytes32 public constant REQUEST_TYPEHASH = keccak256(
        "MarketPrepaidCall(address user,address market,address paymentToken,string paymentSymbol,string purchaseLabel,uint256 appSpend,uint256 maxGasVoid,uint256 callGasLimit,uint256 nonce,uint256 deadline)"
    );
    bytes32 private constant VOID_HASH = keccak256("VOID");
    bytes32 private constant MINT_HASH = keccak256("VOID deed mint");

    struct MarketPrepaidCall {
        address user;
        address market;
        address paymentToken;
        string paymentSymbol;
        string purchaseLabel;
        uint256 appSpend;
        uint256 maxGasVoid;
        uint256 callGasLimit;
        uint256 nonce;
        uint256 deadline;
    }

    IMintPayToken public immutable voidToken;
    IMintPayOracle public immutable oracle;
    address public governor;
    address public collectionMarket;
    uint256 public marginBps = 1_000;
    uint256 public gasOverhead = 60_000;
    uint256 public maxGasPrice = 10 gwei;
    mapping(address user => uint256) public nonces;

    event CollectionMarketSet(address indexed market);
    event Sponsored(address indexed user, address indexed relayer, uint256 appSpend, uint256 gasVoid, uint256 ethReimbursed);
    event ExecutionFailed(address indexed user, bytes reason);
    event LimitsUpdated(uint256 marginBps, uint256 gasOverhead, uint256 maxGasPrice);
    event GovernorTransferred(address indexed previous, address indexed next);
    event EthWithdrawn(address indexed to, uint256 amount);
    event VoidWithdrawn(address indexed to, uint256 amount);

    error ZeroAddress();
    error NotGovernor(address caller);
    error MarketAlreadySet();
    error MarketNotSet();
    error WrongMarket(address supplied, address expected);
    error WrongToken(address supplied, address expected);
    error DisplayMismatch();
    error Expired();
    error BadNonce(uint256 supplied, uint256 expected);
    error BadSignature();
    error GasPriceTooHigh();
    error GasCapTooLow();
    error ReserveTooLow();
    error NotEnoughGas();
    error AllowanceTooLow();
    error TransferFailed();
    error ReimbursementFailed();
    error MarginTooHigh();
    error OverheadTooHigh();
    error AmountTooHigh();

    constructor(IMintPayToken token_, IMintPayOracle oracle_, address governor_)
        EIP712("VoidCollectionMintPaymaster", "1")
    {
        if (address(token_) == address(0) || address(oracle_) == address(0) || governor_ == address(0)) {
            revert ZeroAddress();
        }
        voidToken = token_;
        oracle = oracle_;
        governor = governor_;
    }

    modifier onlyGovernor() {
        if (msg.sender != governor) revert NotGovernor(msg.sender);
        _;
    }

    receive() external payable {}

    function sponsorMarketPrepaid(MarketPrepaidCall calldata req, bytes calldata signature)
        external
        nonReentrant
        returns (bool executed, bytes memory result)
    {
        uint256 gasStart = gasleft();
        uint256 worstEth = _validate(req, signature);
        uint256 prefund = req.appSpend + req.maxGasVoid;
        if (voidToken.allowance(req.user, address(this)) < prefund) revert AllowanceTooLow();
        if (!voidToken.transferFrom(req.user, address(this), prefund)) revert TransferFailed();

        address market = collectionMarket;
        if (voidToken.allowance(address(this), market) > 0 && !voidToken.approve(market, 0)) {
            revert TransferFailed();
        }
        if (req.appSpend > 0 && !voidToken.approve(market, req.appSpend)) revert TransferFailed();
        try IMintPayMarket(market).buyRandomFor{gas: req.callGasLimit}(req.user, req.appSpend) returns (uint256 deedId) {
            executed = true;
            result = abi.encode(deedId);
        } catch (bytes memory reason) {
            emit ExecutionFailed(req.user, reason);
        }

        uint256 appPaid = req.appSpend - voidToken.allowance(address(this), market);
        if (!voidToken.approve(market, 0)) revert TransferFailed();
        _settle(gasStart, worstEth, req, prefund, appPaid);
    }

    function _validate(MarketPrepaidCall calldata req, bytes calldata signature)
        private
        returns (uint256 worstEth)
    {
        address market = collectionMarket;
        if (market == address(0)) revert MarketNotSet();
        if (req.market != market) revert WrongMarket(req.market, market);
        if (req.paymentToken != address(voidToken)) revert WrongToken(req.paymentToken, address(voidToken));
        if (keccak256(bytes(req.paymentSymbol)) != VOID_HASH || keccak256(bytes(req.purchaseLabel)) != MINT_HASH) {
            revert DisplayMismatch();
        }
        if (block.timestamp > req.deadline) revert Expired();
        if (tx.gasprice > maxGasPrice) revert GasPriceTooHigh();
        uint256 expected = nonces[req.user];
        if (req.nonce != expected) revert BadNonce(req.nonce, expected);
        if (ECDSA.recover(_hashTypedDataV4(_requestHash(req)), signature) != req.user) revert BadSignature();

        uint256 rate = oracle.voidPerEth();
        if (rate == 0) revert GasCapTooLow();
        worstEth = (req.callGasLimit + gasOverhead) * tx.gasprice;
        if (_toVoid(worstEth, rate) > req.maxGasVoid) revert GasCapTooLow();
        if (address(this).balance < worstEth) revert ReserveTooLow();
        if (gasleft() < req.callGasLimit + FINALIZATION_GAS) revert NotEnoughGas();
        nonces[req.user] = expected + 1;
    }

    function _settle(
        uint256 gasStart,
        uint256 worstEth,
        MarketPrepaidCall calldata req,
        uint256 prefund,
        uint256 appPaid
    ) private {
        uint256 rate = oracle.voidPerEth();
        uint256 ethSpent = (gasStart - gasleft() + gasOverhead) * tx.gasprice;
        if (ethSpent > worstEth) ethSpent = worstEth;
        uint256 charge = _toVoid(ethSpent, rate);
        if (charge > req.maxGasVoid) charge = req.maxGasVoid;
        uint256 refund = prefund - appPaid - charge;
        if (refund > 0 && !voidToken.transfer(req.user, refund)) revert TransferFailed();
        (bool ok,) = msg.sender.call{value: ethSpent}("");
        if (!ok) revert ReimbursementFailed();
        emit Sponsored(req.user, msg.sender, appPaid, charge, ethSpent);
    }

    function _toVoid(uint256 ethAmount, uint256 rate) private view returns (uint256) {
        return ((ethAmount * rate) / 1e18 * (BPS + marginBps)) / BPS;
    }

    function _requestHash(MarketPrepaidCall calldata req) private pure returns (bytes32) {
        return keccak256(abi.encode(
            REQUEST_TYPEHASH, req.user, req.market, req.paymentToken,
            keccak256(bytes(req.paymentSymbol)), keccak256(bytes(req.purchaseLabel)),
            req.appSpend, req.maxGasVoid, req.callGasLimit, req.nonce, req.deadline
        ));
    }

    function setCollectionMarketOnce(address market) external onlyGovernor {
        if (market == address(0)) revert ZeroAddress();
        if (collectionMarket != address(0)) revert MarketAlreadySet();
        collectionMarket = market;
        emit CollectionMarketSet(market);
    }

    function setLimits(uint256 marginBps_, uint256 gasOverhead_, uint256 maxGasPrice_) external onlyGovernor {
        if (marginBps_ > MAX_MARGIN_BPS) revert MarginTooHigh();
        if (gasOverhead_ > MAX_GAS_OVERHEAD) revert OverheadTooHigh();
        marginBps = marginBps_;
        gasOverhead = gasOverhead_;
        maxGasPrice = maxGasPrice_;
        emit LimitsUpdated(marginBps_, gasOverhead_, maxGasPrice_);
    }

    function withdrawEth(address payable to, uint256 amount) external onlyGovernor {
        if (to == address(0)) revert ZeroAddress();
        if (amount > address(this).balance) revert AmountTooHigh();
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert ReimbursementFailed();
        emit EthWithdrawn(to, amount);
    }

    function withdrawVoid(address to, uint256 amount) external onlyGovernor {
        if (to == address(0)) revert ZeroAddress();
        if (!voidToken.transfer(to, amount)) revert TransferFailed();
        emit VoidWithdrawn(to, amount);
    }

    function transferGovernor(address next) external onlyGovernor {
        if (next == address(0)) revert ZeroAddress();
        emit GovernorTransferred(governor, next);
        governor = next;
    }
}
