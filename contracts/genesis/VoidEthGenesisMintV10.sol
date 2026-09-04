// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {VoidEthGenesisMintV6, IVoidGenesisDeedV6, IVoidGenesisEscrowV6, IVoidEthPoolV6}
    from "./VoidEthGenesisMintV6.sol";

interface IMigratedDeedV10 {
    function totalSupply() external view returns (uint256);
    function ownerOf(uint256 id) external view returns (address);
}

/// @title VoidEthGenesisMintV10
/// @notice Resumes a testnet launch from an immutable snapshot without charging
///         existing Deed holders twice or recreating already-circulating VOID.
contract VoidEthGenesisMintV10 is VoidEthGenesisMintV6 {
    uint256 public immutable migratedSupply;
    bytes32 public immutable migrationOwnersHash;
    uint256 public immutable migrationVoidLiquidity;
    uint256 public immutable migrationEthLiquidity;
    bool public migrationFunded;

    event MigrationFunded(uint256 deeds, uint256 voidLiquidity, uint256 ethLiquidity);
    error InvalidSnapshot();
    error MigrationNotFunded();
    error MigrationAlreadyFunded();

    constructor(
        IVoidGenesisDeedV6 deed_,
        IVoidGenesisEscrowV6 escrow_,
        IVoidEthPoolV6 pool_,
        address payable paymaster_,
        address payable protocolTreasury_,
        uint256 price_,
        address[] memory holders,
        uint256 migrationVoidLiquidity_,
        uint256 migrationEthLiquidity_
    ) VoidEthGenesisMintV6(deed_, escrow_, pool_, paymaster_, protocolTreasury_, price_) {
        if (
            holders.length == 0 || holders.length > maxSupply || migrationVoidLiquidity_ == 0
                || migrationEthLiquidity_ == 0 || IMigratedDeedV10(address(deed_)).totalSupply() != holders.length
        ) revert InvalidSnapshot();
        for (uint256 i; i < holders.length; ++i) {
            if (holders[i] == address(0) || IMigratedDeedV10(address(deed_)).ownerOf(i + 1) != holders[i]) {
                revert InvalidSnapshot();
            }
            hasMinted[holders[i]] = true;
        }
        migratedSupply = holders.length;
        totalMinted = holders.length;
        migrationOwnersHash = keccak256(abi.encode(holders));
        migrationVoidLiquidity = migrationVoidLiquidity_;
        migrationEthLiquidity = migrationEthLiquidity_;
    }

    function fundMigration() external payable nonReentrant {
        if (migrationFunded) revert MigrationAlreadyFunded();
        if (msg.value != migrationEthLiquidity) revert WrongMintPrice(msg.value, migrationEthLiquidity);
        migrationFunded = true;
        pool.addGenesisLiquidity{value: msg.value}(migrationVoidLiquidity);
        emit MigrationFunded(migratedSupply, migrationVoidLiquidity, msg.value);
    }

    function mint() external payable override nonReentrant returns (uint256 id) {
        if (!migrationFunded) revert MigrationNotFunded();
        if (hasMinted[msg.sender]) revert MintLimitReached(msg.sender);
        if (totalMinted == maxSupply) revert SoldOut();
        if (msg.value != mintPriceWei) revert WrongMintPrice(msg.value, mintPriceWei);
        id = ++totalMinted;
        hasMinted[msg.sender] = true;
        deed.mint(msg.sender, id);
        uint256 lpEth = msg.value * LP_ETH_BPS / BPS;
        uint256 paymasterEth = msg.value * PAYMASTER_ETH_BPS / BPS;
        escrow.releaseLiquidity(VOID_TO_LP_PER_MINT);
        pool.addGenesisLiquidity{value: lpEth}(VOID_TO_LP_PER_MINT);
        _pay(paymaster, paymasterEth);
        _pay(protocolTreasury, msg.value - lpEth - paymasterEth);
        emit DeedMinted(msg.sender, id, msg.value);
        emit GenesisLiquiditySeeded(id, VOID_TO_LP_PER_MINT, lpEth);
        emit PaymasterFunded(id, paymasterEth);
        emit ProtocolFunded(id, msg.value - lpEth - paymasterEth);
    }

    function _pay(address payable to, uint256 amount) private {
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert EthTransferFailed(to, amount);
    }
}
