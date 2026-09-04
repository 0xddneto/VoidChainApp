// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IVoidGenesisDeedV6 {
    function MAX_SUPPLY() external view returns (uint256);
    function mint(address to, uint256 tokenId) external;
    function sealMinting() external;
}

interface IVoidGenesisEscrowV6 {
    function releaseLiquidity(uint256 amount) external;
}

interface IVoidEthPoolV6 {
    function addGenesisLiquidity(uint256 voidAmount) external payable returns (uint256 liquidity);
}

/// @title VoidEthGenesisMintV6
/// @notice One-ETH-mint-per-wallet collection genesis that seeds a locked
/// VOID/ETH pool and the Paymaster atomically on every successful mint.
contract VoidEthGenesisMintV6 is ReentrancyGuard {
    uint256 public constant BPS = 10_000;
    uint256 public constant LP_ETH_BPS = 4_000;
    uint256 public constant PAYMASTER_ETH_BPS = 2_000;
    uint256 public constant PROTOCOL_ETH_BPS = 4_000;
    uint256 public constant VOID_TO_LP_PER_MINT = 200_000e18;

    IVoidGenesisDeedV6 public immutable deed;
    IVoidGenesisEscrowV6 public immutable escrow;
    IVoidEthPoolV6 public immutable pool;
    address payable public immutable paymaster;
    address payable public immutable protocolTreasury;
    uint256 public immutable mintPriceWei;
    uint256 public immutable maxSupply;

    uint256 public totalMinted;
    mapping(address buyer => bool) public hasMinted;
    bool public mintingClosed;

    event DeedMinted(address indexed buyer, uint256 indexed deedId, uint256 paidWei);
    event GenesisLiquiditySeeded(uint256 indexed deedId, uint256 voidAmount, uint256 ethAmount);
    event PaymasterFunded(uint256 indexed deedId, uint256 amount);
    event ProtocolFunded(uint256 indexed deedId, uint256 amount);
    event MintingSealed(uint256 totalMinted);

    error ZeroAddress();
    error ZeroMintPrice();
    error MintLimitReached(address buyer);
    error SoldOut();
    error WrongMintPrice(uint256 paid, uint256 expected);
    error NotSoldOut(uint256 minted, uint256 supply);
    error AlreadySealed();
    error EthTransferFailed(address recipient, uint256 amount);

    constructor(
        IVoidGenesisDeedV6 deed_,
        IVoidGenesisEscrowV6 escrow_,
        IVoidEthPoolV6 pool_,
        address payable paymaster_,
        address payable protocolTreasury_,
        uint256 mintPriceWei_
    ) {
        if (
            address(deed_) == address(0) || address(escrow_) == address(0) || address(pool_) == address(0)
                || paymaster_ == address(0) || protocolTreasury_ == address(0)
        ) revert ZeroAddress();
        if (mintPriceWei_ == 0) revert ZeroMintPrice();
        deed = deed_;
        escrow = escrow_;
        pool = pool_;
        paymaster = paymaster_;
        protocolTreasury = protocolTreasury_;
        mintPriceWei = mintPriceWei_;
        maxSupply = deed_.MAX_SUPPLY();
    }

    /// @notice Normal ETH genesis purchase. All three ETH destinations and the
    /// matching VOID liquidity addition settle atomically in this call.
    function mint() external payable virtual nonReentrant returns (uint256 deedId) {
        if (hasMinted[msg.sender]) revert MintLimitReached(msg.sender);
        if (totalMinted == maxSupply) revert SoldOut();
        if (msg.value != mintPriceWei) revert WrongMintPrice(msg.value, mintPriceWei);

        deedId = ++totalMinted;
        hasMinted[msg.sender] = true;
        deed.mint(msg.sender, deedId);

        uint256 lpEth = (msg.value * LP_ETH_BPS) / BPS;
        uint256 paymasterEth = (msg.value * PAYMASTER_ETH_BPS) / BPS;
        uint256 protocolEth = msg.value - lpEth - paymasterEth;
        escrow.releaseLiquidity(VOID_TO_LP_PER_MINT);
        pool.addGenesisLiquidity{value: lpEth}(VOID_TO_LP_PER_MINT);
        _send(paymaster, paymasterEth);
        _send(protocolTreasury, protocolEth);

        emit DeedMinted(msg.sender, deedId, msg.value);
        emit GenesisLiquiditySeeded(deedId, VOID_TO_LP_PER_MINT, lpEth);
        emit PaymasterFunded(deedId, paymasterEth);
        emit ProtocolFunded(deedId, protocolEth);
    }

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
