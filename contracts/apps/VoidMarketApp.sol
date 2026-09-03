// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {ChainAppBase, IVoidChainAppRuntime} from "./ChainAppBase.sol";

interface IMarketVoidToken {
    function approve(address spender, uint256 value) external returns (bool);
}

interface IMarketDeed {
    function transferFrom(address from, address to, uint256 tokenId) external;
}

interface IVoidDeedMarket {
    function token() external view returns (address);
    function collection() external view returns (address);
    function available() external view returns (uint256);
    function priceToBuy(bool specific) external view returns (uint256);
    function buyRandom(uint256 maxCost) external returns (uint256 tokenId);
}

/// @title VoidMarketApp
/// @notice The collection market as a paid app of one VOID Chain.
///
/// @dev The user never gives the AMM an approval. The app may only be reached
///      through its registered chain runtime, which opens a one-call VOID
///      budget signed by that user. It then grants the AMM an exact, temporary
///      approval, receives one deed and transfers that exact deed to the real
///      caller. There is no arbitrary target, token or recipient supplied by a
///      relayer.
contract VoidMarketApp is ChainAppBase, ReentrancyGuard {
    IMarketVoidToken public immutable voidToken;
    IVoidDeedMarket public immutable market;
    IMarketDeed public immutable deed;

    event RandomDeedBought(address indexed buyer, uint256 indexed deedId, uint256 cost);

    error MarketZeroAddress();
    error MarketTokenMismatch(address expected, address actual);
    error MarketCollectionMismatch(address expected, address actual);
    error CostAboveMaximum(uint256 cost, uint256 maximum);
    error EmptyMarket();
    error TokenApprovalFailed();

    constructor(
        IVoidChainAppRuntime runtime_,
        uint256 chainId_,
        IMarketVoidToken voidToken_,
        IVoidDeedMarket market_,
        IMarketDeed deed_
    ) ChainAppBase(runtime_, chainId_) {
        if (
            address(voidToken_) == address(0) || address(market_) == address(0)
                || address(deed_) == address(0)
        ) revert MarketZeroAddress();
        if (market_.token() != address(voidToken_)) {
            revert MarketTokenMismatch(address(voidToken_), market_.token());
        }
        if (market_.collection() != address(deed_)) {
            revert MarketCollectionMismatch(address(deed_), market_.collection());
        }
        voidToken = voidToken_;
        market = market_;
        deed = deed_;
    }

    /// @notice Current random-deed quote in VOID and the stock available.
    function quoteRandom() external view returns (uint256 cost, uint256 available) {
        return (market.priceToBuy(false), market.available());
    }

    /// @notice Buys the next pool deed for the actual runtime caller.
    /// @param maxCost Maximum VOID price the buyer signed, including the market fee.
    /// @dev `maxCost` is inside the signed call data. A relayer cannot raise it
    ///      between the wallet prompt and settlement, just as it cannot alter a
    ///      swap's slippage setting.
    function buyRandom(uint256 maxCost)
        external
        onlyFromMyChain
        nonReentrant
        returns (uint256 deedId)
    {
        uint256 available = market.available();
        if (available == 0) revert EmptyMarket();

        uint256 cost = market.priceToBuy(false);
        if (cost > maxCost) revert CostAboveMaximum(cost, maxCost);

        // `spend` can only take the amount in this user's signed runtime
        // budget. It pulls to this app, never straight to an arbitrary target.
        spend(address(voidToken), address(this), cost);

        // Reset first and after use. This supports conservative ERC-20s and
        // guarantees the AMM retains no allowance once this call ends.
        if (!voidToken.approve(address(market), 0)) revert TokenApprovalFailed();
        if (!voidToken.approve(address(market), cost)) revert TokenApprovalFailed();
        deedId = market.buyRandom(cost);
        if (!voidToken.approve(address(market), 0)) revert TokenApprovalFailed();

        // The AMM returned the deed to this app because it was the caller. Send
        // only that returned id to the runtime's authenticated user.
        deed.transferFrom(address(this), caller(), deedId);
        emit RandomDeedBought(caller(), deedId, cost);
    }
}
