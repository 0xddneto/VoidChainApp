// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {ChainAppBase, IVoidChainAppRuntime} from "./ChainAppBase.sol";

interface IV4MarketToken {
    function transfer(address to, uint256 value) external returns (bool);
}

interface IV4MarketNft {
    function ownerOf(uint256 tokenId) external view returns (address);
    function transferFrom(address from, address to, uint256 tokenId) external;
}

/// @notice ERC-4494-compatible permit surface. Future VOID Deeds implement
/// this so an NFT listing is entirely signature-only, like an ERC-20 permit.
interface IV4MarketNftPermit {
    function permit(address spender, uint256 tokenId, uint256 deadline, bytes calldata signature) external;
}

/// @title VoidChainNftMarketV4
/// @notice Fixed-price, escrowed NFT market for one VOID Chain.
/// @dev The design deliberately starts with single-item fixed-price listings:
/// it has the familiar listing/buy/cancel behaviour of Seaport/OpenSea without
/// importing their broad arbitrary-order surface into a new runtime. Listings
/// escrow the NFT, so a purchase cannot fail because a seller transferred it
/// elsewhere after listing. Payments and the chain toll both use the signed
/// VOID route.
contract VoidChainNftMarketV4 is ChainAppBase, ReentrancyGuard {
    uint256 public constant BPS = 10_000;
    uint256 public constant MAX_FEE_BPS = 1_000;

    struct Listing {
        address seller;
        address collection;
        uint256 tokenId;
        uint256 price;
        bool active;
    }

    IV4MarketToken public immutable paymentToken;
    address public immutable feeRecipient;
    uint256 public immutable feeBps;
    uint256 public listingCount;
    mapping(uint256 listingId => Listing) public listings;

    event Listed(uint256 indexed listingId, address indexed seller, address indexed collection, uint256 tokenId, uint256 price);
    event Sold(uint256 indexed listingId, address indexed buyer, uint256 price, uint256 fee);
    event Cancelled(uint256 indexed listingId);

    error ZeroPrice();
    error FeeTooHigh(uint256 given, uint256 maximum);
    error NotTokenOwner(address owner, address expected);
    error NoSuchListing(uint256 listingId);
    error ListingClosed(uint256 listingId);
    error NotSeller(address caller);
    error InvalidRecipient();
    error TokenTransferFailed();

    constructor(
        IVoidChainAppRuntime runtime_,
        uint256 chainId_,
        IV4MarketToken paymentToken_,
        uint256 feeBps_,
        address feeRecipient_
    ) ChainAppBase(runtime_, chainId_) {
        if (address(paymentToken_) == address(0) || feeRecipient_ == address(0)) revert ZeroAddress();
        if (feeBps_ > MAX_FEE_BPS) revert FeeTooHigh(feeBps_, MAX_FEE_BPS);
        paymentToken = paymentToken_;
        feeBps = feeBps_;
        feeRecipient = feeRecipient_;
    }

    /// @notice Lists an ERC-721 after it has authorized the Runtime to move
    /// it. The NFT is transferred through the caller's signed nftSpends budget
    /// and held by this market gateway until sale or cancellation.
    function list(address collection, uint256 tokenId, uint256 price)
        external onlyFromMyChain nonReentrant returns (uint256 listingId)
    {
        if (price == 0) revert ZeroPrice();
        if (IV4MarketNft(collection).ownerOf(tokenId) != caller()) {
            revert NotTokenOwner(IV4MarketNft(collection).ownerOf(tokenId), caller());
        }
        spendNft(collection, address(this), tokenId);
        listingId = _openListing(collection, tokenId, price);
    }

    /// @notice Signature-only listing for ERC-4494 collections.
    /// @dev The permit approves the Runtime, not the market. The Runtime then
    /// applies the exact nftSpends budget attached to this very user request.
    function listWithPermit(
        address collection,
        uint256 tokenId,
        uint256 price,
        uint256 deadline,
        bytes calldata signature
    ) external onlyFromMyChain nonReentrant returns (uint256 listingId) {
        IV4MarketNftPermit(collection).permit(address(runtime), tokenId, deadline, signature);
        if (IV4MarketNft(collection).ownerOf(tokenId) != caller()) {
            revert NotTokenOwner(IV4MarketNft(collection).ownerOf(tokenId), caller());
        }
        if (price == 0) revert ZeroPrice();
        spendNft(collection, address(this), tokenId);
        listingId = _openListing(collection, tokenId, price);
    }

    function buy(uint256 listingId) external onlyFromMyChain nonReentrant {
        Listing storage listing = listings[listingId];
        if (listing.seller == address(0)) revert NoSuchListing(listingId);
        if (!listing.active) revert ListingClosed(listingId);
        listing.active = false;

        uint256 fee = (listing.price * feeBps) / BPS;
        spend(address(paymentToken), listing.seller, listing.price - fee);
        if (fee != 0) spend(address(paymentToken), feeRecipient, fee);
        IV4MarketNft(listing.collection).transferFrom(address(this), caller(), listing.tokenId);
        emit Sold(listingId, caller(), listing.price, fee);
    }

    function cancel(uint256 listingId) external onlyFromMyChain nonReentrant {
        Listing storage listing = listings[listingId];
        if (listing.seller == address(0)) revert NoSuchListing(listingId);
        if (!listing.active) revert ListingClosed(listingId);
        if (listing.seller != caller()) revert NotSeller(caller());
        listing.active = false;
        IV4MarketNft(listing.collection).transferFrom(address(this), listing.seller, listing.tokenId);
        emit Cancelled(listingId);
    }

    function _openListing(address collection, uint256 tokenId, uint256 price) private returns (uint256 listingId) {
        listingId = ++listingCount;
        listings[listingId] = Listing({ seller: caller(), collection: collection, tokenId: tokenId, price: price, active: true });
        emit Listed(listingId, caller(), collection, tokenId, price);
    }
}
