// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ChainAppBase, IVoidChainAppRuntime} from "./ChainAppBase.sol";

interface IERC20 {
    function transfer(address to, uint256 value) external returns (bool);
    function transferFrom(address from, address to, uint256 value) external returns (bool);
}

interface IERC721 {
    function ownerOf(uint256 tokenId) external view returns (address);
    function transferFrom(address from, address to, uint256 tokenId) external;
}

/// @title ChainAppMarket
/// @notice An NFT market inside a chainapp: list, buy, cancel.
///
/// @dev    A REFERENCE APPLICATION, NOT PROTOCOL INFRASTRUCTURE.
///
///         Its usage profile is the third of the three we want to measure: the
///         DEX stresses arithmetic, the launchpad stresses state writes per
///         buyer, and here the bottleneck is the external call into a
///         third-party contract (the ERC-721) inside the toll's window.
///
///         THE NFT STAYS WITH THE SELLER until the sale. Escrowing the token in
///         the market would be simpler to write and worse for whoever lists: a
///         single defect here would be enough to trap everyone's collection.
///         Here the market only needs the approval, and a listing from someone
///         who already sold the NFT elsewhere simply fails at purchase time.
contract ChainAppMarket is ChainAppBase {
    IERC20 public immutable paymentToken;

    /// @notice The market's commission, in basis points.
    /// @dev    Immutable and fixed in the constructor. A market that can raise
    ///         the commission after you list charges whatever it likes to
    ///         whoever is already inside.
    uint256 public immutable feeBps;
    address public immutable feeRecipient;

    uint256 public constant MAX_FEE_BPS = 1_000; // 10%
    uint256 public constant BPS = 10_000;

    struct Listing {
        address seller;
        IERC721 collection;
        uint256 tokenId;
        uint256 price;
        bool active;
    }

    uint256 public listingCount;
    mapping(uint256 listingId => Listing) public listings;

    event Listed(
        uint256 indexed listingId, address indexed seller, address collection, uint256 tokenId, uint256 price
    );
    event Sold(uint256 indexed listingId, address indexed buyer, uint256 price, uint256 fee);
    event Cancelled(uint256 indexed listingId);

    error ZeroPrice();
    error FeeTooHigh(uint256 given, uint256 max);
    error NotTheOwner(address who, address owner);
    error NoSuchListing(uint256 listingId);
    error ListingClosed(uint256 listingId);
    error NotTheSeller(address who);
    error TransferFailed();

    constructor(
        IVoidChainAppRuntime runtime_,
        uint256 chainId_,
        IERC20 paymentToken_,
        uint256 feeBps_,
        address feeRecipient_
    ) ChainAppBase(runtime_, chainId_) {
        if (address(paymentToken_) == address(0) || feeRecipient_ == address(0)) {
            revert ZeroAddress();
        }
        if (feeBps_ > MAX_FEE_BPS) revert FeeTooHigh(feeBps_, MAX_FEE_BPS);
        paymentToken = paymentToken_;
        feeBps = feeBps_;
        feeRecipient = feeRecipient_;
    }

    function list(IERC721 collection, uint256 tokenId, uint256 price)
        external
        onlyFromMyChain
        returns (uint256 listingId)
    {
        if (price == 0) revert ZeroPrice();

        // Listing what is not yours pollutes the market with listings that
        // never settle. The check happens at listing time; the real one happens
        // at purchase, when the ERC-721's `transferFrom` fails if it is no
        // longer yours.
        address owner = collection.ownerOf(tokenId);
        if (owner != caller()) revert NotTheOwner(caller(), owner);

        listingId = ++listingCount;
        listings[listingId] = Listing({
            seller: caller(),
            collection: collection,
            tokenId: tokenId,
            price: price,
            active: true
        });
        emit Listed(listingId, caller(), address(collection), tokenId, price);
    }

    // Seller is authenticated by list(); caller cannot supply an arbitrary source.
    // This is an ERC-721 transfer of that exact listed ID, not an ERC-20 allowance pull.
    // slither-disable-next-line arbitrary-send-erc20
    function buy(uint256 listingId) external onlyFromMyChain {
        Listing storage l = listings[listingId];
        if (l.seller == address(0)) revert NoSuchListing(listingId);
        if (!l.active) revert ListingClosed(listingId);

        // Closes BEFORE any external call. The ERC-721 is a third-party
        // contract that can call back; a listing still open at that instant
        // would be buyable twice for the price of one.
        l.active = false;

        uint256 fee = (l.price * feeBps) / BPS;
        uint256 toSeller = l.price - fee;

        spend(address(paymentToken), l.seller, toSeller);
        if (fee > 0) spend(address(paymentToken), feeRecipient, fee);
        l.collection.transferFrom(l.seller, caller(), l.tokenId);

        emit Sold(listingId, caller(), l.price, fee);
    }

    function cancel(uint256 listingId) external onlyFromMyChain {
        Listing storage l = listings[listingId];
        if (l.seller == address(0)) revert NoSuchListing(listingId);
        if (!l.active) revert ListingClosed(listingId);
        if (caller() != l.seller) revert NotTheSeller(caller());

        l.active = false;
        emit Cancelled(listingId);
    }
}
