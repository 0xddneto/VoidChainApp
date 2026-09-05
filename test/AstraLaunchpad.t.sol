// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ChainAppLaunchpad, IERC20} from "../contracts/apps/ChainAppLaunchpad.sol";
import {IVoidChainAppRuntime} from "../contracts/apps/ChainAppBase.sol";

contract AstraSaleToken is ERC20 {
    constructor() ERC20("Fixture", "FIX") {}
    function mint(address to, uint256 amount) external { _mint(to, amount); }
}

/// @dev Minimal runtime fixture; production gateway isolation has separate tests.
contract AstraSaleRuntime {
    uint256 public executingChain = 1;
    address public executingCaller;
    function execute(address app, address user, bytes calldata data) external returns (bytes memory) {
        executingCaller = user;
        (bool ok, bytes memory result) = app.call(data);
        if (!ok) assembly { revert(add(result, 32), mload(result)) }
        executingCaller = address(0);
        return result;
    }
    function spendFrom(address token, address to, uint256 amount) external {
        require(IERC20(token).transferFrom(executingCaller, to, amount));
    }
}

contract AstraLaunchpadTest is Test {
    AstraSaleRuntime runtime;
    AstraSaleToken stock;
    AstraSaleToken payment;
    ChainAppLaunchpad pad;
    address alice = address(0xA11CE);
    address bob = address(0xB0B);
    address buyer = address(0xB001);

    function setUp() public {
        runtime = new AstraSaleRuntime();
        stock = new AstraSaleToken();
        payment = new AstraSaleToken();
        pad = new ChainAppLaunchpad(IVoidChainAppRuntime(address(runtime)), 1, IERC20(address(payment)));
        stock.mint(alice, 100 ether);
        stock.mint(bob, 200 ether);
        payment.mint(buyer, 300 ether);
        vm.prank(alice); stock.approve(address(runtime), type(uint256).max);
        vm.prank(bob); stock.approve(address(runtime), type(uint256).max);
        vm.prank(buyer); payment.approve(address(runtime), type(uint256).max);
    }

    function _create(address owner, uint256 cap) private {
        runtime.execute(address(pad), owner, abi.encodeCall(pad.createSale,
            (IERC20(address(stock)), 1 ether, cap, block.timestamp + 1 days)));
    }

    function test_FinalizeCannotWithdrawAnotherSalesInventory() public {
        _create(alice, 100 ether);
        _create(bob, 200 ether);
        runtime.execute(address(pad), buyer, abi.encodeCall(pad.buy, (1, 40 ether)));
        vm.warp(block.timestamp + 2 days);
        runtime.execute(address(pad), alice, abi.encodeCall(pad.finalize, (1)));
        assertEq(stock.balanceOf(alice), 60 ether);
        assertEq(stock.balanceOf(address(pad)), 200 ether);
        assertEq(pad.remainingStock(2), 200 ether);
        assertEq(payment.balanceOf(alice), 40 ether);
        runtime.execute(address(pad), bob, abi.encodeCall(pad.finalize, (2)));
        assertEq(stock.balanceOf(bob), 200 ether);
        assertEq(stock.balanceOf(address(pad)), 0);
    }

    function test_FinalizeDoesNotTreatDonationsAsSaleStock() public {
        _create(alice, 100 ether);
        stock.mint(address(pad), 25 ether);
        vm.warp(block.timestamp + 2 days);
        runtime.execute(address(pad), alice, abi.encodeCall(pad.finalize, (1)));
        assertEq(stock.balanceOf(alice), 100 ether);
        assertEq(stock.balanceOf(address(pad)), 25 ether);
    }
}
