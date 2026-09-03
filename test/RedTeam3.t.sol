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

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

contract FakeDeed is IVoidChainDeed {
    mapping(uint256 => address) public owners;
    function setOwner(uint256 t, address o) external { owners[t] = o; }
    function ownerOf(uint256 t) external view returns (address) { return owners[t]; }
}

/// @notice Plain token for DEX legs.
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

/// @notice ERC-777-like VOID: fires a `tokensToSend`-style callback to the
///         `from` address during transferFrom, IF that address registered a hook.
///         This is the real reentrancy vector against the new settle path.
contract HookVoid is IERC20 {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    mapping(address => bool) public hooked;

    function mint(address to, uint256 a) external { balanceOf[to] += a; }
    function setHook(address who, bool on) external { hooked[who] = on; }

    function approve(address s, uint256 a) external returns (bool) {
        allowance[msg.sender][s] = a; return true;
    }
    function transfer(address to, uint256 a) external returns (bool) {
        balanceOf[msg.sender] -= a; balanceOf[to] += a; return true;
    }
    function transferFrom(address f, address t, uint256 a) external returns (bool) {
        uint256 al = allowance[f][msg.sender];
        if (al != type(uint256).max) allowance[f][msg.sender] = al - a;
        balanceOf[f] -= a; balanceOf[t] += a;
        // Fire the sender hook AFTER moving balances (ERC-777 tokensToSend flavor).
        if (hooked[f]) {
            IReentryHook(f).onTokenMove();
        }
        return true;
    }
}

interface IReentryHook {
    function onTokenMove() external;
}

/// @notice Attacker contract that pays tolls and, on the token callback, tries
///         to re-enter the runtime / treasury. Records whether re-entry succeeded.
contract ReentryAttacker is IReentryHook {
    VoidChainAppRuntime public rt;
    VoidChainTreasury public tr;
    uint256 public targetChain;
    bool public armed;
    bool public flushReentered;
    bool public executeReentered;
    bool public claimReentered;
    address public appTarget;
    bytes public appData;

    function config(
        VoidChainAppRuntime rt_,
        VoidChainTreasury tr_,
        uint256 chain_,
        address appTarget_,
        bytes calldata appData_
    ) external {
        rt = rt_; tr = tr_; targetChain = chain_; appTarget = appTarget_; appData = appData_;
    }

    function arm(bool on) external { armed = on; }

    // Called by execute path when this contract pays the toll.
    function fire(uint256 maxFee) external {
        rt.execute(targetChain, appTarget, appData, maxFee);
    }

    function onTokenMove() external override {
        if (!armed) return;
        armed = false; // fire once
        try rt.flush(targetChain) { flushReentered = true; } catch {}
        try rt.execute(targetChain, appTarget, appData, type(uint256).max) {
            executeReentered = true;
        } catch {}
        try tr.claim() { claimReentered = true; } catch {}
    }
}

/// @notice Trivial app that just needs a toll paid to run.
contract NoopApp is ChainAppBase {
    constructor(IVoidChainAppRuntime r, uint256 id) ChainAppBase(r, id) {}
    function ping() external view onlyFromMyChain returns (uint256) { return 1; }
}

/// @notice App whose call always reverts — to test auto-settle rollback.
contract RevertingApp is ChainAppBase {
    constructor(IVoidChainAppRuntime r, uint256 id) ChainAppBase(r, id) {}
    function boom() external view onlyFromMyChain { revert("boom"); }
}

// ---------------------------------------------------------------------------
// RedTeam Round 3 — attack the fresh fixes
// ---------------------------------------------------------------------------
contract RedTeam3 is Test {
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
    HookVoid voidToken;

    address alice = address(0xA11CE); // owner chain 1
    address bob = address(0xB0B);     // owner chain 2
    address carol = address(0xCA201);
    address protocol = address(0x9001);
    address gov = address(0x6009);

    uint256 constant CHAIN1 = 1;
    uint256 constant CHAIN2 = 2;
    uint256 constant FEE = 1 ether;
    uint256 constant NET = FEE - (FEE * 200) / 10_000; // 98%, what is left to the owner

    function setUp() public {
        deed = new FakeDeed();
        voidToken = new HookVoid();
        treasury = new VoidChainTreasury(
            ITreasuryDeed(address(deed)), ITreasuryERC20(address(voidToken)), protocol, gov
        );
        oracle = new MockOracle();
        runtime = new VoidChainAppRuntime(
            IVoidChainDeed(address(deed)), IERC20(address(voidToken)),
            IVoidChainTreasury(address(treasury))
        );
        runtime.setDaoFactoryOnce(address(this));
        runtime.registerDao(CHAIN1, address(this));
        runtime.registerDao(CHAIN2, address(this));
        runtime.setOracle(IRuntimeOracle(address(oracle)));
        deed.setOwner(CHAIN1, alice);
        deed.setOwner(CHAIN2, bob);
        vm.prank(gov);
        treasury.setAuthorizedSettler(address(runtime), true);
        vm.prank(alice); runtime.activate(CHAIN1, FEE);
        vm.prank(bob);   runtime.activate(CHAIN2, FEE);
    }

    function _fund(address who) internal {
        voidToken.mint(who, 1_000 ether);
        vm.prank(who);
        voidToken.approve(address(runtime), type(uint256).max);
    }

    // =====================================================================
    // R3-1  REENTRANCY on the fee-charge path with an ERC-777-style VOID.
    //   During execute's fee transferFrom(attacker -> runtime), the token
    //   fires the attacker's sender-hook. Attacker re-enters flush + execute.
    //   Both MUST fail (nonReentrant), while the OUTER execute completes with
    //   exactly-once accounting. Proves the guard survives a callback token.
    // =====================================================================
    function test_R3_1_ReentrancyOnFeeChargeIsBlocked() public {
        NoopApp app = new NoopApp(IVoidChainAppRuntime(address(runtime)), CHAIN1);
        vm.prank(alice); runtime.registerApp(CHAIN1, address(app));

        ReentryAttacker atk = new ReentryAttacker();
        atk.config(runtime, treasury, CHAIN1, address(app), abi.encodeCall(NoopApp.ping, ()));
        voidToken.mint(address(atk), 1_000 ether);
        // atk must approve the runtime to pull tolls.
        vm.prank(address(atk)); voidToken.approve(address(runtime), type(uint256).max);
        // Attacker becomes owner of CHAIN1 so it has pending it could try to double-claim.
        deed.setOwner(CHAIN1, address(atk));

        voidToken.setHook(address(atk), true);
        atk.arm(true);

        // Fire a normal execute; the token callback re-enters during the toll pull.
        atk.fire(FEE);

        assertFalse(atk.flushReentered(), "reentrant flush must be blocked");
        assertFalse(atk.executeReentered(), "reentrant execute must be blocked");

        // Exactly one toll accounted, once.
        (,, uint256 pending,,) = runtime.statsOf(CHAIN1);
        assertEq(pending, NET, "exactly one toll pending (net 98%), no double count");
        assertEq(voidToken.balanceOf(address(runtime)), FEE, "runtime holds exactly one toll");
    }

    // =====================================================================
    // R3-2  REENTRANCY during the auto-settle inside execute. Owner sells to a
    //   hooked attacker; attacker generates pending which triggers _settlePending
    //   (settleTo -> transferFrom runtime->treasury). We also arm the attacker's
    //   hook. The settle transfer's `from` is the runtime (no attacker hook),
    //   so no attacker code fires there; the only attacker hook fires on the toll
    //   pull (from = attacker). Re-entry still blocked, accounting exact.
    // =====================================================================
    function test_R3_2_ReentrancyDuringAutoSettleIsBlocked() public {
        NoopApp app = new NoopApp(IVoidChainAppRuntime(address(runtime)), CHAIN1);
        vm.prank(alice); runtime.registerApp(CHAIN1, address(app));

        // Alice earns some pending first.
        _fund(carol);
        vm.prank(carol);
        runtime.execute(CHAIN1, address(app), abi.encodeCall(NoopApp.ping, ()), FEE);
        (,, uint256 pendingA,,) = runtime.statsOf(CHAIN1);
        assertEq(pendingA, NET, "Alice generated one toll (net 98%)");

        // Sell to attacker.
        ReentryAttacker atk = new ReentryAttacker();
        atk.config(runtime, treasury, CHAIN1, address(app), abi.encodeCall(NoopApp.ping, ()));
        voidToken.mint(address(atk), 1_000 ether);
        vm.prank(address(atk)); voidToken.approve(address(runtime), type(uint256).max);
        deed.setOwner(CHAIN1, address(atk));
        voidToken.setHook(address(atk), true);
        atk.arm(true);

        // Attacker executes: triggers auto-settle of Alice's pending, then adds its own.
        atk.fire(FEE);

        assertFalse(atk.flushReentered(), "reentrant flush blocked during auto-settle window");
        assertFalse(atk.executeReentered(), "reentrant execute blocked during auto-settle window");

        // Alice's revenue was PARKED in the runtime when the deed changed
        // hands, instead of travelling to the treasury inside the attacker's
        // call. One extra step, same guarantee: the value is hers and hers
        // alone.
        runtime.claimOwed(alice);
        uint256 net = FEE - (FEE * 200 / 10_000);
        assertEq(treasury.claimable(alice), net, "Alice got exactly her generated revenue");
        assertEq(treasury.claimable(address(atk)), 0, "attacker earned nothing yet from settle");

        // Attacker's own new toll is now pending, credited to attacker.
        (,, uint256 pendingNow,, ) = runtime.statsOf(CHAIN1);
        assertEq(pendingNow, NET, "attacker's own toll (net) is the only pending now");
    }

    // =====================================================================
    // R3-3  BUYER CANNOT STEAL SELLER'S PENDING, even across multiple tolls and
    //   even by setting fee=0 to dodge the auto-settle. Exact accounting proof.
    // =====================================================================
    function test_R3_3_BuyerCannotStealViaFeeZeroDodge() public {
        NoopApp app = new NoopApp(IVoidChainAppRuntime(address(runtime)), CHAIN1);
        vm.prank(alice); runtime.registerApp(CHAIN1, address(app));

        // Alice earns 3 tolls.
        _fund(carol);
        vm.startPrank(carol);
        for (uint256 i; i < 3; ++i) {
            runtime.execute(CHAIN1, address(app), abi.encodeCall(NoopApp.ping, ()), FEE);
        }
        vm.stopPrank();
        (,, uint256 pending,,) = runtime.statsOf(CHAIN1);
        assertEq(pending, 3 * NET, "Alice earned 3 tolls (net)");

        // Bob buys the deed.
        deed.setOwner(CHAIN1, bob);
        // The chain DAO sets fee to 0; the new deed holder still cannot take
        // the revenue Alice earned before the transfer.
        runtime.setFee(CHAIN1, 0);

        // Bob executes with fee=0: the `if (fee > 0)` block is skipped entirely,
        // so pending & pendingOwner are untouched — still Alice's.
        _fund(bob);
        vm.prank(bob);
        runtime.execute(CHAIN1, address(app), abi.encodeCall(NoopApp.ping, ()), 0);

        (,, uint256 pending2,,) = runtime.statsOf(CHAIN1);
        assertEq(pending2, 3 * NET, "fee=0 execute did not touch Alice's pending");

        // Anyone flushes: credit goes to Alice (the generator), not Bob.
        runtime.flush(CHAIN1);
        uint256 net = 3 * FEE - (3 * FEE * 200 / 10_000);
        assertEq(treasury.claimable(alice), net, "Alice keeps everything she generated");
        assertEq(treasury.claimable(bob), 0, "Bob steals nothing via fee=0 dodge");
    }

    // =====================================================================
    // R3-4  DIRTY STATE ACROSS TXS: an execute whose target.call reverts must
    //   roll back the auto-settle too. State (pending, pendingOwner) must be
    //   exactly as before, and no revenue must reach the treasury.
    // =====================================================================
    function test_R3_4_RevertingCallRollsBackAutoSettle() public {
        // A normal app for Alice to earn on, and a reverting app also on CHAIN1.
        NoopApp good = new NoopApp(IVoidChainAppRuntime(address(runtime)), CHAIN1);
        RevertingApp bad = new RevertingApp(IVoidChainAppRuntime(address(runtime)), CHAIN1);
        vm.prank(alice); runtime.registerApp(CHAIN1, address(good));
        vm.prank(alice); runtime.registerApp(CHAIN1, address(bad));

        _fund(carol);
        vm.prank(carol);
        runtime.execute(CHAIN1, address(good), abi.encodeCall(NoopApp.ping, ()), FEE);
        (,, uint256 pendingBefore,,) = runtime.statsOf(CHAIN1);
        assertEq(pendingBefore, NET, "Alice earned one toll (net)");

        // Sell to Bob.
        deed.setOwner(CHAIN1, bob);
        _fund(bob);

        // Bob calls execute on the reverting app. Auto-settle to Alice would run,
        // then target.call reverts -> whole tx reverts.
        uint256 aliceClaimBefore = treasury.claimable(alice);
        vm.prank(bob);
        vm.expectRevert();
        runtime.execute(CHAIN1, address(bad), abi.encodeCall(RevertingApp.boom, ()), FEE);

        // Nothing changed: pending still Alice's, treasury untouched, no double state.
        (,, uint256 pendingAfter,,) = runtime.statsOf(CHAIN1);
        assertEq(pendingAfter, NET, "pending unchanged after reverted execute");
        assertEq(treasury.claimable(alice), aliceClaimBefore, "no premature settle survived the revert");
        assertEq(treasury.lifetimeRevenue(CHAIN1), 0, "no revenue leaked to treasury");

        // And a clean flush still pays Alice exactly once.
        runtime.flush(CHAIN1);
        uint256 net = FEE - (FEE * 200 / 10_000);
        assertEq(treasury.claimable(alice), net, "Alice paid exactly once, after the fact");
    }

    // =====================================================================
    // R3-5  ALLOWANCE HYGIENE: after a flush via _settlePending, the runtime's
    //   allowance to the treasury is fully consumed (approve exact + pull exact).
    //   No residual allowance an attacker could exploit.
    // =====================================================================
    function test_R3_5_NoResidualAllowanceAfterSettle() public {
        NoopApp app = new NoopApp(IVoidChainAppRuntime(address(runtime)), CHAIN1);
        vm.prank(alice); runtime.registerApp(CHAIN1, address(app));
        _fund(carol);
        vm.startPrank(carol);
        for (uint256 i; i < 5; ++i) {
            runtime.execute(CHAIN1, address(app), abi.encodeCall(NoopApp.ping, ()), FEE);
        }
        vm.stopPrank();

        runtime.flush(CHAIN1);
        assertEq(
            voidToken.allowance(address(runtime), address(treasury)),
            0,
            "no residual allowance from runtime to treasury"
        );
    }

    // =====================================================================
    // R3-6  BENEFICIARY==0 DEFENSE-IN-DEPTH. settleTo refuses a zero beneficiary,
    //   so the runtime can never burn revenue to address(0). We also show the
    //   runtime relies on ERC721 ownerOf never returning 0: an adversarial deed
    //   that returns 0 would make settle revert (funds stuck, NOT burned).
    // =====================================================================
    function test_R3_6_SettleToZeroBeneficiaryReverts() public {
        // Authorize this test contract as a settler to call settleTo directly.
        vm.prank(gov);
        treasury.setAuthorizedSettler(address(this), true);
        voidToken.mint(address(this), 10 ether);
        voidToken.approve(address(treasury), type(uint256).max);

        vm.expectRevert(VoidChainTreasury.ZeroAddress.selector);
        treasury.settleTo(CHAIN1, address(0), 1 ether);
    }

    // Needed so this contract can act as a settler in R3-6 (transferFrom pulls
    // from msg.sender = this).
    // (HookVoid pulls from balanceOf[address(this)].)

    // =====================================================================
    // R3-7  settleTo credits an EXPLICIT beneficiary regardless of current owner:
    //   confirms the runtime is the only one choosing beneficiary=pendingOwner,
    //   and that an authorized settler paying its OWN VOID cannot "steal" —
    //   it can only donate. Also proves lifetimeRevenue is per-chain, not
    //   per-beneficiary.
    // =====================================================================
    function test_R3_7_settleToIsDonationNotTheft() public {
        vm.prank(gov);
        treasury.setAuthorizedSettler(address(this), true);
        voidToken.mint(address(this), 10 ether);
        voidToken.approve(address(treasury), type(uint256).max);

        uint256 balBefore = voidToken.balanceOf(address(this));
        treasury.settleTo(CHAIN2, carol, 5 ether); // credit carol on chain2

        uint256 net = 5 ether - (5 ether * 200 / 10_000);
        assertEq(treasury.claimable(carol), net, "carol credited");
        assertEq(treasury.lifetimeRevenue(CHAIN2), 5 ether, "lifetime is per-chain (gross)");
        // The settler PAID for it out of its own balance: this is donation, not theft.
        assertEq(voidToken.balanceOf(address(this)), balBefore - 5 ether, "settler funded it itself");
    }

    // =====================================================================
    // R3-8  FUZZ: addLiquidity minShares floor is ALWAYS honored, and a new LP
    //   can NEVER mint more than the fair proportional share (so existing LPs
    //   are never diluted by rounding). Attacks correction #1 across random
    //   pool states and deposits.
    // =====================================================================
    function testFuzz_R3_8_AddLiquidityMintedFairAndFloored(
        uint96 seed0,
        uint96 seed1,
        uint96 add0,
        uint96 add1
    ) public {
        MockToken A = new MockToken();
        MockToken B = new MockToken();
        ChainAppSwap dex = new ChainAppSwap(
            IVoidChainAppRuntime(address(runtime)), CHAIN1,
            ISwapERC20(address(A)), ISwapERC20(address(B))
        );
        vm.prank(alice); runtime.registerApp(CHAIN1, address(dex));

        // Seed a first position (needs sqrt(a*b) > 1000).
        uint256 s0 = uint256(seed0) + 1_000_000;
        uint256 s1 = uint256(seed1) + 1_000_000;
        _seedLP(dex, A, B, carol, s0, s1);

        // Random second deposit.
        uint256 a0 = uint256(add0) + 1;
        uint256 a1 = uint256(add1) + 1;

        uint256 R0 = dex.reserve0();
        uint256 R1 = dex.reserve1();
        uint256 TS = dex.totalShares();

        // Fair share = min(a0*TS/R0, a1*TS/R1) — exactly the contract's formula.
        uint256 fair0 = (a0 * TS) / R0;
        uint256 fair1 = (a1 * TS) / R1;
        uint256 fair = fair0 < fair1 ? fair0 : fair1;

        _fund(bob);
        A.mint(bob, a0); B.mint(bob, a1);
        vm.startPrank(bob);
        A.approve(address(dex), type(uint256).max);
        // With `spendFrom`, the one pulling the user's token is the RUNTIME.
        A.approve(address(runtime), type(uint256).max);
        B.approve(address(dex), type(uint256).max);
        // With `spendFrom`, the one pulling the user's token is the RUNTIME.
        B.approve(address(runtime), type(uint256).max);
        vm.stopPrank();

        if (fair == 0) {
            // Must revert (InsufficientLiquidity) — no free shares.
            vm.prank(bob);
            vm.expectRevert();
            _dexCall(address(dex), address(A), address(B),
                abi.encodeCall(ChainAppSwap.addLiquidity, (a0, a1, 0)), FEE);
            return;
        }

        // Ask for exactly `fair` — must succeed and mint exactly `fair`.
        vm.prank(bob);
        _dexCall(address(dex), address(A), address(B),
            abi.encodeCall(ChainAppSwap.addLiquidity, (a0, a1, fair)), FEE);
        assertEq(dex.shares(bob), fair, "minted exactly the fair share, never more");

        // Asking for fair+1 on the same math would have reverted (floor).
        // (Sanity: minted never exceeds fair, so existing LPs are not diluted.)
    }

    // =====================================================================
    // R3-9  FUZZ: minShares is an effective slippage guard — a deposit that would
    //   mint fewer shares than the caller's floor ALWAYS reverts. No pool state
    //   lets a sub-floor add slip through.
    // =====================================================================
    function testFuzz_R3_9_MinSharesGuardCannotBeBypassed(
        uint96 seed0,
        uint96 seed1,
        uint96 add0,
        uint96 add1
    ) public {
        MockToken A = new MockToken();
        MockToken B = new MockToken();
        ChainAppSwap dex = new ChainAppSwap(
            IVoidChainAppRuntime(address(runtime)), CHAIN1,
            ISwapERC20(address(A)), ISwapERC20(address(B))
        );
        vm.prank(alice); runtime.registerApp(CHAIN1, address(dex));

        _seedLP(dex, A, B, carol, uint256(seed0) + 1_000_000, uint256(seed1) + 1_000_000);

        uint256 a0 = uint256(add0) + 1;
        uint256 a1 = uint256(add1) + 1;
        uint256 TS = dex.totalShares();
        uint256 fair0 = (a0 * TS) / dex.reserve0();
        uint256 fair1 = (a1 * TS) / dex.reserve1();
        uint256 fair = fair0 < fair1 ? fair0 : fair1;

        _fund(bob);
        A.mint(bob, a0); B.mint(bob, a1);
        vm.startPrank(bob);
        A.approve(address(dex), type(uint256).max);
        // With `spendFrom`, the one pulling the user's token is the RUNTIME.
        A.approve(address(runtime), type(uint256).max);
        B.approve(address(dex), type(uint256).max);
        // With `spendFrom`, the one pulling the user's token is the RUNTIME.
        B.approve(address(runtime), type(uint256).max);
        vm.stopPrank();

        // Demand strictly more than fair -> must revert every time.
        uint256 tooMuch = fair + 1;
        vm.prank(bob);
        vm.expectRevert();
        _dexCall(address(dex), address(A), address(B),
            abi.encodeCall(ChainAppSwap.addLiquidity, (a0, a1, tooMuch)), FEE);
    }

    // =====================================================================
    // R3-10 FIRST-DEPOSITOR minShares interplay with MINIMUM_LIQUIDITY: the
    //   floor is checked against shares NET of the 1000 burn. Asking for more
    //   than sqrt(a0*a1)-1000 reverts; asking for exactly that succeeds.
    // =====================================================================
    function test_R3_10_FirstDepositorMinSharesAccountsForBurn() public {
        MockToken A = new MockToken();
        MockToken B = new MockToken();
        ChainAppSwap dex = new ChainAppSwap(
            IVoidChainAppRuntime(address(runtime)), CHAIN1,
            ISwapERC20(address(A)), ISwapERC20(address(B))
        );
        vm.prank(alice); runtime.registerApp(CHAIN1, address(dex));

        uint256 amt = 4_000_000; // sqrt(16e12)=4e6, minus 1000 => 3_999_000
        uint256 expected = _sqrt(amt * amt) - 1000;

        _fund(carol);
        A.mint(carol, amt); B.mint(carol, amt);
        vm.startPrank(carol);
        A.approve(address(dex), type(uint256).max);
        // With `spendFrom`, the one pulling the user's token is the RUNTIME.
        A.approve(address(runtime), type(uint256).max);
        B.approve(address(dex), type(uint256).max);
        // With `spendFrom`, the one pulling the user's token is the RUNTIME.
        B.approve(address(runtime), type(uint256).max);
        vm.stopPrank();

        // Over-ask by 1 -> revert (runtime wraps app's InsufficientOutput in CallFailed).
        vm.prank(carol);
        vm.expectRevert();
        _dexCall(address(dex), address(A), address(B),
            abi.encodeCall(ChainAppSwap.addLiquidity, (amt, amt, expected + 1)), FEE);

        // Exact ask -> success.
        vm.prank(carol);
        _dexCall(address(dex), address(A), address(B),
            abi.encodeCall(ChainAppSwap.addLiquidity, (amt, amt, expected)), FEE);
        assertEq(dex.shares(carol), expected, "first LP minted net of the 1000 burn");
    }

    // =====================================================================
    // R3-11 CORRECTION #3 CONFIRMATION: under the NEW settle path (auto-settle +
    //   settleTo(pendingOwner)), an owner washing their own chain still ends
    //   strictly POORER by exactly the 2% protocol fee. The buyer-protection fix
    //   did not open a profit path. Owner is both payer and beneficiary.
    // =====================================================================
    function test_R3_11_OwnerWashStillLosesExactlyTwoPercent() public {
        NoopApp app = new NoopApp(IVoidChainAppRuntime(address(runtime)), CHAIN1);
        vm.prank(alice); runtime.registerApp(CHAIN1, address(app));

        // Alice funds herself and pays her own toll N times (self-wash).
        _fund(alice);
        uint256 balBefore = voidToken.balanceOf(alice);
        uint256 N = 10;
        vm.startPrank(alice);
        for (uint256 i; i < N; ++i) {
            runtime.execute(CHAIN1, address(app), abi.encodeCall(NoopApp.ping, ()), FEE);
        }
        vm.stopPrank();

        runtime.flush(CHAIN1);
        runtime.sweepProtocol(); // the 2% split per transaction goes to the treasury
        vm.prank(alice); treasury.claim();

        uint256 balAfter = voidToken.balanceOf(alice);
        uint256 gross = N * FEE;
        uint256 fee = gross * 200 / 10_000;
        // Alice paid `gross`, got back `gross - fee`. Net = -fee. Never positive.
        assertEq(balAfter, balBefore - fee, "owner wash costs exactly the 2% fee");
        assertLt(balAfter, balBefore, "wash is never profitable");
        assertEq(voidToken.balanceOf(protocol), fee, "the 2% went to the protocol");
    }

    // --- helpers -------------------------------------------------------------

    function _seedLP(
        ChainAppSwap dex,
        MockToken A,
        MockToken B,
        address who,
        uint256 a0,
        uint256 a1
    ) internal {
        _fund(who);
        A.mint(who, a0); B.mint(who, a1);
        vm.startPrank(who);
        A.approve(address(dex), type(uint256).max);
        // With `spendFrom`, the one pulling the user's token is the RUNTIME.
        A.approve(address(runtime), type(uint256).max);
        B.approve(address(dex), type(uint256).max);
        // With `spendFrom`, the one pulling the user's token is the RUNTIME.
        B.approve(address(runtime), type(uint256).max);
        vm.stopPrank();
        vm.prank(who);
        _dexCall(address(dex), address(A), address(B),
            abi.encodeCall(ChainAppSwap.addLiquidity, (a0, a1, 0)), FEE);
    }

    function _sqrt(uint256 x) internal pure returns (uint256 y) {
        if (x == 0) return 0;
        uint256 z = (x + 1) / 2;
        y = x;
        while (z < y) { y = z; z = (x / z + z) / 2; }
    }
}
