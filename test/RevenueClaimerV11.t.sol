// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {V3Deed, V3Void, V3Recorder} from "./RuntimeV3.t.sol";
import {MockOracle} from "./MockOracle.sol";
import {VoidChainAppRuntimeV3} from "../contracts/parent/VoidChainAppRuntimeV3.sol";
import {IVoidChainTreasury, IVoidPriceOracle} from "../contracts/parent/VoidChainAppRuntime.sol";
import {IVoidChainAppRuntime} from "../contracts/apps/ChainAppBase.sol";
import {VoidChainTreasury, IVoidChainDeed, IERC20} from "../contracts/parent/VoidChainTreasury.sol";
import {VoidRevenueClaimerV11, IVoidClaimRuntimeV11, IVoidClaimTreasuryV11, IVoidClaimDeedV11} from "../contracts/parent/VoidRevenueClaimerV11.sol";

contract RevenueClaimerV11Test is Test {
    V3Deed deed;
    V3Void token;
    VoidChainTreasury treasury;
    VoidChainAppRuntimeV3 runtime;
    VoidRevenueClaimerV11 claimer;
    V3Recorder app;
    address constant ALICE = address(0xA11CE);
    address constant BOB = address(0xB0B);
    address constant FORWARDER = address(0xF04);
    address constant PROTOCOL = address(0xCAFE);
    uint256 constant FEE = 1e15;

    function setUp() public {
        deed = new V3Deed(); token = new V3Void();
        treasury = new VoidChainTreasury(IVoidChainDeed(address(deed)), IERC20(address(token)), PROTOCOL, address(this));
        runtime = new VoidChainAppRuntimeV3(deed, token, IVoidChainTreasury(address(treasury)));
        treasury.setAuthorizedSettler(address(runtime), true);
        runtime.setOracle(IVoidPriceOracle(address(new MockOracle())));
        runtime.setForwarderOnce(FORWARDER);
        runtime.setDaoFactoryOnce(address(this)); runtime.registerDao(1, address(this));
        deed.setOwner(1, ALICE);
        vm.prank(ALICE); runtime.activate(1, FEE);
        runtime.setAppFactoryOnce(address(this));
        app = new V3Recorder(IVoidChainAppRuntime(address(runtime)), 1);
        runtime.registerFromFactory(1, address(app), address(this));
        token.mint(FORWARDER, 100 * FEE);
        vm.prank(FORWARDER); token.approve(address(runtime), type(uint256).max);
        claimer = new VoidRevenueClaimerV11(IVoidClaimRuntimeV11(address(runtime)), IVoidClaimTreasuryV11(address(treasury)), IVoidClaimDeedV11(address(deed)));
    }

    function execute() internal {
        vm.prank(FORWARDER);
        runtime.executeFor(address(0x123), 1, address(app), abi.encodeCall(V3Recorder.ping, ()), FEE);
    }

    function test_ThirdPartyClaimPaysOwnerAndDoesNotDoubleChargeProtocol() public {
        execute();
        vm.prank(BOB); claimer.claimAll(1);
        assertEq(token.balanceOf(ALICE), FEE * 98 / 100);
        assertEq(token.balanceOf(BOB), 0);
        assertEq(runtime.protocolAccrued(), FEE * 2 / 100);
        claimer.claimAll(1);
        assertEq(token.balanceOf(ALICE), FEE * 98 / 100);
    }

    function test_SaleDoesNotGiveBuyerTheSellersRevenue() public {
        execute();
        deed.setOwner(1, BOB);
        claimer.claimAll(1);
        assertEq(token.balanceOf(BOB), 0);
        assertEq(treasury.claimable(ALICE), FEE * 98 / 100);
        treasury.claimFor(ALICE);
        execute(); claimer.claimAll(1);
        assertEq(token.balanceOf(ALICE), FEE * 98 / 100);
        assertEq(token.balanceOf(BOB), FEE * 98 / 100);
    }

    function test_ParkedRevenueRemainsWithdrawableAfterSale() public {
        execute(); deed.setOwner(1, BOB); execute();
        claimer.claimAll(1);
        assertEq(token.balanceOf(BOB), FEE * 98 / 100);
        assertEq(runtime.owed(ALICE), FEE * 98 / 100);
        runtime.claimOwed(ALICE); treasury.claimFor(ALICE);
        assertEq(token.balanceOf(ALICE), FEE * 98 / 100);
        assertEq(token.balanceOf(address(claimer)), 0);
    }
}
