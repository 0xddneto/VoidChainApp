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

contract MockVoid is IERC20 {
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

/// @notice VOID token variant that fires a hook to the RECIPIENT on transfer,
///         used to test whether the treasury's claim() is safe against a
///         reentrant/callback token (ERC-777 style).
contract HookVoid is IERC20 {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    address public hookTarget; // who gets called back on receiving a transfer
    bool public hookArmed;

    function mint(address to, uint256 a) external { balanceOf[to] += a; }
    function arm(address t) external { hookTarget = t; hookArmed = true; }
    function disarm() external { hookArmed = false; }

    function approve(address s, uint256 a) external returns (bool) {
        allowance[msg.sender][s] = a; return true;
    }
    function transfer(address to, uint256 a) external returns (bool) {
        balanceOf[msg.sender] -= a; balanceOf[to] += a;
        _maybeHook(to);
        return true;
    }
    function transferFrom(address f, address t, uint256 a) external returns (bool) {
        uint256 al = allowance[f][msg.sender];
        if (al != type(uint256).max) allowance[f][msg.sender] = al - a;
        balanceOf[f] -= a; balanceOf[t] += a;
        _maybeHook(t);
        return true;
    }
    function _maybeHook(address to) internal {
        if (hookArmed && to == hookTarget) {
            hookArmed = false; // one-shot to avoid infinite loop
            (bool ok,) = hookTarget.call(abi.encodeWithSignature("onTokenReceived()"));
            ok; // ignore
        }
    }
}

/// @notice A "well-behaved-looking" app that PASSES registration validation
///         (declares the correct chainId and runtime) but whose real intent,
///         once the runtime calls it during execute(), is to drain the runtime's
///         shared VOID balance -- the ~55 VOID of every chain pooled together.
contract EvilDrainApp {
    uint256 public immutable declaredChainId;
    address public immutable declaredRuntime;
    IERC20 public immutable voidToken;
    address public immutable thief;

    constructor(uint256 chainId_, address runtime_, IERC20 void_, address thief_) {
        declaredChainId = chainId_;
        declaredRuntime = runtime_;
        voidToken = void_;
        thief = thief_;
    }

    // Registration validation surface.
    function chainId() external view returns (uint256) { return declaredChainId; }
    function runtime() external view returns (address) { return declaredRuntime; }

    // Attack 1: try to pull the runtime's own VOID (needs allowance the runtime never grants).
    function pullRuntimeBalance(uint256 amount) external {
        // msg.sender is the runtime here (called via execute). We try to move
        // the runtime's balance to the thief.
        voidToken.transferFrom(declaredRuntime, thief, amount);
    }

    // Attack 2: try to re-enter execute / flush during our execution.
    function reenterFlush() external {
        VoidChainAppRuntime(declaredRuntime).flush(declaredChainId);
    }

    function reenterExecute(address target, bytes calldata data) external {
        VoidChainAppRuntime(declaredRuntime).execute(declaredChainId, target, data, type(uint256).max);
    }
}

/// @notice Honest fund-holding app: the confused-deputy target.
contract Vault is ChainAppBase {
    IERC20 public immutable token;
    mapping(address => uint256) public deposits;
    constructor(IVoidChainAppRuntime r, uint256 id, IERC20 t) ChainAppBase(r, id) { token = t; }
    function deposit(uint256 amount) external onlyFromMyChain {
        token.transferFrom(caller(), address(this), amount);
        deposits[caller()] += amount;
    }
}

/// @notice Registered proxy that forwards to a stored implementation chosen
///         AFTER registration -- tests the "register benign, behave malicious"
///         path against the confused-deputy defense.
contract MutableProxyApp is ChainAppBase {
    Vault public victim;
    constructor(IVoidChainAppRuntime r, uint256 id) ChainAppBase(r, id) {}
    function setVictim(Vault v) external { victim = v; }
    // Called by runtime during execute. Tries to make the victim act for the user
    // by calling it DIRECTLY (no runtime hop).
    function attack(uint256 amount) external onlyFromMyChain {
        victim.deposit(amount);
    }
}

/// @notice Malicious deed holder contract that re-enters treasury.claim() via a
///         token receive hook.
contract ReentrantClaimer {
    VoidChainTreasury public treasury;
    HookVoid public token;
    uint256 public reentries;

    function setup(VoidChainTreasury t, HookVoid v) external { treasury = t; token = v; }

    function onTokenReceived() external {
        // Try to claim again while inside the first claim's transfer.
        reentries++;
        treasury.claim();
    }

    function doClaim() external { treasury.claim(); }
}

/**
 * RED TEAM — tentativas reais de roubo contra runtime / treasury / DEX.
 *
 * Green in this file means: the DEFENSE held (the theft reverted as expected)
 * OR the observed behavior is the documented one. Each test says which.
 */
contract RedTeamTest is Test {
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

    MockOracle oracle;

    /// @dev The direct path also declares a budget: applications pull via
    ///      `spendFrom`, and with no declared ceiling the runtime refuses.


    VoidChainAppRuntime runtime;
    VoidChainTreasury treasury;
    FakeDeed deed;
    MockVoid voidToken;

    address alice = address(0xA11CE);   // dona da chain 1
    address bob = address(0xB0B);       // owner of chain 2
    address user = address(0x5E12);     // an honest user
    address thief = address(0xBADBAD);  // atacante
    address protocolTreasury = address(0x9001);
    address governance = address(0x6009);

    uint256 constant CHAIN1 = 1;
    uint256 constant CHAIN2 = 2;
    uint256 constant FEE = 0.01 ether;

    function setUp() public {
        deed = new FakeDeed();
        voidToken = new MockVoid();
        treasury = new VoidChainTreasury(
            ITreasuryDeed(address(deed)), ITreasuryERC20(address(voidToken)),
            protocolTreasury, governance
        );
        oracle = new MockOracle();
        runtime = new VoidChainAppRuntime(
            IVoidChainDeed(address(deed)), IERC20(address(voidToken)),
            IVoidChainTreasury(address(treasury))
        );
        runtime.setOracle(IRuntimeOracle(address(oracle)));

        // Correcao do achado K: settle agora e' restrito. Autoriza o runtime.
        vm.prank(governance);
        treasury.setAuthorizedSettler(address(runtime), true);

        deed.setOwner(CHAIN1, alice);
        deed.setOwner(CHAIN2, bob);
        vm.prank(alice); runtime.activate(CHAIN1, FEE);
        vm.prank(bob);   runtime.activate(CHAIN2, FEE);

        voidToken.mint(user, 1000 ether);
        vm.prank(user);
        voidToken.approve(address(runtime), type(uint256).max);

        // The thief also owns a chain (chain 2 is Bob's; give the thief chain 3).
        deed.setOwner(3, thief);
        vm.prank(thief); runtime.activate(3, 0);
        voidToken.mint(thief, 1000 ether);
        vm.prank(thief);
        voidToken.approve(address(runtime), type(uint256).max);
    }

    // Seed the runtime with pooled revenue from several chains, like production.
    function _seedRuntimeRevenue() internal {
        Vault app1 = new Vault(IVoidChainAppRuntime(address(runtime)), CHAIN1, IERC20(address(voidToken)));
        Vault app2 = new Vault(IVoidChainAppRuntime(address(runtime)), CHAIN2, IERC20(address(voidToken)));
        vm.prank(alice); runtime.registerApp(CHAIN1, address(app1));
        vm.prank(bob);   runtime.registerApp(CHAIN2, address(app2));
        vm.startPrank(user);
        voidToken.approve(address(app1), type(uint256).max);
        voidToken.approve(address(app2), type(uint256).max);
        for (uint256 i; i < 50; ++i) {
            runtime.execute(CHAIN1, address(app1), abi.encodeCall(Vault.deposit, (1)), FEE);
        }
        for (uint256 i; i < 5; ++i) {
            runtime.execute(CHAIN2, address(app2), abi.encodeCall(Vault.deposit, (1)), FEE);
        }
        vm.stopPrank();
    }

    // =====================================================================
    // ATTACK A -- draining the runtime shared balance with a "valid" but
    //            malicious app, registered on the attacker's own chain.
    // =====================================================================
    function test_A_EvilAppCannotDrainRuntimePooledVoid() public {
        _seedRuntimeRevenue();
        uint256 pooled = voidToken.balanceOf(address(runtime));
        assertGt(pooled, 0, "the runtime should hold revenue from several chains");

        // The attacker registers an app that PASSES validation (chainId 3, right
        // runtime) on chain 3, which they own.
        EvilDrainApp evil = new EvilDrainApp(3, address(runtime), IERC20(address(voidToken)), thief);
        vm.prank(thief);
        runtime.registerApp(3, address(evil));

        // The attacker runs the app, which tries to pull ALL the VOID out of the runtime.
        // Deve reverter: o runtime nunca deu allowance ao app.
        vm.prank(thief);
        vm.expectRevert(); // transferFrom with no allowance
        runtime.execute(
            3, address(evil),
            abi.encodeCall(EvilDrainApp.pullRuntimeBalance, (pooled)),
            type(uint256).max
        );

        assertEq(voidToken.balanceOf(address(runtime)), pooled, "nothing left the runtime");
        assertEq(voidToken.balanceOf(thief) >= 0, true);
    }

    // =====================================================================
    // ATAQUE B — reentrar flush() de dentro de um app durante execute(),
    //            to withdraw the pending unexpectedly / twice.
    // =====================================================================
    function test_B_EvilAppCannotReenterFlushDuringExecute() public {
        _seedRuntimeRevenue();
        EvilDrainApp evil = new EvilDrainApp(3, address(runtime), IERC20(address(voidToken)), thief);
        // Give chain 3 some pending so flush would have something to move.
        vm.prank(thief); runtime.setFee(3, FEE);
        vm.prank(thief); runtime.registerApp(3, address(evil));
        // pay a fee once so pending[3] > 0
        vm.prank(thief);
        runtime.execute(3, address(evil), abi.encodeCall(EvilDrainApp.chainId, ()), FEE);

        // Now try to reenter flush from inside execute.
        vm.prank(thief);
        vm.expectRevert(); // ReentrancyGuard: reentrant call
        runtime.execute(3, address(evil), abi.encodeCall(EvilDrainApp.reenterFlush, ()), FEE);
    }

    // =====================================================================
    // ATTACK C -- reentering execute() (nested execution) to confuse whose turn it is.
    // =====================================================================
    function test_C_NestedExecuteIsBlocked() public {
        EvilDrainApp evil = new EvilDrainApp(3, address(runtime), IERC20(address(voidToken)), thief);
        vm.prank(thief); runtime.setFee(3, 0);
        vm.prank(thief); runtime.registerApp(3, address(evil));

        vm.prank(thief);
        vm.expectRevert(); // nonReentrant
        runtime.execute(
            3, address(evil),
            abi.encodeCall(EvilDrainApp.reenterExecute, (address(evil), abi.encodeCall(EvilDrainApp.chainId, ()))),
            0
        );
    }

    // =====================================================================
    // ATTACK D -- confused deputy with a proxy app registered as benign that
    //            changes behavior afterwards.
    // =====================================================================
    function test_D_ConfusedDeputyViaMutableProxyBlocked() public {
        Vault victim = new Vault(IVoidChainAppRuntime(address(runtime)), CHAIN1, IERC20(address(voidToken)));
        MutableProxyApp proxy = new MutableProxyApp(IVoidChainAppRuntime(address(runtime)), CHAIN1);

        vm.prank(alice); runtime.registerApp(CHAIN1, address(victim));
        vm.prank(thief); runtime.registerApp(CHAIN1, address(proxy)); // qualquer um publica

        // Once registered, the proxy points at the victim.
        proxy.setVictim(victim);

        // The user approved the victim (a legitimate app) and uses the proxy thinking it is harmless.
        vm.prank(user);
        voidToken.approve(address(victim), type(uint256).max);

        uint256 before = voidToken.balanceOf(user);
        vm.prank(user);
        vm.expectRevert(); // victim rejects a call that did not come from the runtime
        runtime.execute(CHAIN1, address(proxy), abi.encodeCall(MutableProxyApp.attack, (100 ether)), FEE);

        assertEq(voidToken.balanceOf(user), before, "not even the toll left");
        assertEq(victim.deposits(user), 0, "nothing deposited on behalf of the user");
    }

    // =====================================================================
    // ATTACK E -- one chain withdraws another chain's pending via flush.
    // =====================================================================
    function test_E_FlushCannotStealAnotherChainsPending() public {
        _seedRuntimeRevenue(); // chain1: 50 fees, chain2: 5 fees
        uint256 pooled = voidToken.balanceOf(address(runtime));
        assertEq(pooled, FEE * 55, "sum of both chains");

        // The attacker controls chain 3, with no revenue. They try to flush chain 1.
        // flush takes no "pay whom" beyond the tokenId; it pays chain 1,
        // crediting chain 1's OWNER (alice), not the attacker.
        runtime.flush(CHAIN1);

        // Chain 3 (the attacker) received nothing; alice received.
        assertEq(treasury.claimable(thief), 0, "the attacker does not receive somebody else revenue");
        assertGt(treasury.claimable(alice), 0, "a dona legitima recebeu");
        // The runtime still holds: all of chain 2 (5 tolls) PLUS chain 1 2% that
        // was split in execute and not yet swept. Only chain 1 owner's net left
        // -- nothing from chain 2, nothing for the attacker.
        uint256 chain1OwnerNet = 50 * (FEE - (FEE * 200) / 10_000);
        assertEq(voidToken.balanceOf(address(runtime)), FEE * 55 - chain1OwnerNet, "so o liquido da chain 1 saiu");
    }

    // =====================================================================
    // ATTACK F -- reentrancy in the treasury claim(), with a callback token.
    //            Tests the checks-effects-interactions protection + nonReentrant.
    // =====================================================================
    function test_F_TreasuryClaimReentrancyBlocked() public {
        // A fresh treasury with a token that fires a hook on receipt.
        HookVoid htoken = new HookVoid();
        VoidChainTreasury htreasury = new VoidChainTreasury(
            ITreasuryDeed(address(deed)), ITreasuryERC20(address(htoken)),
            protocolTreasury, governance
        );
        ReentrantClaimer evil = new ReentrantClaimer();
        evil.setup(htreasury, htoken);

        // This test settles directly -- it authorizes itself on the new treasury.
        vm.prank(governance);
        htreasury.setAuthorizedSettler(address(this), true);

        // The attacker owns chain 7 and accrues legitimate revenue in the treasury.
        deed.setOwner(7, address(evil));
        htoken.mint(address(this), 100 ether);
        htoken.approve(address(htreasury), type(uint256).max);
        htreasury.settle(7, 100 ether); // credits 98 ether to evil (owner of 7)

        uint256 credited = htreasury.claimable(address(evil));
        assertGt(credited, 0, "o atacante tem saldo legitimo a sacar");

        // Arms the hook to reenter when evil receives the tokens.
        htoken.arm(address(evil));

        // A reentrada (segunda claim) bate no nonReentrant e reverte; o token
        // THE HOSTILE ONE SWALLOWS that revert (a low-level call is ignored). Even
        // so, the CEI order (claimable cleared BEFORE the transfer) guarantees the
        // reentry would have found 0 -> no double payment. It pays EXACTLY once.
        evil.doClaim();

        assertEq(htreasury.claimable(address(evil)), 0, "credit consumed once");
        assertEq(htoken.balanceOf(address(evil)), credited, "paid exactly the credit, no doubling");
    }

    // =====================================================================
    // ATTACK G -- extracting value from the DEX with a round trip (buy and sell).
    //            The x*y=k invariant must not return more than went in.
    // =====================================================================
    function test_G_DexRoundTripCannotExtractValue() public {
        MockVoid tokenA = new MockVoid();
        MockVoid tokenB = new MockVoid();
        ChainAppSwap dex = new ChainAppSwap(
            IVoidChainAppRuntime(address(runtime)), CHAIN1,
            ISwapERC20(address(tokenA)), ISwapERC20(address(tokenB))
        );
        vm.prank(alice); runtime.registerApp(CHAIN1, address(dex));

        // Alice needs VOID to pay the toll for addLiquidity.
        voidToken.mint(alice, 100 ether);

        // Liquidez inicial grande.
        tokenA.mint(alice, 1_000_000 ether);
        tokenB.mint(alice, 1_000_000 ether);
        vm.startPrank(alice);
        voidToken.approve(address(runtime), type(uint256).max);
        tokenA.approve(address(dex), type(uint256).max);
        // With `spendFrom`, the one pulling the user's token is the RUNTIME.
        tokenA.approve(address(runtime), type(uint256).max);
        tokenB.approve(address(dex), type(uint256).max);
        // With `spendFrom`, the one pulling the user's token is the RUNTIME.
        tokenB.approve(address(runtime), type(uint256).max);
        runtime.executeWithBudget(CHAIN1, address(dex),
            abi.encodeCall(ChainAppSwap.addLiquidity, (500_000 ether, 500_000 ether, 0)), FEE, _authTwo(address(tokenA), address(tokenB)));
        vm.stopPrank();

        // The attacker starts with 10,000 A. Does A->B and then B->A.
        tokenA.mint(thief, 10_000 ether);
        vm.startPrank(thief);
        tokenA.approve(address(dex), type(uint256).max);
        // With `spendFrom`, the one pulling the user's token is the RUNTIME.
        tokenA.approve(address(runtime), type(uint256).max);
        tokenB.approve(address(dex), type(uint256).max);
        // With `spendFrom`, the one pulling the user's token is the RUNTIME.
        tokenB.approve(address(runtime), type(uint256).max);

        uint256 startA = tokenA.balanceOf(thief);
        runtime.executeWithBudget(CHAIN1, address(dex),
            abi.encodeCall(ChainAppSwap.swap, (true, 10_000 ether, 0)), FEE, _authTwo(address(tokenA), address(tokenB)));
        uint256 gotB = tokenB.balanceOf(thief);
        runtime.executeWithBudget(CHAIN1, address(dex),
            abi.encodeCall(ChainAppSwap.swap, (false, gotB, 0)), FEE, _authTwo(address(tokenA), address(tokenB)));
        uint256 endA = tokenA.balanceOf(thief);
        vm.stopPrank();

        assertLt(endA, startA, "round-trip sempre perde a taxa; nunca extrai valor");
    }

    // =====================================================================
    // ATTACK H -- the owner charges the toll WITHOUT executing (charging on failure).
    //            If the target reverts, the whole tx reverts and nothing is charged.
    // =====================================================================
    function test_H_NoTollWhenExecutionReverts() public {
        // An app that always reverts.
        RevertingApp bad = new RevertingApp(IVoidChainAppRuntime(address(runtime)), CHAIN1);
        vm.prank(alice); runtime.registerApp(CHAIN1, address(bad));

        uint256 before = voidToken.balanceOf(user);
        vm.prank(user);
        vm.expectRevert();
        runtime.execute(CHAIN1, address(bad), abi.encodeCall(RevertingApp.boom, ()), FEE);

        assertEq(voidToken.balanceOf(user), before, "the toll must not be charged without execution");
        (,, uint256 pending,,) = runtime.statsOf(CHAIN1);
        assertEq(pending, 0, "pending did not rise");
    }

    // =====================================================================
    // ATTACK I -- the owner raises the toll without limit.
    //
    // The global ceiling left by design decision. This test now proves what
    // remains true: raising the toll does not allow charging someone who already
    // signed accepting less. The owner charges what they like; the payer decides
    // paga.
    // =====================================================================
    function test_I_RaisingTollCannotBillWhoAlreadySignedForLess() public {
        Vault app = new Vault(IVoidChainAppRuntime(address(runtime)), CHAIN1, IERC20(address(voidToken)));
        vm.prank(alice); runtime.registerApp(CHAIN1, address(app));

        vm.prank(alice);
        runtime.setFee(CHAIN1, 1_000 ether); // no ceiling, and that is fine

        voidToken.mint(thief, 10_000 ether);
        vm.prank(thief); voidToken.approve(address(runtime), type(uint256).max);

        // The payer declared FEE as their limit. The toll is now a thousand times
        // larger, and the call refuses instead of charging what they did not accept.
        vm.prank(thief);
        vm.expectRevert();
        runtime.execute(CHAIN1, address(app),
            abi.encodeCall(Vault.deposit, (1)), FEE /* limite antigo */);
    }

    // =====================================================================
    // FINDING J (MEDIUM) -- the deployed DEX (ChainAppSwap) has NO
    //   removeLiquidity. Whoever provides liquidity NEVER gets the tokens back.
    //   It contradicts the contract own comment ("both do exactly the same
    //   thing" as VoidSwap, which HAS removeLiquidity).
    // =====================================================================
    function test_J_ChainAppSwapLiquidityIsPermanentlyLocked() public {
        MockVoid tokenA = new MockVoid();
        MockVoid tokenB = new MockVoid();
        ChainAppSwap dex = new ChainAppSwap(
            IVoidChainAppRuntime(address(runtime)), CHAIN1,
            ISwapERC20(address(tokenA)), ISwapERC20(address(tokenB))
        );
        vm.prank(alice); runtime.registerApp(CHAIN1, address(dex));
        voidToken.mint(alice, 100 ether);

        tokenA.mint(alice, 1_000_000 ether);
        tokenB.mint(alice, 1_000_000 ether);
        vm.startPrank(alice);
        voidToken.approve(address(runtime), type(uint256).max);
        tokenA.approve(address(dex), type(uint256).max);
        // With `spendFrom`, the one pulling the user's token is the RUNTIME.
        tokenA.approve(address(runtime), type(uint256).max);
        tokenB.approve(address(dex), type(uint256).max);
        // With `spendFrom`, the one pulling the user's token is the RUNTIME.
        tokenB.approve(address(runtime), type(uint256).max);
        uint256 balBefore = tokenA.balanceOf(alice);
        runtime.executeWithBudget(CHAIN1, address(dex),
            abi.encodeCall(ChainAppSwap.addLiquidity, (300_000 ether, 300_000 ether, 0)), FEE, _authTwo(address(tokenA), address(tokenB)));
        vm.stopPrank();

        // Alice agora tem cotas...
        assertGt(dex.shares(alice), 0, "recebeu cotas de LP");
        // ...but the tokens left her wallet.
        assertEq(tokenA.balanceOf(alice), balBefore - 300_000 ether, "tokens went to the DEX");

        // The removeLiquidity function (which exists in VoidSwap) does NOT exist here:
        // a raw call to the selector falls through and reverts (no fallback).
        (bool ok,) = address(dex).call(
            abi.encodeWithSignature("removeLiquidity(uint256)", dex.shares(alice))
        );
        assertFalse(ok, "removeLiquidity does NOT exist on the deployed DEX -> funds locked");

        // Nem via runtime.execute existe caminho de resgate: o unico jeito de um
        // token sair e' via swap, entregando o OUTRO token. A posicao de LP pura
        // e' irrecuperavel.
    }

    // =====================================================================
    // ACHADO K (BAIXO/INFO) — treasury.settle e' permissionless. Qualquer um
    //   inflates lifetimeRevenue[tokenId] of ANY chain (a metric used "for the
    //   explorer and price discovery"). To pump your OWN chain before selling,
    //   the net cost is only 2% (98% comes back to the owner themselves).
    // =====================================================================
    /// CORRIGIDO: settle agora exige repassador autorizado. O ataque de inflar
    /// the metric with your own VOID stopped being possible.
    function test_K_LifetimeRevenueSpoofIsNowBlocked() public {
        uint256 targetChain = 9;
        deed.setOwner(targetChain, address(0xDEED9));

        uint256 fakeRevenue = 10_000 ether;
        voidToken.mint(thief, fakeRevenue);
        vm.startPrank(thief);
        voidToken.approve(address(treasury), type(uint256).max);
        vm.expectRevert(
            abi.encodeWithSelector(VoidChainTreasury.NotAuthorizedSettler.selector, thief)
        );
        treasury.settle(targetChain, fakeRevenue);
        vm.stopPrank();

        assertEq(treasury.lifetimeRevenue(targetChain), 0, "a metrica continua honesta");
    }

    // =====================================================================
    // ACHADO J — CORRIGIDO: ChainAppSwap agora tem removeLiquidity, e o LP
    //            recovers their liquidity instead of losing it forever.
    // =====================================================================
    function test_J_ChainAppSwapLiquidityIsNowRecoverable() public {
        MockVoid tokenX = new MockVoid();
        MockVoid tokenY = new MockVoid();
        ChainAppSwap dex = new ChainAppSwap(
            IVoidChainAppRuntime(address(runtime)), CHAIN1,
            ISwapERC20(address(tokenX)), ISwapERC20(address(tokenY))
        );
        vm.prank(alice);
        runtime.registerApp(CHAIN1, address(dex));

        address lp = address(0x11FE);
        tokenX.mint(lp, 1_000_000 ether);
        tokenY.mint(lp, 1_000_000 ether);
        voidToken.mint(lp, 10 ether);
        vm.startPrank(lp);
        tokenX.approve(address(dex), type(uint256).max);
        // With `spendFrom`, the one pulling the user's token is the RUNTIME.
        tokenX.approve(address(runtime), type(uint256).max);
        tokenY.approve(address(dex), type(uint256).max);
        // With `spendFrom`, the one pulling the user's token is the RUNTIME.
        tokenY.approve(address(runtime), type(uint256).max);
        voidToken.approve(address(runtime), type(uint256).max);
        vm.stopPrank();

        // O LP deposita.
        vm.prank(lp);
        runtime.executeWithBudget(CHAIN1, address(dex),
            abi.encodeCall(ChainAppSwap.addLiquidity, (100_000 ether, 100_000 ether, 0)), FEE, _authTwo(address(tokenX), address(tokenY)));

        uint256 sh = dex.shares(lp);
        assertGt(sh, 0, "recebeu cotas");
        uint256 beforeX = tokenX.balanceOf(lp);

        // AND RECOVERS -- what used to be impossible.
        vm.prank(lp);
        runtime.executeWithBudget(CHAIN1, address(dex),
            abi.encodeCall(ChainAppSwap.removeLiquidity, (sh)), FEE, _authTwo(address(tokenX), address(tokenY)));

        assertEq(dex.shares(lp), 0, "cotas resgatadas");
        assertGt(tokenX.balanceOf(lp), beforeX, "the tokens came back to the LP");
    }
}
contract RevertingApp is ChainAppBase {
    constructor(IVoidChainAppRuntime r, uint256 id) ChainAppBase(r, id) {}
    function boom() external view onlyFromMyChain { revert("boom"); }
}
