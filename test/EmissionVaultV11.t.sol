// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {VoidEmissionVaultV11} from "../contracts/genesis/VoidEmissionVaultV11.sol";

contract EmissionTokenV11 {
    mapping(address => uint256) public balanceOf;
    function mint(address to, uint256 amount) external { balanceOf[to] += amount; }
    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

contract EmissionVaultV11Test is Test {
    address governor = address(0x6009);
    address recipient = address(0xBEEF);
    EmissionTokenV11 token;
    VoidEmissionVaultV11 vault;

    function setUp() public {
        token = new EmissionTokenV11();
        vault = new VoidEmissionVaultV11(governor, 2 days, 30 days, 1_000 ether);
        token.mint(address(vault), 10_000 ether);
        vm.warp(60 days);
    }

    function test_TimelockAndEpochCapBothBindGovernance() public {
        vm.startPrank(governor);
        vault.schedule(address(token), recipient, 700 ether, bytes32("a"));
        vault.schedule(address(token), recipient, 400 ether, bytes32("b"));
        vm.stopPrank();
        vm.expectRevert();
        vault.execute(address(token), recipient, 700 ether, bytes32("a"));
        vm.warp(block.timestamp + 2 days);
        vault.execute(address(token), recipient, 700 ether, bytes32("a"));
        vm.expectRevert();
        vault.execute(address(token), recipient, 400 ether, bytes32("b"));
        assertEq(token.balanceOf(recipient), 700 ether);
    }

    function test_NewEpochRestoresOnlyTheFixedCap() public {
        vm.prank(governor);
        vault.schedule(address(token), recipient, 1_000 ether, bytes32("a"));
        vm.warp(block.timestamp + 2 days);
        vault.execute(address(token), recipient, 1_000 ether, bytes32("a"));
        vm.warp(block.timestamp + 30 days);
        vm.prank(governor);
        vault.schedule(address(token), recipient, 1_000 ether, bytes32("b"));
        vm.warp(block.timestamp + 2 days);
        vault.execute(address(token), recipient, 1_000 ether, bytes32("b"));
        assertEq(token.balanceOf(recipient), 2_000 ether);
    }
}
