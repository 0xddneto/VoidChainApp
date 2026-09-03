// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface ICollectionMarketToken {
    function approve(address spender, uint256 value) external returns (bool);
    function transferFrom(address from, address to, uint256 value) external returns (bool);
}

interface ICollectionMarketDeed {
    function transferFrom(address from, address to, uint256 tokenId) external;
}

interface ICollectionMarketPool {
    function token() external view returns (address);
    function collection() external view returns (address);
    function available() external view returns (uint256);
    function priceToBuy(bool specific) external view returns (uint256);
    function buyRandom(uint256 maxCost) external returns (uint256 tokenId);
}

/// @title VoidCollectionMarket
/// @notice The one-per-wallet deed mint, deliberately outside every VOID Chain.
///
/// @dev The collection must not need an already-active deed to sell its first
///      deed. The Paymaster is the sole caller and gives this contract an exact,
///      one-call VOID allowance. It can buy only the next pool deed and sends it
///      only to the signed buyer; it cannot be used as a general token router.
contract VoidCollectionMarket is ReentrancyGuard {
    ICollectionMarketToken public immutable voidToken;
    ICollectionMarketPool public immutable pool;
    ICollectionMarketDeed public immutable deed;
    address public immutable paymaster;

    mapping(address buyer => bool) public hasMinted;

    event RandomDeedMinted(address indexed buyer, uint256 indexed deedId, uint256 cost);

    error ZeroAddress();
    error NotPaymaster(address caller);
    error TokenMismatch(address expected, address actual);
    error CollectionMismatch(address expected, address actual);
    error MintLimitReached(address buyer);
    error EmptyMarket();
    error CostAboveMaximum(uint256 cost, uint256 maximum);
    error TokenApprovalFailed();
    error TokenPullFailed();

    constructor(
        ICollectionMarketToken voidToken_,
        ICollectionMarketPool pool_,
        ICollectionMarketDeed deed_,
        address paymaster_
    ) {
        if (
            address(voidToken_) == address(0) || address(pool_) == address(0)
                || address(deed_) == address(0) || paymaster_ == address(0)
        ) revert ZeroAddress();
        if (pool_.token() != address(voidToken_)) {
            revert TokenMismatch(address(voidToken_), pool_.token());
        }
        if (pool_.collection() != address(deed_)) {
            revert CollectionMismatch(address(deed_), pool_.collection());
        }
        voidToken = voidToken_;
        pool = pool_;
        deed = deed_;
        paymaster = paymaster_;
    }

    modifier onlyPaymaster() {
        if (msg.sender != paymaster) revert NotPaymaster(msg.sender);
        _;
    }

    function quoteRandom() external view returns (uint256 cost, uint256 available) {
        return (pool.priceToBuy(false), pool.available());
    }

    /// @notice Settles the exact purchase signed by `buyer`.
    /// @dev Only the Paymaster can call this, and its per-call allowance is
    ///      removed again by the Paymaster immediately after this returns.
    function buyRandomFor(address buyer, uint256 maxCost)
        external
        onlyPaymaster
        nonReentrant
        returns (uint256 deedId)
    {
        if (hasMinted[buyer]) revert MintLimitReached(buyer);
        if (pool.available() == 0) revert EmptyMarket();

        uint256 cost = pool.priceToBuy(false);
        if (cost > maxCost) revert CostAboveMaximum(cost, maxCost);

        // The Mint Paymaster opens this exact allowance immediately before
        // calling us. Pulling inside this frame matters: if anything below
        // reverts, this transfer and the allowance consumption both revert too.
        if (!voidToken.transferFrom(msg.sender, address(this), cost)) revert TokenPullFailed();
        if (!voidToken.approve(address(pool), 0)) revert TokenApprovalFailed();
        if (!voidToken.approve(address(pool), cost)) revert TokenApprovalFailed();
        deedId = pool.buyRandom(cost);
        if (!voidToken.approve(address(pool), 0)) revert TokenApprovalFailed();

        deed.transferFrom(address(this), buyer, deedId);
        hasMinted[buyer] = true;
        emit RandomDeedMinted(buyer, deedId, cost);
    }
}
