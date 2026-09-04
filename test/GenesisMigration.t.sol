// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;
import {Test} from "forge-std/Test.sol";
import {VoidChainDeed} from "../contracts/parent/VoidChainDeed.sol";
import {VoidTokenV6} from "../contracts/genesis/VoidTokenV6.sol";
import {VoidGenesisEscrowV6, IVoidEscrowToken} from "../contracts/genesis/VoidGenesisEscrowV6.sol";
import {VoidEthPoolV6, IVoidPoolToken} from "../contracts/genesis/VoidEthPoolV6.sol";
import {VoidEthGenesisMintV7} from "../contracts/genesis/VoidEthGenesisMintV7.sol";
import {VoidEthGenesisMintV6, IVoidGenesisDeedV6, IVoidGenesisEscrowV6, IVoidEthPoolV6} from "../contracts/genesis/VoidEthGenesisMintV6.sol";

contract GenesisMigrationTest is Test {
    VoidChainDeed deed;
    VoidTokenV6 token;
    VoidGenesisEscrowV6 escrow;
    VoidEthPoolV6 pool;
    VoidEthGenesisMintV7 mint;
    address payable pm = payable(address(100));
    address payable treasury = payable(address(200));
    address[] holders;

    function setUp() public {
        vm.deal(address(this), 1 ether);
        escrow = new VoidGenesisEscrowV6(address(this));
        token = new VoidTokenV6(address(escrow));
        deed = new VoidChainDeed(46630000, address(this), treasury, 500);
        pool = new VoidEthPoolV6(IVoidPoolToken(address(token)), address(this), address(300));
        for (uint256 i = 1; i <= 5; ++i) {
            holders.push(address(uint160(1000+i)));
            deed.mint(holders[i-1], i);
        }
        mint = _newMint(holders);
        pool.setGenesisControllerOnce(address(mint));
        escrow.configureOnce(IVoidEscrowToken(address(token)), address(mint), address(pool), address(400), address(500));
        deed.transferMinter(address(mint));
    }
    function _newMint(address[] memory owners) private returns (VoidEthGenesisMintV7) {
        return new VoidEthGenesisMintV7(IVoidGenesisDeedV6(address(deed)),IVoidGenesisEscrowV6(address(escrow)),IVoidEthPoolV6(address(pool)),pm,treasury,0.001 ether,owners);
    }
    function test_importSupplyOwnershipAndFunding() public {
        assertEq(mint.totalMinted(),5);
        for(uint256 i=1;i<=5;i++) {assertEq(deed.ownerOf(i),holders[i-1]);assertTrue(mint.hasMinted(holders[i-1]));}
        mint.fundMigration{value:0.005 ether}();
        assertEq(pool.reserveVoid(),1_000_000 ether);
        assertEq(pool.reserveEth(),0.002 ether);
        assertEq(pm.balance,0.001 ether);
        assertEq(treasury.balance,0.002 ether);
        assertEq(token.totalSupply(),1_000_000_000 ether);
        vm.expectRevert(VoidEthGenesisMintV7.MigrationAlreadyFunded.selector);
        mint.fundMigration{value:0.005 ether}();
    }
    function test_publicMintRequiresFunding() public {
        vm.expectRevert(VoidEthGenesisMintV7.MigrationNotFunded.selector);
        mint.mint{value:0.001 ether}();
    }
    function test_exactMigrationFundingOnly() public {
        vm.expectRevert(abi.encodeWithSelector(VoidEthGenesisMintV6.WrongMintPrice.selector,0.004 ether,0.005 ether));
        mint.fundMigration{value:0.004 ether}();
        assertFalse(mint.migrationFunded());
        assertEq(pool.reserveVoid(),0);
    }
    function test_nextMintAndOnePerWallet() public {
        mint.fundMigration{value:0.005 ether}();
        address buyer=address(600);vm.deal(buyer,0.01 ether);
        vm.prank(buyer);assertEq(mint.mint{value:0.001 ether}(),6);
        assertEq(deed.ownerOf(6),buyer);
        assertEq(pool.reserveVoid(),1_200_000 ether);
        vm.expectRevert(abi.encodeWithSelector(VoidEthGenesisMintV6.MintLimitReached.selector,buyer));
        vm.prank(buyer);mint.mint{value:0.001 ether}();
    }
    function test_rejectSnapshotWrongOwner() public {
        holders[0]=address(900);
        vm.expectRevert(VoidEthGenesisMintV7.InvalidSnapshot.selector);
        _newMint(holders);
    }
}
