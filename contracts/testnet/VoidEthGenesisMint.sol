// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IVoidGenesisDeed {
    function MAX_SUPPLY() external view returns (uint256);
    function mint(address to, uint256 tokenId) external;
    function sealMinting() external;
}

/// @title VoidEthGenesisMint
/// @notice The normal-ETH genesis sale for the 1,111 VoidChain Deeds.
/// @dev Genesis is intentionally the single exception to Void-sponsored usage:
/// a buyer pays ETH once to mint their Deed. That ETH creates the initial
/// liquidity and Paymaster reserve. Every later VoidChain app action uses the
/// signed VOID route instead of asking the wallet for ETH.
contract VoidEthGenesisMint is ReentrancyGuard {
    uint256 public constant BPS = 10_000;
    uint256 public constant PAYMASTER_BPS = 2_000;
    /// @dev Matches the 40% fixed VOID liquidity bucket, so the first pool
    /// starts at the same implied value as the ETH mint price.
    uint256 public constant LIQUIDITY_BPS = 4_000;
    uint256 public constant PROTOCOL_BPS = 4_000;

    IVoidGenesisDeed public immutable deed;
    address payable public immutable paymaster;
    address payable public immutable liquidityVault;
    address payable public immutable protocolTreasury;
    uint256 public immutable mintPriceWei;
    uint256 public immutable maxSupply;

    uint256 public totalMinted;
    uint256 public paymasterCredit;
    uint256 public liquidityCredit;
    uint256 public protocolCredit;
    mapping(address buyer => bool) public hasMinted;
    bool public mintingClosed;

    event DeedMinted(address indexed buyer, uint256 indexed deedId, uint256 paidWei);
    event PaymasterFunded(uint256 amount);
    event LiquidityFunded(uint256 amount);
    event ProtocolFunded(uint256 amount);
    event MintingSealed(uint256 totalMinted);

    error ZeroAddress();
    error ZeroMintPrice();
    error MintLimitReached(address buyer);
    error SoldOut();
    error WrongMintPrice(uint256 paid, uint256 expected);
    error NotSoldOut(uint256 minted, uint256 supply);
    error AlreadySealed();
    error NothingToRelease();
    error EthTransferFailed(address recipient, uint256 amount);

    constructor(
        IVoidGenesisDeed deed_,
        address payable paymaster_,
        address payable liquidityVault_,
        address payable protocolTreasury_,
        uint256 mintPriceWei_
    ) {
        if (
            address(deed_) == address(0) || paymaster_ == address(0)
                || liquidityVault_ == address(0) || protocolTreasury_ == address(0)
        ) revert ZeroAddress();
        if (mintPriceWei_ == 0) revert ZeroMintPrice();
        deed = deed_;
        paymaster = paymaster_;
        liquidityVault = liquidityVault_;
        protocolTreasury = protocolTreasury_;
        mintPriceWei = mintPriceWei_;
        maxSupply = deed_.MAX_SUPPLY();
    }

    /// @notice Mints exactly one Deed for this wallet in normal ETH.
    function mint() external payable nonReentrant returns (uint256 deedId) {
        if (hasMinted[msg.sender]) revert MintLimitReached(msg.sender);
        if (totalMinted == maxSupply) revert SoldOut();
        if (msg.value != mintPriceWei) revert WrongMintPrice(msg.value, mintPriceWei);

        deedId = ++totalMinted;
        hasMinted[msg.sender] = true;
        deed.mint(msg.sender, deedId);

        paymasterCredit += (msg.value * PAYMASTER_BPS) / BPS;
        liquidityCredit += (msg.value * LIQUIDITY_BPS) / BPS;
        protocolCredit += msg.value - ((msg.value * PAYMASTER_BPS) / BPS) - ((msg.value * LIQUIDITY_BPS) / BPS);
        emit DeedMinted(msg.sender, deedId, msg.value);
    }

    /// @notice Moves the immutable 20% genesis share into the gas reserve.
    /// @dev Permissionless; users can verify that no other destination exists.
    function fundPaymaster() external nonReentrant returns (uint256 amount) {
        amount = paymasterCredit;
        if (amount == 0) revert NothingToRelease();
        paymasterCredit = 0;
        _send(paymaster, amount);
        emit PaymasterFunded(amount);
    }

    /// @notice Releases only the fixed 40% pool seed to the liquidity vault.
    function fundLiquidity() external nonReentrant returns (uint256 amount) {
        amount = liquidityCredit;
        if (amount == 0) revert NothingToRelease();
        liquidityCredit = 0;
        _send(liquidityVault, amount);
        emit LiquidityFunded(amount);
    }

    /// @notice Releases only the fixed 20% protocol portion.
    function fundProtocol() external nonReentrant returns (uint256 amount) {
        amount = protocolCredit;
        if (amount == 0) revert NothingToRelease();
        protocolCredit = 0;
        _send(protocolTreasury, amount);
        emit ProtocolFunded(amount);
    }

    /// @notice Irreversibly closes issuance once all 1,111 Deeds are minted.
    function seal() external {
        if (mintingClosed) revert AlreadySealed();
        if (totalMinted != maxSupply) revert NotSoldOut(totalMinted, maxSupply);
        mintingClosed = true;
        deed.sealMinting();
        emit MintingSealed(totalMinted);
    }

    function _send(address payable recipient, uint256 amount) private {
        (bool ok,) = recipient.call{value: amount}("");
        if (!ok) revert EthTransferFailed(recipient, amount);
    }
}
