// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {VoidTokenV9} from "../contracts/genesis/VoidTokenV9.sol";

contract VoidTokenV9Test is Test {
    address private constant ESCROW = address(0xE5C);
    address private constant RUNTIME = address(0xA11);
    address private constant PAYMASTER = address(0xA12);
    address private constant USER = address(0xB0B);
    VoidTokenV9 private token;

    function setUp() public {
        token = new VoidTokenV9(ESCROW, address(this));
        vm.prank(ESCROW);
        token.transfer(USER, 100 ether);
        token.freezeProtocolOperators(RUNTIME, PAYMASTER);
    }

    function test_OnlyFrozenOperatorsCanMoveWithoutAllowance() public {
        vm.prank(RUNTIME);
        assertTrue(token.protocolTransferFrom(USER, address(1), 10 ether));
        vm.prank(PAYMASTER);
        assertTrue(token.protocolTransferFrom(USER, address(2), 10 ether));
        vm.expectRevert(abi.encodeWithSelector(VoidTokenV9.NotProtocolOperator.selector, address(this)));
        token.protocolTransferFrom(USER, address(this), 1);
        assertEq(token.allowance(USER, RUNTIME), 0);
        assertEq(token.allowance(USER, PAYMASTER), 0);
    }

    function test_OperatorSetIsIrreversible() public {
        assertEq(token.bootstrapGovernor(), address(0));
        vm.expectRevert();
        token.freezeProtocolOperators(address(3), address(4));
    }

    function test_BurnReducesSupplyAndSnapshot() public {
        vm.prank(USER);
        token.burn(10 ether);
        assertEq(token.totalSupply(), 1_000_000_000 ether - 10 ether);
        vm.roll(block.number + 1);
        assertEq(token.getPastTotalSupply(block.number - 1), token.totalSupply());
    }
}
