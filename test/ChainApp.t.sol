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

// Implements only one of the two identical interfaces; where the other is
// required, the address is cast. Inheriting both would demand an `override` for
// a function that is the same in both places -- ceremony with no content.
contract FakeDeed is IVoidChainDeed {
    mapping(uint256 => address) public owners;

    function setOwner(uint256 tokenId, address owner) external {
        owners[tokenId] = owner;
    }

    function ownerOf(uint256 tokenId) external view returns (address) {
        return owners[tokenId];
    }
}

contract MockVoid is IERC20 {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) allowance[from][msg.sender] = allowed - amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

/// @notice An app that records on whose behalf it was called.
contract Recorder is ChainAppBase {
    address public lastCaller;
    uint256 public timesCalled;

    constructor(IVoidChainAppRuntime r, uint256 id) ChainAppBase(r, id) {}

    function ping() external onlyFromMyChain {
        lastCaller = caller();
        timesCalled++;
    }

    /// @dev Without the modifier, on purpose: it is what a badly written app
    ///      would do, and the test shows the consequence.
    function unguardedPing() external {
        lastCaller = caller();
        timesCalled++;
    }
}

/**
 * A chainapp sob ataque.
 *
 * What these tests try to break: the economy and the isolation. If an app can
 * be used without paying the toll, the deed owner never gets paid. If one chain
 * can reach another's app, the isolation is talk -- and it is the only thing
 * separating "1,111 chains" from "one multi-tenant app".
 */
contract ChainAppTest is Test {
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

    /// @dev The direct path also has to declare a budget: applications pull
    ///      tokens via `spendFrom`, and with no declared ceiling the runtime
    ///      refuses. The ceiling here is generous on purpose -- what these cases
    ///      test is the DEX's arithmetic, not the spending limit.



    VoidChainAppRuntime runtime;
    VoidChainTreasury treasury;
    FakeDeed deed;
    MockVoid voidToken;

    Recorder appOfChain1;
    Recorder appOfChain2;

    address governance = address(0x6009);
    address protocolTreasury = address(0x9001);
    address alice = address(0xA11CE); // dona da chain 1
    address bob = address(0xB0B); // owner of chain 2
    address user = address(0x5E12);

    uint256 constant CHAIN1 = 1;
    uint256 constant CHAIN2 = 2;
    uint256 constant FEE = 0.01 ether;
    uint256 constant NET = FEE - (FEE * 200) / 10_000; // 98% that stays with the owner

    function setUp() public {
        deed = new FakeDeed();
        voidToken = new MockVoid();
        treasury = new VoidChainTreasury(
            ITreasuryDeed(address(deed)),
            ITreasuryERC20(address(voidToken)),
            protocolTreasury,
            governance
        );
        oracle = new MockOracle();
        runtime = new VoidChainAppRuntime(
            IVoidChainDeed(address(deed)),
            IERC20(address(voidToken)),
            IVoidChainTreasury(address(treasury))
        );
        runtime.setDaoFactoryOnce(address(this));
        runtime.registerDao(CHAIN1, address(this));
        runtime.registerDao(CHAIN2, address(this));
        runtime.setOracle(IRuntimeOracle(address(oracle)));

        deed.setOwner(CHAIN1, alice);
        deed.setOwner(CHAIN2, bob);

        // The runtime settles revenue into the treasury via flush -- authorized.
        vm.prank(governance);
        treasury.setAuthorizedSettler(address(runtime), true);

        vm.prank(alice);
        runtime.activate(CHAIN1, FEE);
        vm.prank(bob);
        runtime.activate(CHAIN2, FEE);

        appOfChain1 = new Recorder(IVoidChainAppRuntime(address(runtime)), CHAIN1);
        appOfChain2 = new Recorder(IVoidChainAppRuntime(address(runtime)), CHAIN2);

        vm.prank(alice);
        runtime.registerApp(CHAIN1, address(appOfChain1));
        vm.prank(bob);
        runtime.registerApp(CHAIN2, address(appOfChain2));

        voidToken.mint(user, 1000 ether);
        vm.prank(user);
        voidToken.approve(address(runtime), type(uint256).max);
    }

    // -----------------------------------------------------------------------
    // A economia
    // -----------------------------------------------------------------------

    function test_UsingTheChainPaysItsOwner() public {
        vm.prank(user);
        runtime.execute(CHAIN1, address(appOfChain1), abi.encodeCall(Recorder.ping, ()), FEE);

        (,, uint256 pending, uint256 lifetime, uint256 calls) = runtime.statsOf(CHAIN1);
        assertEq(pending, NET, "the owner pending is the net (98%)");
        assertEq(lifetime, FEE, "lifetime e bruto");
        assertEq(calls, 1);
        assertEq(appOfChain1.timesCalled(), 1, "the app should have executed");
    }

    /// @notice The app knows who the user is, not the runtime.
    /// @dev    If this failed, every user of every chainapp would show up as a
    ///         single address, and any app with per-account balances would be
    ///         unusable.
    function test_AppSeesTheRealUser() public {
        vm.prank(user);
        runtime.execute(CHAIN1, address(appOfChain1), abi.encodeCall(Recorder.ping, ()), FEE);
        assertEq(appOfChain1.lastCaller(), user, "the app has to see the user, not the runtime");
    }

    /// @notice Calling the app outside the runtime does not work -- it is what
    ///         makes the toll mandatory rather than optional.
    function test_CallingTheAppDirectlyIsRejected() public {
        // The app refuses because its caller is not the runtime -- the barrier
        // that closes the confused-deputy attack closes this path too.
        vm.expectRevert(
            abi.encodeWithSelector(ChainAppBase.NotCalledByRuntime.selector, user)
        );
        vm.prank(user);
        appOfChain1.ping();

        (,, uint256 pending,,) = runtime.statsOf(CHAIN1);
        assertEq(pending, 0, "nobody should have used the chain");
    }

    /// @notice The revenue reaches the treasury with no bridge and no wait.
    /// @dev    It is the structural advantage of the model: on an L3 this same
    ///         revenue would take the rollup's dispute period to become available.
    function test_RevenueReachesTheTreasuryImmediately() public {
        vm.startPrank(user);
        for (uint256 i; i < 5; ++i) {
            runtime.execute(CHAIN1, address(appOfChain1), abi.encodeCall(Recorder.ping, ()), FEE);
        }
        vm.stopPrank();

        runtime.flush(CHAIN1);
        runtime.sweepProtocol();

        uint256 gross = FEE * 5;
        assertEq(treasury.claimable(alice), gross - (gross * 200) / 10_000, "98% da dona");
        assertEq(voidToken.balanceOf(protocolTreasury), (gross * 200) / 10_000, "2% do protocolo");
        (,,, uint256 lifetime,) = runtime.statsOf(CHAIN1);
        assertEq(lifetime, gross, "bruto registrado no runtime");
    }

    /// @notice Selling the deed transfers the chainapp income, as on the chains.
    function test_RevenueFollowsTheDeed() public {
        vm.prank(user);
        runtime.execute(CHAIN1, address(appOfChain1), abi.encodeCall(Recorder.ping, ()), FEE);
        runtime.flush(CHAIN1);
        uint256 aliceEarned = treasury.claimable(alice);

        deed.setOwner(CHAIN1, bob);

        vm.prank(user);
        runtime.execute(CHAIN1, address(appOfChain1), abi.encodeCall(Recorder.ping, ()), FEE);
        runtime.flush(CHAIN1);

        assertEq(treasury.claimable(alice), aliceEarned, "Alice does not earn after selling");
        assertGt(treasury.claimable(bob), 0, "Bob earns after buying");
    }

    // -----------------------------------------------------------------------
    // O isolamento
    // -----------------------------------------------------------------------

    /// @notice The attack that decides whether these are chains or one
    ///         multi-tenant app: reaching another chain's app by paying your own toll.
    function test_OneChainCannotReachAnothersApp() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                VoidChainAppRuntime.NotThisChainsApp.selector, CHAIN1, address(appOfChain2)
            )
        );
        vm.prank(user);
        runtime.execute(CHAIN1, address(appOfChain2), abi.encodeCall(Recorder.ping, ()), FEE);
    }

    /// @notice The other chain's app never even gets published.
    ///
    /// @dev    This is the first of the two barriers, and it grew stronger after
    ///         the review: before, publishing was accepted and the refusal came
    ///         only at execution; now the registry checks the `chainId` the app
    ///         app declara e recusa na porta.
    function test_AnothersAppCannotEvenBePublishedHere() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                VoidChainAppRuntime.AppBelongsElsewhere.selector,
                address(appOfChain1), CHAIN1, CHAIN2
            )
        );
        vm.prank(bob);
        runtime.registerApp(CHAIN2, address(appOfChain1));
    }

    /// @notice An app WITHOUT the protection is usable for free -- and the test
    ///         exists so that this is documented, not hidden.
    /// @dev    The isolation protects whoever uses it. An app that skips the
    ///         modifier is outside the chain's economy by its author's choice,
    ///         and the deed owner receives nothing for it.
    function test_UnguardedAppEscapesTheToll() public {
        vm.prank(user);
        appOfChain1.unguardedPing();

        assertEq(appOfChain1.timesCalled(), 1, "the app answered without going through the runtime");
        (,, uint256 pending,,) = runtime.statsOf(CHAIN1);
        assertEq(pending, 0, "and the chain received nothing for it");
    }

    /// @notice Outside an execution, the runtime points at no chain at all.
    function test_ExecutingChainIsClearedAfterEachCall() public {
        vm.prank(user);
        runtime.execute(CHAIN1, address(appOfChain1), abi.encodeCall(Recorder.ping, ()), FEE);

        assertEq(runtime.executingChain(), 0, "it stayed pointing at chain 1");
        assertEq(runtime.executingCaller(), address(0), "it stayed pointing at the user");
    }

    // -----------------------------------------------------------------------
    // Who commands
    // -----------------------------------------------------------------------

    function test_OnlyDeedHolderActivates() public {
        deed.setOwner(3, alice);
        vm.expectRevert(
            abi.encodeWithSelector(VoidChainAppRuntime.NotDeedHolder.selector, uint256(3), bob)
        );
        vm.prank(bob);
        runtime.activate(3, FEE);
    }

    function test_DeedHolderCanPauseAndResumeWithoutChangingFee() public {
        vm.prank(alice);
        runtime.setActive(CHAIN1, false);
        (bool active, uint256 fee,,,) = runtime.statsOf(CHAIN1);
        assertFalse(active, "the holder paused their chain");
        assertEq(fee, FEE, "pausing cannot change the fee");

        vm.prank(alice);
        runtime.setActive(CHAIN1, true);
        (active, fee,,,) = runtime.statsOf(CHAIN1);
        assertTrue(active, "the holder resumed their chain");
        assertEq(fee, FEE, "resuming cannot change the fee");
    }

    function test_PausedChainRejectsExecution() public {
        vm.prank(alice);
        runtime.setActive(CHAIN1, false);

        vm.expectRevert(abi.encodeWithSelector(VoidChainAppRuntime.NotActive.selector, CHAIN1));
        vm.prank(user);
        runtime.execute(CHAIN1, address(appOfChain1), abi.encodeCall(Recorder.ping, ()), FEE);
    }

    function test_NonHolderCannotPauseOrResume() public {
        vm.expectRevert(
            abi.encodeWithSelector(VoidChainAppRuntime.NotDeedHolder.selector, CHAIN1, bob)
        );
        vm.prank(bob);
        runtime.setActive(CHAIN1, false);
    }

    // -----------------------------------------------------------------------
    // Who may build
    // -----------------------------------------------------------------------

    /// @notice ANYONE publishes on a chain, without asking the owner's permission.
    ///
    /// @dev    An earlier version required being the owner, which made them a
    ///         gatekeeper able to choose who builds on the network. A network
    ///         like that attracts no developers, and without developers there is
    ///         no use -- and without use the chain is worth nothing even to its owner.
    function test_AnyoneCanBuildOnAChain() public {
        address builder = address(0xB1D);
        Recorder theirApp = new Recorder(IVoidChainAppRuntime(address(runtime)), CHAIN1);

        vm.prank(builder);
        runtime.registerApp(CHAIN1, address(theirApp));

        assertTrue(runtime.belongsTo(CHAIN1, address(theirApp)), "the app should be published");
        assertEq(runtime.publisherOf(CHAIN1, address(theirApp)), builder);

        // And it works: anyone uses it, and the chain owner earns from that.
        vm.prank(user);
        runtime.execute(CHAIN1, address(theirApp), abi.encodeCall(Recorder.ping, ()), FEE);
        assertEq(theirApp.timesCalled(), 1);

        (,, uint256 pending,,) = runtime.statsOf(CHAIN1);
        assertEq(pending, NET, "the owner earns the net from a third-party app");
    }

    /// @notice The chain owner does NOT delete somebody else's app.
    ///
    /// @dev    This is the limit that makes anyone accept building here. If buying
    ///         o NFT desse poder de destruir o trabalho de terceiros, todo mundo
    ///         who built would be hostage to whoever bought the chain afterwards.
    function test_ChainOwnerCannotDeleteSomeoneElsesApp() public {
        address builder = address(0xB1D);
        Recorder theirApp = new Recorder(IVoidChainAppRuntime(address(runtime)), CHAIN1);

        vm.prank(builder);
        runtime.registerApp(CHAIN1, address(theirApp));

        vm.expectRevert(
            abi.encodeWithSelector(
                VoidChainAppRuntime.NotThePublisher.selector, CHAIN1, address(theirApp), alice
            )
        );
        vm.prank(alice); // alice is the OWNER of chain 1
        runtime.unregisterApp(CHAIN1, address(theirApp));

        assertTrue(runtime.belongsTo(CHAIN1, address(theirApp)), "o app continua no ar");
    }

    /// @notice Whoever published may withdraw what is theirs.
    function test_PublisherCanWithdrawTheirOwnApp() public {
        address builder = address(0xB1D);
        Recorder theirApp = new Recorder(IVoidChainAppRuntime(address(runtime)), CHAIN1);

        vm.prank(builder);
        runtime.registerApp(CHAIN1, address(theirApp));
        vm.prank(builder);
        runtime.unregisterApp(CHAIN1, address(theirApp));

        assertFalse(runtime.belongsTo(CHAIN1, address(theirApp)));
    }

    /// @notice A chain can be closed, and then only its DAO publishes.
    /// @dev    Closing does not confiscate: what was already up keeps working.
    function test_ClosedChainOnlyAcceptsTheOwner() public {
        address builder = address(0xB1D);
        Recorder before = new Recorder(IVoidChainAppRuntime(address(runtime)), CHAIN1);
        vm.prank(builder);
        runtime.registerApp(CHAIN1, address(before));

        runtime.setPermissionlessDeploy(CHAIN1, false);

        Recorder rejected = new Recorder(IVoidChainAppRuntime(address(runtime)), CHAIN1);
        vm.expectRevert(
            abi.encodeWithSelector(VoidChainAppRuntime.DeploymentClosed.selector, CHAIN1, builder)
        );
        vm.prank(builder);
        runtime.registerApp(CHAIN1, address(rejected));

        assertTrue(runtime.belongsTo(CHAIN1, address(before)), "closing does not confiscate what already existed");

        Recorder approved = new Recorder(IVoidChainAppRuntime(address(runtime)), CHAIN1);
        runtime.registerApp(CHAIN1, address(approved));
        assertTrue(runtime.belongsTo(CHAIN1, address(approved)), "only the DAO may admit a new app");
    }

    /// @notice Only the chain DAO opens and closes publication.
    function test_OnlyChainDaoChangesDeploymentPolicy() public {
        vm.expectRevert(
            abi.encodeWithSelector(VoidChainAppRuntime.NotThisChainsDao.selector, CHAIN1, bob)
        );
        vm.prank(bob);
        runtime.setPermissionlessDeploy(CHAIN1, false);
    }

    function test_OnlyChainDaoChangesFee() public {
        vm.expectRevert(
            abi.encodeWithSelector(VoidChainAppRuntime.NotThisChainsDao.selector, CHAIN1, bob)
        );
        vm.prank(bob);
        runtime.setFee(CHAIN1, 1 ether);
    }

    /// @notice Selling the NFT cannot give a buyer unilateral fee control.
    function test_BuyerCannotBypassTheChainDao() public {
        deed.setOwner(CHAIN1, bob);

        vm.prank(bob);
        vm.expectRevert(
            abi.encodeWithSelector(VoidChainAppRuntime.NotThisChainsDao.selector, CHAIN1, bob)
        );
        runtime.setFee(CHAIN1, 0.5 ether);

        runtime.setFee(CHAIN1, 0.5 ether);
        assertEq(runtime.feeOf(CHAIN1), 0.5 ether);

        vm.expectRevert(
            abi.encodeWithSelector(VoidChainAppRuntime.NotThisChainsDao.selector, CHAIN1, alice)
        );
        vm.prank(alice);
        runtime.setFee(CHAIN1, 0.1 ether);
    }

    /// @notice THERE IS NO GLOBAL CEILING ANY MORE -- what protects the payer is
    ///         the `maxFee` they themselves sign on every call.
    ///
    /// @dev    The global ceiling of 100 VOID was removed by decision of the
    ///         protocol owner. The reason is sound: it was belt and braces for
    ///         people who do not look at what they sign, and in exchange it kept
    ///         a legitimate chain from charging a lot for something worth a lot.
    ///         This test now proves the protection that actually exists.
    function test_TollCeilingIsWhatThePayerSigned() public {
        // The DAO may set the fee, while each payer still signs their own cap.
        runtime.setFee(CHAIN1, 101 ether);

        // But the payer declares their limit, and above it the call refuses.
        voidToken.mint(bob, 1000 ether);
        vm.prank(bob);
        voidToken.approve(address(runtime), type(uint256).max);
        vm.prank(bob);
        vm.expectRevert();
        runtime.execute(CHAIN1, address(appOfChain1),
            abi.encodeCall(Recorder.ping, ()), 1 ether /* what bob accepts */);
    }

    // -----------------------------------------------------------------------
    // A DEX dentro da chainapp
    // -----------------------------------------------------------------------

    function test_SwapWorksInsideAChainApp() public {
        MockVoid tokenA = new MockVoid();
        MockVoid tokenB = new MockVoid();
        ChainAppSwap dex = new ChainAppSwap(
            IVoidChainAppRuntime(address(runtime)),
            CHAIN1,
            ISwapERC20(address(tokenA)),
            ISwapERC20(address(tokenB))
        );

        vm.prank(alice);
        runtime.registerApp(CHAIN1, address(dex));

        tokenA.mint(user, 1_000_000 ether);
        tokenB.mint(user, 1_000_000 ether);
        vm.startPrank(user);
        tokenA.approve(address(dex), type(uint256).max);
        // With `spendFrom`, the one pulling the user's token is the RUNTIME.
        tokenA.approve(address(runtime), type(uint256).max);
        tokenB.approve(address(dex), type(uint256).max);
        // With `spendFrom`, the one pulling the user's token is the RUNTIME.
        tokenB.approve(address(runtime), type(uint256).max);

        runtime.executeWithBudget(CHAIN1, 
            address(dex),
            abi.encodeCall(ChainAppSwap.addLiquidity, (100_000 ether, 100_000 ether, 0)),
            FEE
        , _authTwo(address(tokenA), address(tokenB)));

        uint256 kBefore = dex.k();
        runtime.executeWithBudget(CHAIN1,  address(dex), abi.encodeCall(ChainAppSwap.swap, (true, 1000 ether, 0)), FEE
        , _authTwo(address(tokenA), address(tokenB)));
        vm.stopPrank();

        assertGe(dex.k(), kBefore, "o invariante vale igual dentro da chainapp");
        (,, uint256 pending,,) = runtime.statsOf(CHAIN1);
        assertEq(pending, NET * 2, "both uses paid the toll (net)");
    }
}
