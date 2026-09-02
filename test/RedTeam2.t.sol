// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {MockOracle} from "./MockOracle.sol";
import {
    VoidChainAppRuntime,
    IVoidChainDeed,
    IERC20,
    IVoidChainTreasury,
    IVoidPriceOracle as IRuntimeOracle
} from "../contracts/parent/VoidChainAppRuntime.sol";
import {ChainAppBase, IVoidChainAppRuntime} from "../contracts/apps/ChainAppBase.sol";
import {ChainAppSwap, IERC20 as ISwapERC20} from "../contracts/apps/ChainAppSwap.sol";
import {VoidChainTreasury, IERC20 as ITreasuryERC20} from "../contracts/parent/VoidChainTreasury.sol";
import {IVoidChainDeed as ITreasuryDeed} from "../contracts/parent/VoidChainTreasury.sol";
import {VoidChainExecutor} from "../contracts/child/VoidChainExecutor.sol";

// ---------------------------------------------------------------------------
// Mocks (same pattern as round 1)
// ---------------------------------------------------------------------------

contract FakeDeed is IVoidChainDeed {
    mapping(uint256 => address) public owners;
    function setOwner(uint256 t, address o) external { owners[t] = o; }
    function ownerOf(uint256 t) external view returns (address) { return owners[t]; }
}

contract MockToken is IERC20 {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    function mint(address to, uint256 a) external { balanceOf[to] += a; }
    function approve(address s, uint256 a) external returns (bool) {
        allowance[msg.sender][s] = a; return true;
    }
    function transfer(address to, uint256 a) external returns (bool) {
        balanceOf[msg.sender] -= a; balanceOf[to] += a; return true;
    }
    function transferFrom(address f, address t, uint256 a) external returns (bool) {
        uint256 al = allowance[f][msg.sender];
        if (al != type(uint256).max) allowance[f][msg.sender] = al - a;
        balanceOf[f] -= a; balanceOf[t] += a; return true;
    }
}

/// @notice Minimal ArbOwner stub so applyMinBaseFee/bindFeeAccounts don't revert
///         when the alias check passes (etched at 0x70).
contract MockArbOwner {
    uint256 public lastMinBaseFee;
    function setMinimumL2BaseFee(uint256 p) external { lastMinBaseFee = p; }
    function setNetworkFeeAccount(address) external {}
    function setInfraFeeAccount(address) external {}
    function addChainOwner(address) external {}
    function removeChainOwner(address) external {}
}

/// @notice Trivial no-op app to drive tolls (owner self-wash).
contract NoopApp is ChainAppBase {
    constructor(IVoidChainAppRuntime r, uint256 id) ChainAppBase(r, id) {}
    function ping() external view onlyFromMyChain returns (uint256) { return 1; }
}

contract RedTeam2 is Test {
    /// @dev The authorization became a single struct: loose parameters did not fit in
    ///      pilha da EVM, e o struct mantem a assinatura estavel se um tipo novo
    ///      de autorizacao aparecer.
    function _authTwo(address a, address b)
        internal pure returns (VoidChainAppRuntime.SpendAuth memory auth)
    {
        address[] memory t = new address[](2); t[0] = a; t[1] = b;
        uint256[] memory l = new uint256[](2);
        l[0] = type(uint256).max; l[1] = type(uint256).max;
        auth = VoidChainAppRuntime.SpendAuth({
            tokens: t, limits: l,
            collections: new address[](0), nftIds: new uint256[](0)
        });
    }

    function _authNone() internal pure returns (VoidChainAppRuntime.SpendAuth memory) {
        return VoidChainAppRuntime.SpendAuth({
            tokens: new address[](0), limits: new uint256[](0),
            collections: new address[](0), nftIds: new uint256[](0)
        });
    }

    MockOracle oracle;

    /// @dev The direct path also has to declare a budget: applications pull
    ///      tokens via `spendFrom`, and with no declared ceiling the runtime
    ///      refuses. The ceiling here is generous on purpose — what these cases
    ///      test is the DEX's arithmetic, not the spending limit.


    /// @dev The budget arrays are built HERE, and not in the test body: two
    ///      more variables in a fuzz function's frame were already blowing the
    ///      EVM's stack.
    function _dexCall(address dex_, address t0, address t1, bytes memory data, uint256 fee)
        internal
        returns (bytes memory)
    {
        return runtime.executeWithBudget(
            CHAIN1, dex_, data, fee, _authTwo(t0, t1)
        );
    }

    VoidChainAppRuntime runtime;
    VoidChainTreasury treasury;
    FakeDeed deed;
    MockToken voidToken;

    address alice = address(0xA11CE); // owner chain 1
    address bob = address(0xB0B);     // owner chain 2
    address attacker = address(0xBAD);
    address victim = address(0x5E12);
    address protocol = address(0x9001);
    address gov = address(0x6009);

    uint256 constant CHAIN1 = 1;
    uint256 constant CHAIN2 = 2;
    uint256 constant FEE = 0.01 ether;

    function setUp() public {
        deed = new FakeDeed();
        voidToken = new MockToken();
        treasury = new VoidChainTreasury(
            ITreasuryDeed(address(deed)), ITreasuryERC20(address(voidToken)), protocol, gov
        );
        oracle = new MockOracle();
        runtime = new VoidChainAppRuntime(
            IVoidChainDeed(address(deed)), IERC20(address(voidToken)),
            IVoidChainTreasury(address(treasury))
        );
        runtime.setOracle(IRuntimeOracle(address(oracle)));
        deed.setOwner(CHAIN1, alice);
        deed.setOwner(CHAIN2, bob);
        vm.prank(gov);
        treasury.setAuthorizedSettler(address(runtime), true);
        vm.prank(alice); runtime.activate(CHAIN1, FEE);
        vm.prank(bob);   runtime.activate(CHAIN2, FEE);
    }

    // Helper: fund VOID + approve runtime so `who` can pay tolls.
    function _fundToll(address who) internal {
        voidToken.mint(who, 1_000 ether);
        vm.prank(who);
        voidToken.approve(address(runtime), type(uint256).max);
    }

    function _newDex() internal returns (ChainAppSwap dex, MockToken A, MockToken B) {
        A = new MockToken();
        B = new MockToken();
        dex = new ChainAppSwap(
            IVoidChainAppRuntime(address(runtime)), CHAIN1,
            ISwapERC20(address(A)), ISwapERC20(address(B))
        );
        vm.prank(alice); runtime.registerApp(CHAIN1, address(dex));
    }

    // =====================================================================
    // J-1  DEFENSE HOLDS: classic first-depositor share-inflation via
    //      DONATION is neutralized because reserves are internal accounting,
    //      not balanceOf(). Donating tokens does not move `reserve0/1`.
    // =====================================================================
    function test_J1_DonationInflationDefeated() public {
        (ChainAppSwap dex, MockToken A, MockToken B) = _newDex();
        _fundToll(attacker);
        _fundToll(victim);

        // Attacker is first LP with the minimum viable position.
        A.mint(attacker, 100_000 ether);
        B.mint(attacker, 100_000 ether);
        vm.startPrank(attacker);
        A.approve(address(dex), type(uint256).max);
        // With `spendFrom`, the one pulling the user's token is the RUNTIME.
        A.approve(address(runtime), type(uint256).max);
        B.approve(address(dex), type(uint256).max);
        // With `spendFrom`, the one pulling the user's token is the RUNTIME.
        B.approve(address(runtime), type(uint256).max);
        _dexCall(address(dex), address(A), address(B),
            abi.encodeCall(ChainAppSwap.addLiquidity, (2000, 2000, 0)), FEE);
        vm.stopPrank();

        // Attacker DONATES a huge amount straight to the DEX contract to try to
        // inflate the share price so the next LP rounds to zero shares.
        A.mint(attacker, 1_000_000 ether);
        B.mint(attacker, 1_000_000 ether);
        vm.startPrank(attacker);
        A.transfer(address(dex), 1_000_000 ether);
        B.transfer(address(dex), 1_000_000 ether);
        vm.stopPrank();

        // Reserves are UNCHANGED by the donation.
        assertEq(dex.reserve0(), 2000, "donation must not move internal reserve0");
        assertEq(dex.reserve1(), 2000, "donation must not move internal reserve1");

        // Victim adds a normal position and must receive fair, non-zero shares.
        A.mint(victim, 100_000 ether);
        B.mint(victim, 100_000 ether);
        vm.startPrank(victim);
        A.approve(address(dex), type(uint256).max);
        // With `spendFrom`, the one pulling the user's token is the RUNTIME.
        A.approve(address(runtime), type(uint256).max);
        B.approve(address(dex), type(uint256).max);
        // With `spendFrom`, the one pulling the user's token is the RUNTIME.
        B.approve(address(runtime), type(uint256).max);
        _dexCall(address(dex), address(A), address(B),
            abi.encodeCall(ChainAppSwap.addLiquidity, (50_000 ether, 50_000 ether, 0)), FEE);
        vm.stopPrank();

        uint256 vShares = dex.shares(victim);
        assertGt(vShares, 0, "victim must not be griefed to zero shares");

        // Victim can withdraw ~ what they put in (rounding only), NOT lose it.
        vm.prank(victim);
        _dexCall(address(dex), address(A), address(B),
            abi.encodeCall(ChainAppSwap.removeLiquidity, (vShares)), FEE);
        uint256 backA = A.balanceOf(victim);
        uint256 backB = B.balanceOf(victim);
        // Started with 100k, spent 50k -> 50k left; should get back ~50k each.
        assertGe(backA, 100_000 ether - 1, "victim recovers ~all token A");
        assertGe(backB, 100_000 ether - 1, "victim recovers ~all token B");
    }

    // =====================================================================
    // J-2  NEW FINDING (enabled by the J fix): addLiquidity has NO slippage /
    //      minShares guard, while swap HAS minAmountOut. An LP who adds into a
    //      pool whose price was moved in the same block (trivial for the chain
    //      owner, who orders the block, or any front-runner) is minted shares
    //      worth LESS than they deposited, and has no parameter to bound the
    //      loss. The excess is socialized into reserves. removeLiquidity (J) is
    //      what now lets the LP even observe/realize the shortfall.
    //
    //      We prove the LP HARM directly: victim adds into a skewed pool, then
    //      immediately removes — and gets back materially less than deposited,
    //      far beyond the 0.3% swap-fee/rounding dust of an honest round trip.
    // =====================================================================
    function test_J2_AddLiquiditySlippageGuardProtectsLP() public {
        (ChainAppSwap dex, MockToken A, MockToken B) = _newDex();
        _fundToll(attacker);
        _fundToll(victim);

        // Honest seed pool 100k:100k.
        A.mint(attacker, 300_000 ether);
        B.mint(attacker, 300_000 ether);
        vm.startPrank(attacker);
        A.approve(address(dex), type(uint256).max);
        // With `spendFrom`, the one pulling the user's token is the RUNTIME.
        A.approve(address(runtime), type(uint256).max);
        B.approve(address(dex), type(uint256).max);
        // With `spendFrom`, the one pulling the user's token is the RUNTIME.
        B.approve(address(runtime), type(uint256).max);
        _dexCall(address(dex), address(A), address(B),
            abi.encodeCall(ChainAppSwap.addLiquidity, (100_000 ether, 100_000 ether, 0)), FEE);
        vm.stopPrank();

        // Owner/front-runner moves the price in-block: A -> B, hard.
        vm.prank(attacker);
        _dexCall(address(dex), address(A), address(B),
            abi.encodeCall(ChainAppSwap.swap, (true, 60_000 ether, 0)), FEE);

        // The victim now demands a share floor. In an unskewed pool, 10k+10k
        // would be worth ~10% of the initial shares; she demands close to that.
        // Because the pool is skewed, the add would produce FEWER shares than the
        // floor and REVERTS — fix #1 turns the ambush into the provider's
        // decision.
        A.mint(victim, 10_000 ether);
        B.mint(victim, 10_000 ether);
        vm.startPrank(victim);
        A.approve(address(dex), type(uint256).max);
        // With `spendFrom`, the one pulling the user's token is the RUNTIME.
        A.approve(address(runtime), type(uint256).max);
        B.approve(address(dex), type(uint256).max);
        // With `spendFrom`, the one pulling the user's token is the RUNTIME.
        B.approve(address(runtime), type(uint256).max);

        uint256 before = A.balanceOf(victim) + B.balanceOf(victim);

        // What a FAIR add (unskewed pool) would have minted.
        uint256 fairShares = 10_000 ether; // 10k against an initial totalShares of 100k
        // The runtime wraps the app's error in CallFailed — it passes the reason
        // through without interpreting it, the same pattern as the other tests.
        vm.expectRevert(
            abi.encodeWithSelector(
                VoidChainAppRuntime.CallFailed.selector,
                abi.encodeWithSelector(ChainAppSwap.InsufficientOutput.selector)
            )
        );
        _dexCall(address(dex), address(A), address(B),
            abi.encodeCall(ChainAppSwap.addLiquidity, (10_000 ether, 10_000 ether, fairShares)), FEE);
        vm.stopPrank();

        // The transaction reverted: the victim still has her tokens, nothing was lost.
        assertEq(A.balanceOf(victim) + B.balanceOf(victim), before, "a guarda protegeu o LP");
    }

    // =====================================================================
    // J-3  FUZZ: a single LP round-trip (add then remove all) can NEVER return
    //      more than was deposited. Rounding must always favour the pool.
    // =====================================================================
    function testFuzz_J3_RemoveNeverReturnsMoreThanDeposited(uint256 a0, uint256 a1) public {
        a0 = bound(a0, 1_000_000, 1e30);
        a1 = bound(a1, 1_000_000, 1e30);
        (ChainAppSwap dex, MockToken A, MockToken B) = _newDex();
        _fundToll(attacker);
        A.mint(attacker, a0);
        B.mint(attacker, a1);
        vm.startPrank(attacker);
        A.approve(address(dex), type(uint256).max);
        // With `spendFrom`, the one pulling the user's token is the RUNTIME.
        A.approve(address(runtime), type(uint256).max);
        B.approve(address(dex), type(uint256).max);
        // With `spendFrom`, the one pulling the user's token is the RUNTIME.
        B.approve(address(runtime), type(uint256).max);
        uint256 minted;
        try runtime.executeWithBudget(CHAIN1,  address(dex),
            abi.encodeCall(ChainAppSwap.addLiquidity, (a0, a1, 0)), FEE, _authTwo(address(A), address(B))) returns (bytes memory ret) {
            minted = abi.decode(ret, (uint256));
        } catch {
            vm.stopPrank();
            return; // sqrt<=MIN_LIQUIDITY etc — not an exploit path
        }
        uint256 sh = dex.shares(attacker);
        if (sh == 0) { vm.stopPrank(); return; }
        _dexCall(address(dex), address(A), address(B),
            abi.encodeCall(ChainAppSwap.removeLiquidity, (sh)), FEE);
        vm.stopPrank();
        // Got back <= deposited (MINIMUM_LIQUIDITY + rounding stays in the pool).
        assertLe(A.balanceOf(attacker), a0, "cannot withdraw more A than deposited");
        assertLe(B.balanceOf(attacker), a1, "cannot withdraw more B than deposited");
        minted; // silence
    }

    // =====================================================================
    // J-4  FUZZ: swap invariant. amountOut < reserveOut always (no reserve
    //      drain), and k (reserve0*reserve1) never decreases across a swap.
    // =====================================================================
    function testFuzz_J4_SwapKNeverDecreases(uint256 amountIn, bool dir) public {
        (ChainAppSwap dex, MockToken A, MockToken B) = _newDex();
        _fundToll(attacker);
        A.mint(attacker, 1_000_000 ether);
        B.mint(attacker, 1_000_000 ether);
        vm.startPrank(attacker);
        A.approve(address(dex), type(uint256).max);
        // With `spendFrom`, the one pulling the user's token is the RUNTIME.
        A.approve(address(runtime), type(uint256).max);
        B.approve(address(dex), type(uint256).max);
        // With `spendFrom`, the one pulling the user's token is the RUNTIME.
        B.approve(address(runtime), type(uint256).max);
        _dexCall(address(dex), address(A), address(B),
            abi.encodeCall(ChainAppSwap.addLiquidity, (500_000 ether, 500_000 ether, 0)), FEE);

        amountIn = bound(amountIn, 1, 400_000 ether);
        MockToken tin = dir ? A : B;
        tin.mint(attacker, amountIn);

        uint256 kBefore = dex.reserve0() * dex.reserve1();
        try runtime.executeWithBudget(CHAIN1,  address(dex),
            abi.encodeCall(ChainAppSwap.swap, (dir, amountIn, 0)), FEE, _authTwo(address(A), address(B))) {
        } catch { vm.stopPrank(); return; }
        vm.stopPrank();
        uint256 kAfter = dex.reserve0() * dex.reserve1();
        assertGe(kAfter, kBefore, "k must never decrease (fee accrues to pool)");
        assertGt(dex.reserve0(), 0, "reserve0 never zeroed");
        assertGt(dex.reserve1(), 0, "reserve1 never zeroed");
    }

    // =====================================================================
    // K-1  The K fix stops THIRD PARTIES from spoofing lifetimeRevenue, but it
    //      does NOT stop the chain OWNER from wash-trading their own chain to
    //      inflate lifetimeRevenue before a sale. Net cost is only the 2%
    //      protocol fee; 98% cycles back to the owner. The exact metric used
    //      "for price discovery" is still forgeable by the seller.
    // =====================================================================
    function test_K1_OwnerSelfWashStillInflatesLifetimeRevenue() public {
        NoopApp app = new NoopApp(IVoidChainAppRuntime(address(runtime)), CHAIN1);
        vm.prank(alice); runtime.registerApp(CHAIN1, address(app));

        // Alice uses a real toll of 1 VOID and cycles it through her own chain.
        uint256 toll = 1 ether;
        vm.prank(alice); runtime.setFee(CHAIN1, toll);
        _fundToll(alice); // 1000 VOID working capital

        uint256 capitalStart = voidToken.balanceOf(alice);

        uint256 N = 100;
        vm.startPrank(alice);
        for (uint256 i; i < N; ++i) {
            runtime.execute(CHAIN1, address(app), abi.encodeCall(NoopApp.ping, ()), toll);
        }
        vm.stopPrank();

        runtime.flush(CHAIN1);
        // Alice claims her holder share back from the treasury.
        vm.prank(alice); treasury.claim();

        uint256 gross = toll * N; // 100 VOID of "revenue" manufactured
        // A metrica bruta agora vive no runtime (o cofre so recebe o liquido).
        (,,, uint256 lifetime, uint256 calls) = runtime.statsOf(CHAIN1);
        assertEq(lifetime, gross, "runtime lifetime inflated");
        assertEq(calls, N, "callCount inflated");

        // Net cost to Alice is only the 2% protocol fee.
        uint256 capitalEnd = voidToken.balanceOf(alice);
        uint256 netCost = capitalStart - capitalEnd;
        uint256 expectedFee = (gross * 200) / 10_000; // 2%
        assertEq(netCost, expectedFee, "owner manufactured 100 VOID of 'revenue' for a 2% fee");
        emit log_named_uint("manufactured lifetimeRevenue", gross);
        emit log_named_uint("net cost to owner (2%)", netCost);
    }

    // =====================================================================
    // OWNER-DoS: the owner cannot delete third-party apps (good), but CAN price
    //      them into uselessness by setting the toll to MAX_FEE. A user of a
    //      third-party app who will only pay the advertised low toll is blocked.
    //      "Permissionless deploy" protects the code, not its economics.
    // =====================================================================
    function test_OwnerCanPriceOutThirdPartyApps() public {
        // Bob (a third-party dev) publishes an app on Alice's chain.
        NoopApp devApp = new NoopApp(IVoidChainAppRuntime(address(runtime)), CHAIN1);
        vm.prank(bob); runtime.registerApp(CHAIN1, address(devApp));

        _fundToll(victim);
        // Alice front-runs by raising the toll. There is no longer a global
        // ceiling to hit — she simply prices it out of reach. The finding is
        // UNCHANGED by removing MAX_FEE: the ceiling never was the protection.
        vm.prank(alice); runtime.setFee(CHAIN1, 1_000 ether);

        // A user willing to pay only the old cheap toll is now shut out.
        vm.prank(victim);
        vm.expectRevert();
        runtime.execute(CHAIN1, address(devApp),
            abi.encodeCall(NoopApp.ping, ()), FEE /* old low maxFee */);
    }

    // =====================================================================
    // M-1  NEW FINDING: revenue timing / sale race. `pending` accrues in the
    //      runtime for an UNBOUNDED period and is only assigned to an owner at
    //      flush time (treasury reads ownerOf at settle). Whoever holds the deed
    //      at flush captures ALL unflushed revenue — including what a previous
    //      owner earned. A seller who forgets to flush before selling loses a
    //      month of revenue to the buyer; a buyer can target chains with large
    //      unflushed pending and flush+claim immediately after purchase.
    // =====================================================================
    function test_M1_UnflushedRevenueFollowsWhoEarnedIt() public {
        NoopApp app = new NoopApp(IVoidChainAppRuntime(address(runtime)), CHAIN1);
        vm.prank(alice); runtime.registerApp(CHAIN1, address(app));
        vm.prank(alice); runtime.setFee(CHAIN1, 1 ether);

        // A month of real third-party usage accrues to Alice's chain.
        _fundToll(victim); // stands in for paying users
        vm.startPrank(victim);
        for (uint256 i; i < 50; ++i) {
            runtime.execute(CHAIN1, address(app), abi.encodeCall(NoopApp.ping, ()), 1 ether);
        }
        vm.stopPrank();

        (,, uint256 pending,,) = runtime.statsOf(CHAIN1);
        assertEq(pending, 49 ether, "Alice earned 50 VOID; pending liquido = 49 (98%)");

        // Alice sells the deed to Bob (marketplace transfer) WITHOUT flushing.
        deed.setOwner(CHAIN1, bob);

        // Bob tries to capture it by flushing — but settlement now credits
        // WHOEVER GENERATED it (Alice), not whoever holds the deed at flush time.
        runtime.flush(CHAIN1);

        uint256 net = 50 ether - (50 ether * 200 / 10_000);
        assertEq(treasury.claimable(alice), net, "the revenue went to whoever generated it");
        assertEq(treasury.claimable(bob), 0, "the buyer does not take what they did not generate");

        vm.prank(alice); treasury.claim();
        assertEq(voidToken.balanceOf(alice), net, "Alice withdraws what she earned");
        emit log_named_uint("revenue Alice generated AND received", net);
    }

    // =====================================================================
    // L-1  Aliasing is a BIJECTION: two distinct controllers can never alias to
    //      the same expected sender. The `unchecked` only adds mod-2^160 wrap;
    //      it does not create collisions. Confirmed by replicating the formula.
    // =====================================================================
    function test_L1_AliasingHasNoCollision(address c1, address c2) public pure {
        vm.assume(c1 != c2);
        vm.assume(c1 != address(0) && c2 != address(0));
        uint160 OFF = uint160(0x1111000000000000000000000000000000001111);
        address e1; address e2;
        unchecked {
            e1 = address(uint160(c1) + OFF);
            e2 = address(uint160(c2) + OFF);
        }
        assertTrue(e1 != e2, "distinct controllers must alias to distinct addresses");
    }

    // =====================================================================
    // L-2  The `unchecked` fix removes the DoS: a controller whose address is
    //      high enough to overflow uint160 still yields a reachable executor
    //      (wraps instead of reverting). We etch a mock ArbOwner at 0x70 and
    //      call from the wrapped aliased address successfully.
    // =====================================================================
    function test_L2_HighControllerDoesNotBrickExecutor() public {
        // Controller near the top of the 160-bit space forces a wrap.
        address highController = address(uint160(type(uint160).max) - 5);
        VoidChainExecutor exec =
            new VoidChainExecutor(highController, address(0xFEE5));

        // Compute the wrapped alias exactly as the modifier does.
        uint160 OFF = uint160(0x1111000000000000000000000000000000001111);
        address aliased;
        unchecked { aliased = address(uint160(highController) + OFF); }

        // Etch a working ArbOwner at the precompile address.
        MockArbOwner mock = new MockArbOwner();
        vm.etch(address(0x0000000000000000000000000000000000000070), address(mock).code);

        // Call from the wrapped alias — must SUCCEED (no revert, not bricked).
        vm.prank(aliased);
        exec.applyMinBaseFee(123);

        // And a wrong caller is still rejected.
        vm.prank(address(0xDEAD));
        vm.expectRevert();
        exec.applyMinBaseFee(456);
    }

    // =====================================================================
    // REENTRANCY: cross-app / cross-execute reentrancy is blocked. A malicious
    //      app cannot re-enter execute (nonReentrant + executingChain!=0 guard),
    //      and cannot reach another app directly (onlyFromMyChain requires the
    //      runtime as msg.sender). Confirms the guard the DEX relies on since it
    //      itself has no ReentrancyGuard.
    // =====================================================================
    function test_ReentrantExecuteIsBlocked() public {
        Reenterer evil = new Reenterer(IVoidChainAppRuntime(address(runtime)), CHAIN1, runtime);
        vm.prank(alice); runtime.registerApp(CHAIN1, address(evil));
        _fundToll(attacker);
        vm.prank(attacker);
        vm.expectRevert();
        runtime.execute(CHAIN1, address(evil), abi.encodeCall(Reenterer.attack, ()), FEE);
    }
}

/// @notice App that tries to re-enter runtime.execute during its own execution.
contract Reenterer is ChainAppBase {
    VoidChainAppRuntime public immutable rt;
    constructor(IVoidChainAppRuntime r, uint256 id, VoidChainAppRuntime rt_)
        ChainAppBase(r, id) { rt = rt_; }
    function attack() external onlyFromMyChain {
        // Re-enter: must revert (nonReentrant / executingChain != 0).
        rt.execute(chainId, address(this), abi.encodeCall(Reenterer.attack, ()), type(uint256).max);
    }
}
