// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {ChainAppBase, IVoidChainAppRuntime} from "../apps/ChainAppBase.sol";

interface IVoidGenesisEscrowV6 {
    function releaseNftValue(uint256 deedId, address to) external;
    function deedReleased(uint256 deedId) external view returns (bool);
}

interface IVoidGenesisTokenV6 {
    function transfer(address to, uint256 amount) external returns (bool);
}

interface IVoidGenesisDeedV6 {
    function ownerOf(uint256 tokenId) external view returns (address);
    function transferFrom(address from, address to, uint256 tokenId) external;
    function permit(
        address spender,
        uint256 tokenId,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external;
}

/// @title VoidGenesisNftAmmV6
/// @notice The collection's VOID/NFT inventory market, running as an app of
/// one VoidChain rather than as an ETH-priced side contract.
/// @dev A Deed entering the vault releases its fixed 500,000 VOID backing from
/// the immutable genesis escrow exactly once. Buyer and seller actions are
/// runtime-only: their signed VOID budget pays both this market and the chain
/// transaction fee; no ERC-20 approval transaction is required.
contract VoidGenesisNftAmmV6 is ChainAppBase, ReentrancyGuard {
    uint256 public constant BPS = 10_000;
    uint256 public constant VOID_PER_DEED = 500_000 ether;

    /// @notice Published at genesis and immutable. Random inventory is cheaper
    /// than choosing an exact Deed; the 0.5% protocol part is separated in both.
    uint256 public constant RANDOM_FEE_BPS = 100; // 1.00%
    uint256 public constant SPECIFIC_FEE_BPS = 200; // 2.00%
    uint256 public constant PROTOCOL_CUT_BPS = 50; // 0.50%
    uint256 public constant SELL_FEE_BPS = 150; // 1.50%

    IVoidGenesisTokenV6 public immutable voidToken;
    IVoidGenesisDeedV6 public immutable deed;
    IVoidGenesisEscrowV6 public immutable escrow;
    address public immutable protocolTreasury;

    uint256[] private _inventory;
    mapping(uint256 deedId => uint256 inventoryIndexPlusOne) public inventoryIndexPlusOne;

    event Deposited(uint256 indexed deedId, address indexed seller, uint256 sellerReceives, uint256 protocolCut);
    event RandomBought(uint256 indexed deedId, address indexed buyer, uint256 paid, uint256 protocolCut);
    event SpecificBought(uint256 indexed deedId, address indexed buyer, uint256 paid, uint256 protocolCut);

    error InvalidDeed(uint256 deedId);
    error DeedNotInVault(uint256 deedId);
    error DeedAlreadyInVault(uint256 deedId);
    error PriceAboveLimit(uint256 quote, uint256 maximum);
    error NotDeedOwner(uint256 deedId, address owner, address caller);
    error TokenTransferFailed();

    constructor(
        IVoidChainAppRuntime runtime_,
        uint256 chainId_,
        IVoidGenesisTokenV6 voidToken_,
        IVoidGenesisDeedV6 deed_,
        IVoidGenesisEscrowV6 escrow_,
        address protocolTreasury_
    ) ChainAppBase(runtime_, chainId_) {
        if (
            address(voidToken_) == address(0) || address(deed_) == address(0)
                || address(escrow_) == address(0) || protocolTreasury_ == address(0)
        ) revert ZeroAddress();
        voidToken = voidToken_;
        deed = deed_;
        escrow = escrow_;
        protocolTreasury = protocolTreasury_;
    }

    function inventoryCount() external view returns (uint256) {
        return _inventory.length;
    }

    function inventoryAt(uint256 index) external view returns (uint256) {
        return _inventory[index];
    }

    function randomBuyQuote() public pure returns (uint256) {
        return VOID_PER_DEED + _fee(VOID_PER_DEED, RANDOM_FEE_BPS);
    }

    function specificBuyQuote() public pure returns (uint256) {
        return VOID_PER_DEED + _fee(VOID_PER_DEED, SPECIFIC_FEE_BPS);
    }

    function sellQuote() public pure returns (uint256) {
        return VOID_PER_DEED - _fee(VOID_PER_DEED, SELL_FEE_BPS);
    }

    /// @notice Deposits a Deed into the pool using its ERC-4494 signature.
    /// @dev The permit approves the Runtime for this exact Deed and the Runtime
    /// immediately consumes it from the caller's signed NFT budget.
    function sellWithPermit(
        uint256 deedId,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external onlyFromMyChain nonReentrant {
        if (deedId == 0 || deedId > 1111) revert InvalidDeed(deedId);
        if (inventoryIndexPlusOne[deedId] != 0) revert DeedAlreadyInVault(deedId);
        address owner = deed.ownerOf(deedId);
        if (owner != caller()) revert NotDeedOwner(deedId, owner, caller());

        deed.permit(address(runtime), deedId, deadline, v, r, s);
        spendNft(address(deed), address(this), deedId);
        _add(deedId);

        // Release backing once. Later buyers return principal to this vault,
        // and that existing liquidity pays subsequent sellers. Never request
        // a second escrow release for a Deed that has already circulated.
        if (!escrow.deedReleased(deedId)) {
            escrow.releaseNftValue(deedId, address(this));
        }

        uint256 protocolCut = _fee(VOID_PER_DEED, PROTOCOL_CUT_BPS);
        uint256 payout = sellQuote();
        if (!voidToken.transfer(caller(), payout)) revert TokenTransferFailed();
        if (protocolCut != 0 && !voidToken.transfer(protocolTreasury, protocolCut)) {
            revert TokenTransferFailed();
        }
        emit Deposited(deedId, caller(), payout, protocolCut);
    }

    /// @notice Buys a pseudo-random vault Deed. The client reads the current
    /// quote and signs this maximum; no random selection is used as an oracle.
    function buyRandom(uint256 maxVoidIn) external onlyFromMyChain nonReentrant returns (uint256 deedId) {
        uint256 length = _inventory.length;
        if (length == 0) revert DeedNotInVault(0);
        uint256 quote = randomBuyQuote();
        if (quote > maxVoidIn) revert PriceAboveLimit(quote, maxVoidIn);

        // It is intentionally only a distribution mechanism, not a source of
        // economic randomness. The current sender cannot choose the result.
        uint256 index = uint256(keccak256(abi.encodePacked(block.prevrandao, block.number, caller()))) % length;
        deedId = _inventory[index];
        _remove(deedId);
        spend(address(voidToken), address(this), quote);
        _sendDeedAndProtocolCut(deedId, quote, caller(), RANDOM_FEE_BPS);
        emit RandomBought(deedId, caller(), quote, _fee(VOID_PER_DEED, PROTOCOL_CUT_BPS));
    }

    /// @notice Buys a chosen Deed held in the vault at the published snipe fee.
    function buySpecific(uint256 deedId, uint256 maxVoidIn) external onlyFromMyChain nonReentrant {
        if (inventoryIndexPlusOne[deedId] == 0) revert DeedNotInVault(deedId);
        uint256 quote = specificBuyQuote();
        if (quote > maxVoidIn) revert PriceAboveLimit(quote, maxVoidIn);

        _remove(deedId);
        spend(address(voidToken), address(this), quote);
        _sendDeedAndProtocolCut(deedId, quote, caller(), SPECIFIC_FEE_BPS);
        emit SpecificBought(deedId, caller(), quote, _fee(VOID_PER_DEED, PROTOCOL_CUT_BPS));
    }

    function _sendDeedAndProtocolCut(uint256 deedId, uint256 quote, address buyer, uint256 feeBps) private {
        // The protocol cut is carved out of the published trade fee. The rest
        // stays as VOID liquidity in this market, not in an admin wallet.
        uint256 protocolCut = _fee(VOID_PER_DEED, PROTOCOL_CUT_BPS);
        if (protocolCut != 0 && !voidToken.transfer(protocolTreasury, protocolCut)) {
            revert TokenTransferFailed();
        }
        deed.transferFrom(address(this), buyer, deedId);
        // `feeBps` is deliberately consumed in the function signature to make
        // the selected published fee explicit in the execution trace.
        feeBps;
        quote;
    }

    function _add(uint256 deedId) private {
        _inventory.push(deedId);
        inventoryIndexPlusOne[deedId] = _inventory.length;
    }

    function _remove(uint256 deedId) private {
        uint256 indexPlusOne = inventoryIndexPlusOne[deedId];
        if (indexPlusOne == 0) revert DeedNotInVault(deedId);
        uint256 index = indexPlusOne - 1;
        uint256 last = _inventory.length - 1;
        if (index != last) {
            uint256 moved = _inventory[last];
            _inventory[index] = moved;
            inventoryIndexPlusOne[moved] = index + 1;
        }
        _inventory.pop();
        delete inventoryIndexPlusOne[deedId];
    }

    function _fee(uint256 amount, uint256 feeBps) private pure returns (uint256) {
        return (amount * feeBps) / BPS;
    }
}
