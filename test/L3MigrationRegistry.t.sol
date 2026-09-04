// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {VoidL3MigrationRegistry, IVoidL3Deed} from "../contracts/parent/VoidL3MigrationRegistry.sol";

contract L3RegistryDeed {
    mapping(uint256 => address) public ownerOf;
    function setOwner(uint256 tokenId, address owner) external { ownerOf[tokenId] = owner; }
}

contract L3MigrationRegistryTest is Test {
    L3RegistryDeed deed;
    VoidL3MigrationRegistry registry;
    address holder = address(0xA11CE);
    address buyer = address(0xB0B);

    function setUp() public {
        deed = new L3RegistryDeed();
        deed.setOwner(1, holder);
        deed.setOwner(2, buyer);
        registry = new VoidL3MigrationRegistry(IVoidL3Deed(address(deed)));
    }

    function test_HolderPlansActivatesAndRetires() public {
        bytes32 config = keccak256("audited-config");
        vm.prank(holder);
        registry.plan(1, 91_001, config);
        vm.prank(holder);
        registry.activate(1, address(0x1001), address(0x1002), keccak256("rpc"), keccak256("explorer"), config);
        (uint256 chainId,,,,,, VoidL3MigrationRegistry.Status status,) = registry.migrationOf(1);
        assertEq(chainId, 91_001);
        assertEq(uint256(status), uint256(VoidL3MigrationRegistry.Status.Live));
        vm.prank(holder);
        registry.retire(1);
        assertEq(registry.deedForChainId(91_001), 0);
    }

    function test_ChainIdCannotCollideAcrossDeeds() public {
        vm.prank(holder);
        registry.plan(1, 91_001, keccak256("one"));
        vm.expectRevert(abi.encodeWithSelector(VoidL3MigrationRegistry.ChainIdAlreadyReserved.selector, 91_001, 1));
        vm.prank(buyer);
        registry.plan(2, 91_001, keccak256("two"));
    }

    function test_DeedSaleTransfersMigrationAuthority() public {
        vm.prank(holder);
        registry.plan(1, 91_001, keccak256("one"));
        deed.setOwner(1, buyer);
        vm.expectRevert(abi.encodeWithSelector(VoidL3MigrationRegistry.NotDeedHolder.selector, holder, 1));
        vm.prank(holder);
        registry.retire(1);
        vm.prank(buyer);
        registry.retire(1);
    }

    function test_LiveEntryRequiresCompleteMatchingCommitment() public {
        bytes32 config = keccak256("one");
        vm.prank(holder);
        registry.plan(1, 91_001, config);
        vm.expectRevert(VoidL3MigrationRegistry.IncompleteLiveConfiguration.selector);
        vm.prank(holder);
        registry.activate(1, address(0x1001), address(0x1002), keccak256("rpc"), keccak256("explorer"), keccak256("changed"));
    }

    function test_RetiredOwnerCannotReleaseAnotherDeedsReusedId() public {
        vm.prank(holder);
        registry.plan(1, 91_001, keccak256("one"));
        vm.prank(holder);
        registry.retire(1);
        vm.prank(buyer);
        registry.plan(2, 91_001, keccak256("two"));
        vm.expectRevert(abi.encodeWithSelector(VoidL3MigrationRegistry.MigrationNotPlanned.selector, 1));
        vm.prank(holder);
        registry.retire(1);
        vm.prank(holder);
        registry.plan(1, 91_002, keccak256("new"));
        assertEq(registry.deedForChainId(91_001), 2);
    }
}
