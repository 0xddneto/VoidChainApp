// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ChainAppBase, IVoidChainAppRuntime} from "./ChainAppBase.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IERC20 {
    function transfer(address to, uint256 value) external returns (bool);
    function transferFrom(address from, address to, uint256 value) external returns (bool);
    function balanceOf(address) external view returns (uint256);
}

/// @title ChainAppLaunchpad
/// @notice A token sale inside a chainapp: fixed price, cap, deadline.
///
/// @dev    A REFERENCE APPLICATION, NOT PROTOCOL INFRASTRUCTURE. It exists to
///         measure the system under a usage profile different from the DEX's:
///         here the bottleneck is state writes per buyer, not pool arithmetic.
///
///         The money stays in the contract until the sale closes, and only then
///         does the creator withdraw. It is the minimum that separates a sale
///         from a disguised withdrawal: if the creator could withdraw during it,
///         they would take the early buyers' money and deliver nothing to the
///         later ones.
contract ChainAppLaunchpad is ChainAppBase, ReentrancyGuard {
    IERC20 public immutable paymentToken;

    struct Sale {
        address creator;
        IERC20 token;
        /// @notice How many wei of payment per 1e18 of token sold.
        uint256 price;
        /// @notice Maximum to raise. Zero is not allowed — an uncapped sale is a
        ///         sale that never ends, and the buyer cannot know how much they
        ///         will be diluted.
        uint256 cap;
        uint256 raised;
        uint256 deadline;
        bool finalized;
    }

    uint256 public saleCount;
    mapping(uint256 saleId => Sale) public sales;
    mapping(uint256 saleId => mapping(address buyer => uint256)) public bought;
    /// @notice Stock belongs to a sale, never to another sale using the same token.
    mapping(uint256 saleId => uint256) public remainingStock;

    event SaleCreated(uint256 indexed saleId, address indexed creator, uint256 price, uint256 cap);
    event Bought(uint256 indexed saleId, address indexed buyer, uint256 paid, uint256 received);
    event Finalized(uint256 indexed saleId, uint256 raised);

    error ZeroPrice();
    error ZeroCap();
    error DeadlineInPast();
    error NoSuchSale(uint256 saleId);
    error SaleOver(uint256 saleId);
    error SaleStillOpen(uint256 saleId);
    error AlreadyFinalized(uint256 saleId);
    error CapExceeded(uint256 wanted, uint256 room);
    error NotTheCreator(address who);
    error TransferFailed();
    error UnsupportedToken();
    error ZeroOutput();

    constructor(IVoidChainAppRuntime runtime_, uint256 chainId_, IERC20 paymentToken_)
        ChainAppBase(runtime_, chainId_)
    {
        if (address(paymentToken_) == address(0)) revert ZeroAddress();
        paymentToken = paymentToken_;
    }

    /// @notice Opens a sale. The creator deposits the entire stock up front.
    /// @dev    The stock comes in BEFORE any purchase. A sale that promises
    ///         tokens the creator has not yet delivered is a promise, not a sale
    ///         — and the one who finds out is the buyer, when they try to
    ///         collect.
    // The before/after delta deliberately rejects short-paying tokens. It is
    // not used as an authorization balance; all mutating entrypoints are locked.
    // slither-disable-next-line reentrancy-balance
    function createSale(IERC20 token, uint256 price, uint256 cap, uint256 deadline)
        external
        onlyFromMyChain
        nonReentrant
        returns (uint256 saleId)
    {
        if (price == 0) revert ZeroPrice();
        if (cap == 0) revert ZeroCap();
        if (deadline <= block.timestamp) revert DeadlineInPast();

        if (address(token).code.length == 0) revert UnsupportedToken();
        uint256 stock = Math.mulDiv(cap, 1e18, price);
        if (stock == 0) revert ZeroOutput();
        uint256 beforeBalance = token.balanceOf(address(this));
        spend(address(token), address(this), stock);
        if (token.balanceOf(address(this)) != beforeBalance + stock) revert UnsupportedToken();

        saleId = ++saleCount;
        remainingStock[saleId] = stock;
        sales[saleId] = Sale({
            creator: caller(),
            token: token,
            price: price,
            cap: cap,
            raised: 0,
            deadline: deadline,
            finalized: false
        });
        emit SaleCreated(saleId, caller(), price, cap);
    }

    // Exact payment delta rejects fee-on-transfer tokens; runtime-only and
    // nonReentrant prevent callbacks from entering a second sale operation.
    // slither-disable-next-line reentrancy-balance
    function buy(uint256 saleId, uint256 amount) external onlyFromMyChain nonReentrant returns (uint256 out) {
        Sale storage s = sales[saleId];
        if (s.creator == address(0)) revert NoSuchSale(saleId);
        if (block.timestamp > s.deadline || s.finalized) revert SaleOver(saleId);

        uint256 room = s.cap - s.raised;
        if (amount > room) revert CapExceeded(amount, room);

        out = Math.mulDiv(amount, 1e18, s.price);
        if (out == 0) revert ZeroOutput();
        s.raised += amount;
        remainingStock[saleId] -= out;
        bought[saleId][caller()] += out;

        uint256 beforeBalance = paymentToken.balanceOf(address(this));
        spend(address(paymentToken), address(this), amount);
        if (paymentToken.balanceOf(address(this)) != beforeBalance + amount) revert UnsupportedToken();

        if (!s.token.transfer(caller(), out)) revert TransferFailed();
        emit Bought(saleId, caller(), amount, out);
    }

    /// @notice Closes the sale and releases the proceeds to the creator.
    /// @dev    Only after the deadline OR the cap. Leftover stock goes back with
    ///         it: tokens nobody bought do not belong to the contract, they
    ///         belong to whoever deposited them.
    function finalize(uint256 saleId) external onlyFromMyChain nonReentrant {
        Sale storage s = sales[saleId];
        if (s.creator == address(0)) revert NoSuchSale(saleId);
        if (s.finalized) revert AlreadyFinalized(saleId);
        if (caller() != s.creator) revert NotTheCreator(caller());
        if (block.timestamp <= s.deadline && s.raised < s.cap) revert SaleStillOpen(saleId);

        s.finalized = true;
        uint256 raised = s.raised;
        uint256 leftover = remainingStock[saleId];
        remainingStock[saleId] = 0;

        if (raised > 0 && !paymentToken.transfer(s.creator, raised)) revert TransferFailed();
        if (leftover > 0 && !s.token.transfer(s.creator, leftover)) revert TransferFailed();

        emit Finalized(saleId, raised);
    }
}
