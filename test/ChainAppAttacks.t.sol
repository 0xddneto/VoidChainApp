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
import {VoidChainTreasury, IERC20 as ITreasuryERC20} from "../contracts/parent/VoidChainTreasury.sol";
import {IVoidChainDeed as ITreasuryDeed} from "../contracts/parent/VoidChainTreasury.sol";

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

/// @notice An honest app that moves the user's funds, trusting `caller()`.
/// @dev    It is the shape of any useful app: it charges the user to give
///         something back. Which is exactly why it is the confused-deputy target.
contract Vault is ChainAppBase {
    IERC20 public immutable token;
    mapping(address => uint256) public deposits;

    constructor(IVoidChainAppRuntime r, uint256 id, IERC20 t) ChainAppBase(r, id) {
        token = t;
    }

    function deposit(uint256 amount) external onlyFromMyChain {
        token.transferFrom(caller(), address(this), amount);
        deposits[caller()] += amount;
    }
}

/// @notice A hostile app, published on the SAME chain -- which anyone can do.
contract ConfusedDeputyAttacker is ChainAppBase {
    Vault public immutable victim;

    constructor(IVoidChainAppRuntime r, uint256 id, Vault v) ChainAppBase(r, id) {
        victim = v;
    }

    /// @dev The user calls this thinking they are using a harmless app. Inside,
    ///      we call the Vault DIRECTLY -- without going through the runtime. The
    ///      Vault sees the right `executingChain` and an `executingCaller` equal
    ///      to the user, and concludes the user asked for it.
    function drain(uint256 amount) external onlyFromMyChain {
        victim.deposit(amount);
    }
}

/**
 * Attacks against the chainapp runtime.
 *
 * These tests first existed to PROVE real failures found in review, and stay in
 * the repository after they were fixed -- an attack test that passes is the only
 * guarantee the fix will not be undone by accident in a future refactor.
 * in a future refactor.
 */
contract ChainAppAttackTest is Test {
    MockOracle oracle;

    VoidChainAppRuntime runtime;
    VoidChainTreasury treasury;
    FakeDeed deed;
    MockVoid voidToken;

    address alice = address(0xA11CE);
    address bob = address(0xB0B);
    address user = address(0x5E12);
    address attacker = address(0xBAD);

    uint256 constant CHAIN1 = 1;
    uint256 constant CHAIN2 = 2;
    uint256 constant FEE = 0.01 ether;

    function setUp() public {
        deed = new FakeDeed();
        voidToken = new MockVoid();
        treasury = new VoidChainTreasury(
            ITreasuryDeed(address(deed)), ITreasuryERC20(address(voidToken)),
            address(0x9001), address(0x6009)
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

        // The runtime settles revenue into the treasury via flush -- authorized.
        vm.prank(address(0x6009));
        treasury.setAuthorizedSettler(address(runtime), true);
        vm.prank(alice);
        runtime.activate(CHAIN1, FEE);
        vm.prank(bob);
        runtime.activate(CHAIN2, FEE);

        voidToken.mint(user, 1000 ether);
        vm.prank(user);
        voidToken.approve(address(runtime), type(uint256).max);
    }

    // =======================================================================
    // ATTACK 1 -- draining the runtime by registering a token as an application
    // =======================================================================

    /// @notice The runtime holds the VOID of EVERY chain. If it can be induced
    ///         to call an arbitrary ERC-20, it signs a transfer of its own
    ///         balance -- and that balance is not its own, it belongs to everyone.
    ///
    /// @dev    Anyone can publish applications, which is correct. But
    ///         "publishing" must not mean "pointing at any address": the
    ///         registry has to require the target to genuinely be an application
    ///         of this chain, and not the token's contract.
    function test_RegisteringTheVoidTokenIsRejected() public {
        // The attacker tries to publish the VOID contract itself as an
        // application of their chain. If it worked, they would call `transfer`
        vm.expectRevert();
        vm.prank(attacker);
        runtime.registerApp(CHAIN2, address(voidToken));
    }

    /// @notice Not even the runtime can be registered as an application of itself.
    function test_RegisteringTheRuntimeIsRejected() public {
        vm.expectRevert();
        vm.prank(attacker);
        runtime.registerApp(CHAIN2, address(runtime));
    }

    /// @notice An application from ANOTHER chain cannot be published here.
    /// @dev    The registry checks the `chainId` the app itself declares.
    function test_RegisteringAnotherChainsAppIsRejected() public {
        Vault appOfChain1 = new Vault(
            IVoidChainAppRuntime(address(runtime)), CHAIN1, IERC20(address(voidToken))
        );
        vm.expectRevert();
        vm.prank(bob);
        runtime.registerApp(CHAIN2, address(appOfChain1));
    }

    /// @notice An app pointing at ANOTHER runtime does not get in.
    function test_RegisteringAnAppOfAnotherRuntimeIsRejected() public {
        VoidChainAppRuntime other = new VoidChainAppRuntime(
            IVoidChainDeed(address(deed)), IERC20(address(voidToken)),
            IVoidChainTreasury(address(treasury))
        );
        Vault foreign = new Vault(
            IVoidChainAppRuntime(address(other)), CHAIN2, IERC20(address(voidToken))
        );
        vm.expectRevert();
        vm.prank(bob);
        runtime.registerApp(CHAIN2, address(foreign));
    }

    // =======================================================================
    // ATTACK 2 -- confused deputy between applications of the same chain
    // =======================================================================

    /// @notice A hostile application calls another DIRECTLY, and the victim
    ///         believes the user is the one who asked.
    ///
    /// @dev    This is the subtlest of the three. While an execution is under
    ///         way, `executingCaller` points at the user -- and any contract of
    ///         that chain, called by any path, reads the same value. A malicious
    ///         app published on the same chain (which anyone can do) uses that
    ///         to act on behalf of whoever called it.
    ///
    ///         The defense is for the app to require that its caller be the
    ///         runtime, and not merely that the executing chain be the right one.
    function test_AppCannotImpersonateTheUserToAnotherApp() public {
        Vault victim = new Vault(
            IVoidChainAppRuntime(address(runtime)), CHAIN1, IERC20(address(voidToken))
        );
        ConfusedDeputyAttacker evil = new ConfusedDeputyAttacker(
            IVoidChainAppRuntime(address(runtime)), CHAIN1, victim
        );

        vm.prank(alice);
        runtime.registerApp(CHAIN1, address(victim));
        vm.prank(attacker);
        runtime.registerApp(CHAIN1, address(evil));

        // The user approved the vault, as they would with any legitimate app.
        vm.prank(user);
        voidToken.approve(address(victim), type(uint256).max);

        uint256 before = voidToken.balanceOf(user);

        // The user uses the hostile app thinking it is harmless.
        vm.prank(user);
        vm.expectRevert(); // the victim has to refuse the indirect call
        runtime.execute(CHAIN1, address(evil), abi.encodeCall(ConfusedDeputyAttacker.drain, (100 ether)), type(uint256).max);

        // The whole transaction reverts, so not even the toll is charged -- the
        // user does not pay to be attacked.
        assertEq(voidToken.balanceOf(user), before, "not even the toll should have left");
        assertEq(victim.deposits(user), 0, "nothing should have been deposited for the user");
    }

    // =======================================================================
    // ATTACK 3 -- the DAO changes the fee before the user's transaction
    // =======================================================================

    /// @notice A passed DAO action can raise the fee before a transaction, but
    ///         it cannot charge more VOID than the payer already accepted.
    ///
    /// @dev    I had argued the toll needs no delay because "the user sees the
    ///         price before signing". That is false: between signing and
    ///         executing there is the queue, and the owner can act inside it.
    ///         The correct defense is not a delay, it is the user stating the
    ///         most they accept paying -- the same way a DEX swap declares its
    ///         deslizamento tolerado.
    function test_DaoCannotChargeAboveTheSignedFee() public {
        Vault app = new Vault(
            IVoidChainAppRuntime(address(runtime)), CHAIN1, IERC20(address(voidToken))
        );
        vm.prank(alice);
        runtime.registerApp(CHAIN1, address(app));

        // The user accepts paying at most the advertised toll.
        uint256 accepted = runtime.feeOf(CHAIN1);

        // The chain DAO raises the fee before execution.
        runtime.setFee(CHAIN1, 100 ether);

        uint256 before = voidToken.balanceOf(user);

        vm.expectRevert();
        vm.prank(user);
        runtime.execute(CHAIN1, address(app), abi.encodeCall(Vault.deposit, (1 ether)), accepted);

        assertEq(voidToken.balanceOf(user), before, "not a single wei should have left");
    }

    /// @notice Accepting the new price, the call goes through -- the payer decides.
    function test_UserWhoAcceptsTheNewTollGoesThrough() public {
        Vault app = new Vault(
            IVoidChainAppRuntime(address(runtime)), CHAIN1, IERC20(address(voidToken))
        );
        vm.prank(alice);
        runtime.registerApp(CHAIN1, address(app));
        vm.prank(user);
        voidToken.approve(address(app), type(uint256).max);

        runtime.setFee(CHAIN1, 1 ether);

        vm.prank(user);
        runtime.execute(CHAIN1, address(app), abi.encodeCall(Vault.deposit, (5 ether)), 1 ether);

        assertEq(app.deposits(user), 5 ether);
    }

    // =======================================================================
    // Integridade do dinheiro guardado
    // =======================================================================

    /// @notice The runtime never hands over more than the chain is owed.
    /// @dev    It holds the VOID of every chain in the same balance. The
    ///         separation is accounting, so a settlement that ignored one
    ///         chain's `pending` would be spending the other chains' money.
    function test_FlushNeverSpendsAnotherChainsMoney() public {
        Vault app1 = new Vault(IVoidChainAppRuntime(address(runtime)), CHAIN1, IERC20(address(voidToken)));
        Vault app2 = new Vault(IVoidChainAppRuntime(address(runtime)), CHAIN2, IERC20(address(voidToken)));
        vm.prank(alice);
        runtime.registerApp(CHAIN1, address(app1));
        vm.prank(bob);
        runtime.registerApp(CHAIN2, address(app2));
        vm.prank(user);
        voidToken.approve(address(app1), type(uint256).max);
        vm.prank(user);
        voidToken.approve(address(app2), type(uint256).max);

        // Chain 1 is used ten times; chain 2, once.
        vm.startPrank(user);
        for (uint256 i; i < 10; ++i) {
            runtime.execute(CHAIN1, address(app1), abi.encodeCall(Vault.deposit, (1)), FEE);
        }
        runtime.execute(CHAIN2, address(app2), abi.encodeCall(Vault.deposit, (1)), FEE);
        vm.stopPrank();

        uint256 held = voidToken.balanceOf(address(runtime));
        assertEq(held, FEE * 11, "the runtime holds the sum of both chains");

        runtime.flush(CHAIN2);

        // Chain 2 took only what was its own (chain 2 owner's net).
        uint256 net = FEE - (FEE * 200) / 10_000;
        // The runtime still holds: everything (11*FEE) minus the net that left chain 2.
        assertEq(voidToken.balanceOf(address(runtime)), FEE * 11 - net, "so o liquido da chain 2 saiu");
        assertEq(treasury.claimable(bob), net, "the owner of chain 2 received theirs");
        assertEq(treasury.claimable(alice), 0, "chain 1 was not touched");
    }

    /// @notice Settling twice in a row does not pay twice.
    function test_DoubleFlushPaysOnce() public {
        Vault app = new Vault(IVoidChainAppRuntime(address(runtime)), CHAIN1, IERC20(address(voidToken)));
        vm.prank(alice);
        runtime.registerApp(CHAIN1, address(app));
        vm.prank(user);
        voidToken.approve(address(app), type(uint256).max);

        vm.prank(user);
        runtime.execute(CHAIN1, address(app), abi.encodeCall(Vault.deposit, (1)), FEE);

        runtime.flush(CHAIN1);
        vm.expectRevert(VoidChainAppRuntime.NothingToFlush.selector);
        runtime.flush(CHAIN1);

        uint256 net = FEE - (FEE * 200) / 10_000;
        assertEq(treasury.claimable(alice), net, "the owner was paid once only (net)");
        (,,, uint256 lifetime,) = runtime.statsOf(CHAIN1);
        assertEq(lifetime, FEE, "gross counted once only");
    }
}
