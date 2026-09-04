// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {VoidChainDeed} from "../contracts/parent/VoidChainDeed.sol";
import {VoidTokenV9} from "../contracts/genesis/VoidTokenV9.sol";
import {VoidGenesisEscrowV10} from "../contracts/genesis/VoidGenesisEscrowV10.sol";
import {IVoidEscrowToken} from "../contracts/genesis/VoidGenesisEscrowV6.sol";
import {VoidEthPoolV6, IVoidPoolToken} from "../contracts/genesis/VoidEthPoolV6.sol";
import {VoidEthGenesisMintV10} from "../contracts/genesis/VoidEthGenesisMintV10.sol";
import {IVoidGenesisDeedV6, IVoidGenesisEscrowV6, IVoidEthPoolV6}
    from "../contracts/genesis/VoidEthGenesisMintV6.sol";

contract GenesisMigrationV10Test is Test {
    VoidChainDeed deed;
    VoidTokenV9 token;
    VoidGenesisEscrowV10 escrow;
    VoidEthPoolV6 pool;
    VoidEthGenesisMintV10 mint;
    address payable pm = payable(address(100));
    address payable treasury = payable(address(200));
    address builder = address(300);
    address protocol = address(400);
    address market = address(500);
    address user = address(600);

    function setUp() public {
        vm.deal(address(this), 1 ether);
        escrow = new VoidGenesisEscrowV10(address(this));
        token = new VoidTokenV9(address(escrow), address(this));
        deed = new VoidChainDeed(46630000, address(this), treasury, 500);
        pool = new VoidEthPoolV6(IVoidPoolToken(address(token)), address(this), address(700));
        deed.mint(user, 1);
        address[] memory holders = new address[](1);
        holders[0] = user;
        mint = new VoidEthGenesisMintV10(
            IVoidGenesisDeedV6(address(deed)), IVoidGenesisEscrowV6(address(escrow)),
            IVoidEthPoolV6(address(pool)), pm, treasury, 0.001 ether, holders, 190_000 ether, 0.0004 ether
        );
        pool.setGenesisControllerOnce(address(mint));

        address[] memory recipients = new address[](3);
        recipients[0] = address(pool);
        recipients[1] = user;
        recipients[2] = market;
        uint256[] memory amounts = new uint256[](3);
        amounts[0] = 190_000 ether;
        amounts[1] = 10_000 ether;
        amounts[2] = 500_000 ether;
        uint256[] memory migratedNfts = new uint256[](1);
        migratedNfts[0] = 1;
        escrow.configureMigrationOnce(
            VoidGenesisEscrowV10.MigrationConfig({
                token: IVoidEscrowToken(address(token)), launch: address(mint), liquidityPool: address(pool),
                builderVault: builder, protocolVault: protocol, lpAlreadyReleased: 200_000 ether,
                nftAlreadyReleased: 500_000 ether
            }), recipients, amounts, migratedNfts
        );
        escrow.setNftAmmOnce(market);
        deed.transferMinter(address(mint));
    }

    function test_preservesSupplyAndImportsWithoutDuplicatingBuckets() public view {
        assertEq(token.balanceOf(address(pool)), 190_000 ether);
        assertEq(token.balanceOf(user), 10_000 ether);
        assertEq(token.balanceOf(market), 500_000 ether);
        assertEq(token.balanceOf(address(escrow)), 777_000_000 ether);
        assertEq(escrow.lpReleased(), 200_000 ether);
        assertEq(escrow.nftAmmReleased(), 500_000 ether);
        assertTrue(escrow.deedReleased(1));
        assertEq(token.totalSupply(), 1_000_000_000 ether);
    }

    function test_resumesPoolAndNextMintAtTheFixedRatio() public {
        mint.fundMigration{value: 0.0004 ether}();
        assertEq(pool.reserveVoid(), 190_000 ether);
        assertEq(pool.reserveEth(), 0.0004 ether);

        address buyer = address(800);
        vm.deal(buyer, 0.001 ether);
        vm.prank(buyer);
        assertEq(mint.mint{value: 0.001 ether}(), 2);
        assertEq(pool.reserveVoid(), 390_000 ether);
        assertEq(pool.reserveEth(), 0.0008 ether);
    }

    function test_rejectsUnbalancedImport() public {
        VoidGenesisEscrowV10 otherEscrow = new VoidGenesisEscrowV10(address(this));
        VoidTokenV9 otherToken = new VoidTokenV9(address(otherEscrow), address(this));
        address[] memory recipients = new address[](1);
        recipients[0] = user;
        uint256[] memory amounts = new uint256[](1);
        amounts[0] = 1 ether;
        uint256[] memory noNfts = new uint256[](0);
        vm.expectRevert(
            abi.encodeWithSelector(VoidGenesisEscrowV10.InvalidMigrationAccounting.selector, 1 ether, 2 ether)
        );
        otherEscrow.configureMigrationOnce(
            VoidGenesisEscrowV10.MigrationConfig({
                token: IVoidEscrowToken(address(otherToken)), launch: address(1), liquidityPool: address(2),
                builderVault: address(3), protocolVault: address(4), lpAlreadyReleased: 2 ether,
                nftAlreadyReleased: 0
            }), recipients, amounts, noNfts
        );
    }
}
