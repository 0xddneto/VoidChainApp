// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IERC20 {
    function transfer(address to, uint256 value) external returns (bool);
    function transferFrom(address from, address to, uint256 value) external returns (bool);
    function balanceOf(address) external view returns (uint256);
}

interface IERC721 {
    function ownerOf(uint256 tokenId) external view returns (address);
    function transferFrom(address from, address to, uint256 tokenId) external;
}

/// @title VoidNftAmm
/// @notice A testnet pool where deeds and tokens trade at a fixed ratio.
///
/// @dev    THIS DOES NOT GO TO MAINNET. There the market is operated by a
///         third party and we only supply parameters. This contract exists so
///         the full flow can be tested before that — acquiring a deed, watching
///         the chain answer, selling it back.
///
///         The mechanics reproduce the ones that market uses, so the test means
///         something:
///
///         - `tokensPerNFT` is a FIXED RATIO, not a bonding curve. The price does
///           not rise as inventory drains; it is the same from the first to the
///           last. The NFT's floor is tied to the token, not formed by auction.
///
///         - Buying at RANDOM is cheaper than buying a SPECIFIC one. Choosing
///           which one you take is a service, and it costs more.
///
///         - Random comes out first-in-first-out: the earliest deposited is the
///           first to leave.
///
///         - The fee goes to the pool, not to the creator, and accumulates
///           visibly so the test shows where it would come from.
///
///         What we do NOT simulate: borrowing against a deed, staking tiers, or
///         escrow. Those do not affect what we need to test, which is the deed
///         changing hands and the chain answering to its new owner.
contract VoidNftAmm is ReentrancyGuard {
    IERC20 public immutable token;
    IERC721 public immutable collection;

    /// @notice The deployer chooses the one collection-mint contract once.
    ///         Pool purchases cannot bypass the wallet limit enforced there.
    address public immutable saleOperatorGovernor;
    address public saleOperator;
    bool public saleOperatorSet;

    /// @notice How many tokens one deed is worth. Immutable.
    uint256 public immutable tokensPerNFT;

    /// @notice Fee for a random buy / a sell, in basis points.
    uint256 public immutable randomFeeBps;
    /// @notice Fee for a specific buy. Always >= the random one.
    uint256 public immutable specificFeeBps;

    uint256 public constant BPS = 10_000;
    uint256 public constant MAX_FEE_BPS = 1_500; // 15%

    /// @notice O estoque de NFTs do pool, em ordem de chegada.
    uint256[] public inventory;
    /// @notice Where each tokenId sits in the inventory, +1. Zero means absent.
    mapping(uint256 tokenId => uint256) public slotOf;
    /// @notice The first item in inventory not yet sold. This is the FIFO head.
    uint256 public head;

    /// @notice Accrued fees. On the real market these go to the stakers.
    uint256 public feesAccrued;

    event Deposited(uint256 indexed tokenId, address indexed from, uint256 paid);
    event BatchDeposited(uint256 indexed firstTokenId, uint256 count, address indexed from, uint256 paid);
    event BoughtRandom(uint256 indexed tokenId, address indexed to, uint256 cost);
    event BoughtSpecific(uint256 indexed tokenId, address indexed to, uint256 cost);
    event SaleOperatorSet(address indexed operator);

    error FeeTooHigh(uint256 given, uint256 max);
    error SpecificBelowRandom();
    error EmptyInventory();
    error NotInInventory(uint256 tokenId);
    error PayoutBelowMinimum(uint256 got, uint256 wanted);
    error CostAboveMaximum(uint256 cost, uint256 limit);
    error TransferFailed();
    error ZeroAddress();
    error NotSaleOperator(address caller);
    error NotSaleOperatorGovernor(address caller);
    error SaleOperatorAlreadySet();

    constructor(
        IERC20 token_,
        IERC721 collection_,
        uint256 tokensPerNFT_,
        uint256 randomFeeBps_,
        uint256 specificFeeBps_,
        address saleOperatorGovernor_
    ) {
        if (
            address(token_) == address(0) || address(collection_) == address(0)
                || saleOperatorGovernor_ == address(0)
        ) {
            revert ZeroAddress();
        }
        if (randomFeeBps_ > MAX_FEE_BPS) revert FeeTooHigh(randomFeeBps_, MAX_FEE_BPS);
        if (specificFeeBps_ > MAX_FEE_BPS) revert FeeTooHigh(specificFeeBps_, MAX_FEE_BPS);
        if (specificFeeBps_ < randomFeeBps_) revert SpecificBelowRandom();

        token = token_;
        collection = collection_;
        saleOperatorGovernor = saleOperatorGovernor_;
        tokensPerNFT = tokensPerNFT_;
        randomFeeBps = randomFeeBps_;
        specificFeeBps = specificFeeBps_;
    }

    /// @notice Permanently routes collection sales through its mint contract.
    /// @dev The initial governor can make this call once, after the market app
    ///      exists. Before then no account can buy directly from this pool.
    function setSaleOperatorOnce(address operator_) external {
        if (msg.sender != saleOperatorGovernor) revert NotSaleOperatorGovernor(msg.sender);
        if (saleOperatorSet) revert SaleOperatorAlreadySet();
        if (operator_ == address(0)) revert ZeroAddress();
        saleOperatorSet = true;
        saleOperator = operator_;
        emit SaleOperatorSet(operator_);
    }

    // ---------------------------------------------------------------------
    // Leitura
    // ---------------------------------------------------------------------

    /// @notice How many NFTs the pool has to sell.
    function available() public view returns (uint256) {
        return inventory.length - head;
    }

    /// @notice What buying costs, with the fee already included.
    function priceToBuy(bool specific) public view returns (uint256) {
        uint256 fee = specific ? specificFeeBps : randomFeeBps;
        return tokensPerNFT + (tokensPerNFT * fee) / BPS;
    }

    /// @notice What you receive when selling, with the fee already deducted.
    function payoutToSell() public view returns (uint256) {
        return tokensPerNFT - (tokensPerNFT * randomFeeBps) / BPS;
    }

    /// @notice The next NFTs that would come out of a random buy.
    /// @dev    It exists so the interface can show what is for sale without
    ///         having to scan events.
    function peek(uint256 howMany) external view returns (uint256[] memory ids) {
        uint256 n = available();
        if (howMany > n) howMany = n;
        ids = new uint256[](howMany);
        for (uint256 i; i < howMany; ++i) ids[i] = inventory[head + i];
    }

    // ---------------------------------------------------------------------
    // Vender ao pool
    // ---------------------------------------------------------------------

    /// @notice Deposits an NFT into the pool and receives tokens.
    /// @param  minPayout The floor the seller accepts. Without it, a parameter
    ///         change between signing and executing would charge them the
    ///         difference.
    function sell(uint256 tokenId, uint256 minPayout) external nonReentrant returns (uint256 payout) {
        payout = payoutToSell();
        if (payout < minPayout) revert PayoutBelowMinimum(payout, minPayout);

        collection.transferFrom(msg.sender, address(this), tokenId);

        inventory.push(tokenId);
        slotOf[tokenId] = inventory.length; // +1, so that zero means "absent"
        feesAccrued += tokensPerNFT - payout;

        if (!token.transfer(msg.sender, payout)) revert TransferFailed();
        emit Deposited(tokenId, msg.sender, payout);
    }

    /// @notice Seeds a launch inventory in compact batches.
    /// @dev Keeps the same payout and accounting as `sell`, but avoids 1,111
    ///      separate deployment transactions. Every transfer remains an ERC-721
    ///      transfer from the caller, so the caller must approve this pool.
    function seed(uint256[] calldata tokenIds, uint256 minPayoutTotal)
        external
        nonReentrant
        returns (uint256 payout)
    {
        uint256 count = tokenIds.length;
        payout = payoutToSell() * count;
        if (payout < minPayoutTotal) revert PayoutBelowMinimum(payout, minPayoutTotal);

        for (uint256 i; i < count; ++i) {
            uint256 tokenId = tokenIds[i];
            collection.transferFrom(msg.sender, address(this), tokenId);
            inventory.push(tokenId);
            slotOf[tokenId] = inventory.length;
        }

        feesAccrued += (tokensPerNFT - payoutToSell()) * count;
        if (payout > 0 && !token.transfer(msg.sender, payout)) revert TransferFailed();
        emit BatchDeposited(count == 0 ? 0 : tokenIds[0], count, msg.sender, payout);
    }

    // ---------------------------------------------------------------------
    // Comprar do pool
    // ---------------------------------------------------------------------

    /// @notice Buys the next one in line. Cheaper than choosing.
    function buyRandom(uint256 maxCost) external nonReentrant returns (uint256 tokenId) {
        if (msg.sender != saleOperator) revert NotSaleOperator(msg.sender);
        if (available() == 0) revert EmptyInventory();

        uint256 cost = priceToBuy(false);
        if (cost > maxCost) revert CostAboveMaximum(cost, maxCost);

        tokenId = inventory[head];
        head++;
        slotOf[tokenId] = 0;
        feesAccrued += cost - tokensPerNFT;

        if (!token.transferFrom(msg.sender, address(this), cost)) revert TransferFailed();
        collection.transferFrom(address(this), msg.sender, tokenId);
        emit BoughtRandom(tokenId, msg.sender, cost);
    }

    /// @notice Buys a chosen NFT. Costs more — choosing is a service.
    /// @dev    The chosen one is pulled out of the middle of the queue by
    ///         swapping places with the first not-yet-sold item. That keeps the
    ///         queue contiguous without shifting everything — the cost is
    ///         constant, not linear.
    function buySpecific(uint256 tokenId, uint256 maxCost) external nonReentrant {
        if (msg.sender != saleOperator) revert NotSaleOperator(msg.sender);
        uint256 slot = slotOf[tokenId];
        if (slot == 0) revert NotInInventory(tokenId);

        uint256 cost = priceToBuy(true);
        if (cost > maxCost) revert CostAboveMaximum(cost, maxCost);

        uint256 idx = slot - 1;
        uint256 firstId = inventory[head];
        inventory[idx] = firstId;
        slotOf[firstId] = idx + 1;
        inventory[head] = tokenId;
        head++;
        slotOf[tokenId] = 0;

        feesAccrued += cost - tokensPerNFT;

        if (!token.transferFrom(msg.sender, address(this), cost)) revert TransferFailed();
        collection.transferFrom(address(this), msg.sender, tokenId);
        emit BoughtSpecific(tokenId, msg.sender, cost);
    }

    /// @notice Receives NFTs sent with `safeTransferFrom`.
    function onERC721Received(address, address, uint256, bytes calldata)
        external
        pure
        returns (bytes4)
    {
        return this.onERC721Received.selector;
    }
}
