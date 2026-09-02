// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {TestToken} from "../contracts/apps/TestToken.sol";
import {VoidSwap, IERC20} from "../contracts/apps/VoidSwap.sol";

/**
 * The DEX before it goes to the chain.
 *
 * The invariant that matters: `k` never shrinks. If a swap could reduce the
 * product of the reserves, it would be extracting value from whoever supplied
 * liquidity — which is how nearly every AMM has ever been drained.
 */
contract VoidSwapTest is Test {
    TestToken tokenA;
    TestToken tokenB;
    VoidSwap dex;

    address lp = address(0x11);
    address trader = address(0x22);

    function setUp() public {
        tokenA = new TestToken("Alpha", "ALPHA", 0);
        tokenB = new TestToken("Beta", "BETA", 0);
        dex = new VoidSwap(IERC20(address(tokenA)), IERC20(address(tokenB)));

        address[2] memory actors = [lp, trader];
        for (uint256 i; i < actors.length; ++i) {
            vm.startPrank(actors[i]);
            tokenA.mint(1_000_000 ether);
            tokenB.mint(1_000_000 ether);
            tokenA.approve(address(dex), type(uint256).max);
            tokenB.approve(address(dex), type(uint256).max);
            vm.stopPrank();
        }

        vm.prank(lp);
        dex.addLiquidity(100_000 ether, 100_000 ether);
    }

    // -----------------------------------------------------------------------

    function test_SwapMovesPriceAndPreservesInvariant() public {
        uint256 kBefore = dex.k();

        vm.prank(trader);
        uint256 out = dex.swap(true, 1000 ether, 0);

        assertGt(out, 0);
        assertGe(dex.k(), kBefore, "k encolheu, valor saiu do pool");
    }

    /// @notice The invariant holds through any sequence of swaps.
    function testFuzz_InvariantHoldsUnderAnySwap(uint96 amountIn, bool direction) public {
        vm.assume(amountIn > 1e12);
        vm.assume(amountIn < 50_000 ether);

        uint256 kBefore = dex.k();
        vm.prank(trader);
        dex.swap(direction, amountIn, 0);
        assertGe(dex.k(), kBefore, "k encolheu");
    }

    /// @notice A thousand swaps in a row, alternating direction: k only rises.
    function test_ThousandSwapsNeverShrinkK() public {
        uint256 kStart = dex.k();
        uint256 kPrevious = kStart;

        vm.startPrank(trader);
        for (uint256 i; i < 1000; ++i) {
            uint256 amount = 10 ether + (i % 97) * 1 ether;
            dex.swap(i % 2 == 0, amount, 0);

            uint256 kNow = dex.k();
            assertGe(kNow, kPrevious, "k encolheu no meio da sequencia");
            kPrevious = kNow;
        }
        vm.stopPrank();

        assertGt(dex.k(), kStart, "as taxas deveriam ter engordado o pool");
    }

    /// @notice Slippage protection: if less comes out than asked for, it reverts.
    function test_SlippageProtectionReverts() public {
        uint256 expected = dex.quote(true, 1000 ether);

        vm.expectRevert(VoidSwap.InsufficientOutput.selector);
        vm.prank(trader);
        dex.swap(true, 1000 ether, expected + 1);
    }

    function test_QuoteMatchesActualSwap() public {
        uint256 quoted = dex.quote(true, 500 ether);
        vm.prank(trader);
        uint256 actual = dex.swap(true, 500 ether, 0);
        assertEq(quoted, actual, "the quote must match the execution");
    }

    /// @notice A liquidity provider gets back more than they put in once the
    ///         pool has accrued fees — which is what makes providing liquidity
    ///         something anyone would do.
    function test_LiquidityProviderEarnsFromFees() public {
        vm.startPrank(trader);
        for (uint256 i; i < 200; ++i) {
            dex.swap(i % 2 == 0, 500 ether, 0);
        }
        vm.stopPrank();

        uint256 shares = dex.shares(lp);
        vm.prank(lp);
        (uint256 out0, uint256 out1) = dex.removeLiquidity(shares);

        assertGt(out0 + out1, 200_000 ether, "the LP should have profited from the fees");
    }

    function test_CannotDrainPoolWithHugeSwap() public {
        uint256 reserveBefore = dex.reserve1();

        vm.prank(trader);
        dex.swap(true, 900_000 ether, 0);

        assertGt(dex.reserve1(), 0, "the pool must not zero out either side");
        assertLt(dex.reserve1(), reserveBefore);
    }

    function test_EmptyPoolRejectsSwap() public {
        VoidSwap empty = new VoidSwap(IERC20(address(tokenA)), IERC20(address(tokenB)));
        vm.expectRevert(VoidSwap.InsufficientLiquidity.selector);
        vm.prank(trader);
        empty.swap(true, 1 ether, 0);
    }

    function test_RemovingMoreSharesThanOwnedReverts() public {
        vm.expectRevert(VoidSwap.InvalidAmount.selector);
        vm.prank(trader);
        dex.removeLiquidity(1);
    }
}
