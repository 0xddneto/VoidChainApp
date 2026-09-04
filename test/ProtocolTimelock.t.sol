// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {VoidProtocolTimelock} from "../contracts/parent/VoidProtocolTimelock.sol";

contract TimelockTarget {
    uint256 public value;
    function setValue(uint256 next) external payable { value = next; }
}

contract ProtocolTimelockTest is Test {
    address internal proposer = address(0xA11CE);
    VoidProtocolTimelock internal timelock;
    TimelockTarget internal target;

    function setUp() public {
        timelock = new VoidProtocolTimelock(proposer, 2 days);
        target = new TimelockTarget();
    }

    function test_onlyProposerSchedulesAndNoOneExecutesEarly() public {
        bytes memory data = abi.encodeCall(TimelockTarget.setValue, (7));
        bytes32 salt = keccak256("set-seven");

        vm.expectRevert(abi.encodeWithSelector(VoidProtocolTimelock.NotProposer.selector, address(this)));
        timelock.schedule(address(target), 0, data, salt);

        vm.prank(proposer);
        timelock.schedule(address(target), 0, data, salt);
        vm.expectRevert();
        timelock.execute(address(target), 0, data, salt);

        vm.warp(block.timestamp + 2 days);
        timelock.execute(address(target), 0, data, salt);
        assertEq(target.value(), 7);
    }

    function test_cancelAndReplayAreRejected() public {
        bytes memory data = abi.encodeCall(TimelockTarget.setValue, (9));
        bytes32 salt = keccak256("cancelled");
        vm.startPrank(proposer);
        bytes32 operation = timelock.schedule(address(target), 0, data, salt);
        timelock.cancel(operation);
        vm.stopPrank();

        vm.warp(block.timestamp + 2 days);
        vm.expectRevert(abi.encodeWithSelector(VoidProtocolTimelock.NotScheduled.selector, operation));
        timelock.execute(address(target), 0, data, salt);
    }

    function test_expiredOperationCannotBeExecuted() public {
        bytes memory data = abi.encodeCall(TimelockTarget.setValue, (11));
        bytes32 salt = keccak256("expired");
        vm.prank(proposer);
        bytes32 operation = timelock.schedule(address(target), 0, data, salt);

        vm.warp(block.timestamp + 2 days + timelock.GRACE_PERIOD() + 1);
        vm.expectRevert();
        timelock.execute(address(target), 0, data, salt);
        assertEq(target.value(), 0);
        assertTrue(timelock.scheduled(operation) != 0);
    }
}
