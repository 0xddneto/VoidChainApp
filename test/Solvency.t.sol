// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {VoidChainSolvency, IVoidPriceOracle} from "../contracts/parent/VoidChainSolvency.sol";

contract MockOracle is IVoidPriceOracle {
    uint256 public rate;
    uint256 public updatedAt;

    constructor(uint256 rate_) {
        rate = rate_;
        updatedAt = block.timestamp;
    }

    function set(uint256 rate_, uint256 updatedAt_) external {
        rate = rate_;
        updatedAt = updatedAt_;
    }

    function voidPerEth() external view returns (uint256) {
        return rate;
    }

    function lastUpdatedAt() external view returns (uint256) {
        return updatedAt;
    }
}

/**
 * The layer that keeps the chains solvent, under attack.
 *
 * The risk here is not direct theft — it is a wrong price. A stalled or
 * manipulated oracle would make all 1,111 chains charge too little gas
 * (operating at a loss) or too much (driving everyone away). These tests verify
 * that the contract refuses a price rather than using a bad one.
 */
contract SolvencyTest is Test {
    VoidChainSolvency solvency;
    MockOracle oracle;

    address governance = address(0x6009);
    address attacker = address(0xBAD);

    /// 1000 VOID per ETH.
    uint256 constant RATE = 1000e18;

    function setUp() public {
        vm.warp(1_000_000);
        oracle = new MockOracle(RATE);
        solvency = new VoidChainSolvency(IVoidPriceOracle(address(oracle)), governance);
    }

    // -----------------------------------------------------------------------
    // The conversion
    // -----------------------------------------------------------------------

    function test_ConvertsBothWays() public view {
        assertEq(solvency.ethToVoid(1 ether), 1000 ether);
        assertEq(solvency.voidToEth(1000 ether), 1 ether);
    }

    /// @notice A round trip must not lose value in any meaningful way — if it
    ///         did, every settlement would shrink the owner's revenue.
    function testFuzz_RoundTripIsStable(uint128 amount) public view {
        vm.assume(amount > 1e6);
        uint256 back = solvency.voidToEth(solvency.ethToVoid(amount));
        // One unit of error is the unavoidable rounding of integer division.
        assertApproxEqAbs(back, amount, 1);
    }

    /// @notice This is the behavior that keeps the dollar cost stable: if VOID
    ///         doubles in price, the same target now costs half the VOID.
    function test_PriceRiseHalvesTheTokenAmountCharged() public {
        uint256 before_ = solvency.ethToVoid(1 ether);

        oracle.set(RATE / 2, block.timestamp); // VOID appreciated: fewer VOID per ETH
        uint256 after_ = solvency.ethToVoid(1 ether);

        assertEq(after_, before_ / 2, "the price in VOID should halve");
    }

    // -----------------------------------------------------------------------
    // A stalled oracle
    // -----------------------------------------------------------------------

    /// @notice A stale price is refused, not used. Better to block a fee change
    ///         than to apply one derived from a dead feed.
    function test_StaleOracleIsRejected() public {
        oracle.set(RATE, block.timestamp - solvency.MAX_ORACLE_AGE() - 1);

        vm.expectRevert();
        solvency.ethToVoid(1 ether);

        vm.expectRevert();
        solvency.voidToEth(1 ether);
    }

    function test_FreshOracleAtTheBoundaryStillWorks() public {
        oracle.set(RATE, block.timestamp - solvency.MAX_ORACLE_AGE());
        solvency.ethToVoid(1 ether);
    }

    // -----------------------------------------------------------------------
    // An absurd price
    // -----------------------------------------------------------------------

    /// @notice A compromised oracle reporting an absurd price is stopped by the
    ///         bounds — the damage is limited to blocking updates, instead of
    ///         producing a meaningless gas price across all 1,111 chains.
    function test_AbsurdlyHighPriceIsRejected() public {
        oracle.set(solvency.MAX_VOID_PER_ETH() + 1, block.timestamp);
        vm.expectRevert();
        solvency.ethToVoid(1 ether);
    }

    function test_AbsurdlyLowPriceIsRejected() public {
        oracle.set(solvency.MIN_VOID_PER_ETH() - 1, block.timestamp);
        vm.expectRevert();
        solvency.ethToVoid(1 ether);
    }

    function test_ZeroPriceIsRejected() public {
        oracle.set(0, block.timestamp);
        vm.expectRevert();
        solvency.ethToVoid(1 ether);
    }

    /// @notice Any price inside the bounds works; outside, none passes.
    function testFuzz_OnlyPricesInsideBoundsAreAccepted(uint256 rate) public {
        oracle.set(rate, block.timestamp);
        bool inBounds = rate >= solvency.MIN_VOID_PER_ETH() && rate <= solvency.MAX_VOID_PER_ETH();

        if (inBounds) {
            solvency.ethToVoid(1 ether);
        } else {
            vm.expectRevert();
            solvency.ethToVoid(1 ether);
        }
    }

    // -----------------------------------------------------------------------
    // Replacing the oracle
    // -----------------------------------------------------------------------

    /// @notice Replacing the oracle is a governance power, not the NFT holder's
    ///         nor anyone else's — whoever controls the price controls the
    ///         economy of every chain at once.
    function test_OnlyGovernanceReplacesTheOracle() public {
        MockOracle other = new MockOracle(RATE);

        vm.expectRevert(
            abi.encodeWithSelector(VoidChainSolvency.NotGovernance.selector, attacker)
        );
        vm.prank(attacker);
        solvency.setOracle(IVoidPriceOracle(address(other)));

        vm.prank(governance);
        solvency.setOracle(IVoidPriceOracle(address(other)));
        assertEq(address(solvency.oracle()), address(other));
    }

    function test_OracleCannotBeSetToZero() public {
        vm.expectRevert(VoidChainSolvency.ZeroAddress.selector);
        vm.prank(governance);
        solvency.setOracle(IVoidPriceOracle(address(0)));
    }

    function test_ConstructorRejectsZeroAddresses() public {
        vm.expectRevert(VoidChainSolvency.ZeroAddress.selector);
        new VoidChainSolvency(IVoidPriceOracle(address(0)), governance);

        vm.expectRevert(VoidChainSolvency.ZeroAddress.selector);
        new VoidChainSolvency(IVoidPriceOracle(address(oracle)), address(0));
    }
}
