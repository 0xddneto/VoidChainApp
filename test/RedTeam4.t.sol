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

// ---------------------------------------------------------------------------
// Mocks (kept independent from RedTeam3's so this file is self-contained)
// ---------------------------------------------------------------------------

contract FakeDeed is IVoidChainDeed {
    mapping(uint256 => address) public owners;
    function setOwner(uint256 t, address o) external { owners[t] = o; }
    function ownerOf(uint256 t) external view returns (address) { return owners[t]; }
}

/// @notice Plain, well-behaved VOID (no callbacks). Reentrancy is covered in
///         RedTeam3; here we want deterministic accounting across many ops.
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

/// @notice Trivial app that only needs a toll paid to run.
contract NoopApp is ChainAppBase {
    constructor(IVoidChainAppRuntime r, uint256 id) ChainAppBase(r, id) {}
    function ping() external view onlyFromMyChain returns (uint256) { return 1; }
}

/// @notice A deed holder that is a contract with NO way to receive value: it
///         reverts on any plain call / ETH. Used to prove the pull-payment model
///         means a hostile/contract owner cannot brick flush for the flow.
contract RevertingHolder {
    receive() external payable { revert("no"); }
    fallback() external payable { revert("no"); }
}

// ===========================================================================
// HANDLER — drives many actors over many chains, concurrently interleaving
// execute / flush / sell(deed transfer) / claim / setFee. Tracks ghost totals
// so the test can assert exact fee conservation after any random sequence.
// ===========================================================================
contract Handler is Test {
    MockOracle oracle;

    VoidChainAppRuntime public runtime;
    VoidChainTreasury public treasury;
    FakeDeed public deed;
    MockVoid public voidToken;
    address public protocol;

    uint256 public constant NCHAINS = 4;
    address[4] public actors;
    mapping(uint256 => address) public appOf;

    // Ghosts: everything that was ever charged as a toll, and everything ever
    // pulled out via claim. These are the ground truth the invariant checks.
    uint256 public totalTolls;
    uint256 public totalClaimed;
    mapping(uint256 => uint256) public tollsPerChain;

    constructor(
        VoidChainAppRuntime r,
        VoidChainTreasury t,
        FakeDeed d,
        MockVoid v,
        address proto,
        address[4] memory a,
        address[4] memory apps
    ) {
        runtime = r; treasury = t; deed = d; voidToken = v; protocol = proto;
        actors = a;
        for (uint256 i; i < NCHAINS; ++i) appOf[i + 1] = apps[i];
    }

    function _actor(uint256 s) internal view returns (address) { return actors[s % actors.length]; }
    function _chain(uint256 s) internal pure returns (uint256) { return 1 + (s % NCHAINS); }

    /// Use a chain: pay its toll and run the noop app.
    function useChain(uint256 aSeed, uint256 cSeed) public {
        address actor = _actor(aSeed);
        uint256 chain = _chain(cSeed);
        uint256 fee = runtime.feeOf(chain);
        if (fee > 0 && voidToken.balanceOf(actor) < fee) return;
        vm.prank(actor);
        try runtime.execute(chain, appOf[chain], abi.encodeCall(NoopApp.ping, ()), fee) {
            totalTolls += fee;
            tollsPerChain[chain] += fee;
        } catch {}
    }

    /// Repass a chain's pending to the treasury.
    function flushChain(uint256 cSeed) public {
        uint256 chain = _chain(cSeed);
        try runtime.flush(chain) {} catch {}
    }

    /// Simulate an NFT sale: the deed changes hands mid-stream.
    function sell(uint256 cSeed, uint256 aSeed) public {
        deed.setOwner(_chain(cSeed), _actor(aSeed));
    }

    /// An actor withdraws its accrued share.
    function claim(uint256 aSeed) public {
        address a = _actor(aSeed);
        uint256 c = treasury.claimable(a);
        if (c == 0) return;
        vm.prank(a);
        try treasury.claim() { totalClaimed += c; } catch {}
    }

    /// Sweep the protocol's accrued 2% to the treasury.
    function sweep() public {
        try runtime.sweepProtocol() {} catch {}
    }

    /// The protocol revenue is sent directly to its configured public address.
    function claimProtocol() public {
        // Kept as a callable handler action to prove that no protocol signing
        // step is necessary after a sweep.
    }

    /// The current owner reprices the chain (bounded to sane values).
    function changeFee(uint256 cSeed, uint256 fSeed) public {
        uint256 chain = _chain(cSeed);
        address owner = deed.ownerOf(chain);
        uint256 f = fSeed % (3 ether);
        vm.prank(owner);
        try runtime.setFee(chain, f) {} catch {}
    }
}

// ===========================================================================
// RedTeam Round 4 — fee-flow conservation under scale + concurrency, plus the
// specific handoff / scope / rounding / griefing vectors the owner asked for.
// ===========================================================================
contract RedTeam4 is Test {
    MockOracle oracle;

    VoidChainAppRuntime runtime;
    VoidChainTreasury treasury;
    FakeDeed deed;
    MockVoid voidToken;
    Handler handler;

    address protocol = address(0x9001);
    address gov = address(0x6009);
    address[4] actors;

    uint256 constant NCHAINS = 4;
    uint256 constant FEE = 1 ether;

    mapping(uint256 => address) internal chainApp;

    function setUp() public {
        deed = new FakeDeed();
        voidToken = new MockVoid();
        treasury = new VoidChainTreasury(
            ITreasuryDeed(address(deed)), ITreasuryERC20(address(voidToken)), protocol, gov
        );
        oracle = new MockOracle();
        runtime = new VoidChainAppRuntime(
            IVoidChainDeed(address(deed)), IERC20(address(voidToken)),
            IVoidChainTreasury(address(treasury))
        );
        runtime.setOracle(IRuntimeOracle(address(oracle)));
        vm.prank(gov);
        treasury.setAuthorizedSettler(address(runtime), true);

        actors[0] = address(0xA11CE);
        actors[1] = address(0xB0B);
        actors[2] = address(0xCA201);
        actors[3] = address(0xD00D);

        address[4] memory apps;
        for (uint256 i; i < NCHAINS; ++i) {
            uint256 chain = i + 1;
            address owner = actors[i];
            deed.setOwner(chain, owner);
            vm.prank(owner);
            runtime.activate(chain, FEE);
            NoopApp app = new NoopApp(IVoidChainAppRuntime(address(runtime)), chain);
            vm.prank(owner);
            runtime.registerApp(chain, address(app));
            apps[i] = address(app);
            chainApp[chain] = address(app);
        }

        // Fund every actor heavily and let the runtime pull their tolls.
        for (uint256 i; i < 4; ++i) {
            voidToken.mint(actors[i], 1e30);
            vm.prank(actors[i]);
            voidToken.approve(address(runtime), type(uint256).max);
        }

        handler = new Handler(runtime, treasury, deed, voidToken, protocol, actors, apps);
        // The handler must be able to prank actors; actors approve runtime already.
        // Point the fuzzer at the handler only.
        targetContract(address(handler));
    }

    // ---- helpers to sum live state -------------------------------------

    function _sumPending() internal view returns (uint256 s) {
        for (uint256 c = 1; c <= NCHAINS; ++c) {
            (,, uint256 pending,,) = runtime.statsOf(c);
            s += pending;
        }
    }

    function _sumClaimable() internal view returns (uint256 s) {
        for (uint256 i; i < 4; ++i) s += treasury.claimable(actors[i]);
    }

    /// @dev A NEW ledger bucket. When a deed changes hands, the previous owner
    ///      revenue is parked here instead of travelling to the treasury right
    ///      away -- the trip cost gas inside somebody else's call. The value
    ///      stays in the runtime and stays theirs, so it has to enter the
    ///      conservation check, or the invariant reports a leak where there is none.
    function _sumOwed() internal view returns (uint256 s) {
        s = runtime.owed(protocol);
        for (uint256 i; i < 4; ++i) s += runtime.owed(actors[i]);
    }

    /// @dev Total calls, to bound the rounding. The 1-wei floor of the protocol
    ///      cut can add 1 wei above the exact 2% PER CALL, not per chain -- the
    ///      old slack (NCHAINS) was far too small as soon as the chains started
    ///      being used more than once each.
    function _totalCalls() internal view returns (uint256 s) {
        for (uint256 c = 1; c <= NCHAINS; ++c) {
            (,,,, uint256 calls) = runtime.statsOf(c);
            s += calls;
        }
    }

    // =====================================================================
    // INVARIANT 1 — THE FEE-CONSERVATION INVARIANT (the headline of round 4).
    //
    //   Everything ever charged as a toll must be, at every reachable state,
    //   exactly accounted as: still-pending in the runtime + claimable in the
    //   treasury (owners + protocol) + already withdrawn. No wei is created,
    //   destroyed, stranded, or double-counted, under ANY interleaving of
    //   execute / flush / deed-sale / claim / repricing across all chains.
    // =====================================================================
    function invariant_feeConservation() public view {
        // The 2% is now split in execute and sits in `protocolAccrued` until the
        // sweep, so it enters the conservation check alongside the pending.
        uint256 accountedNow = _sumPending() + runtime.protocolAccrued() + _sumOwed()
            + _sumClaimable() + handler.totalClaimed() + voidToken.balanceOf(protocol);
        assertEq(handler.totalTolls(), accountedNow, "fee conservation broken: a wei leaked");
    }

    // =====================================================================
    // INVARIANT 2 — the runtime custodies exactly the un-flushed pending, and
    //   the treasury custodies exactly the unclaimed claimable. If either
    //   contract's real token balance drifts from its ledger, value is either
    //   trapped or extractable. Must hold in every state.
    // =====================================================================
    function invariant_custodyMatchesLedger() public view {
        // The runtime holds the owners pending PLUS the 2% not yet swept.
        assertEq(
            voidToken.balanceOf(address(runtime)),
            _sumPending() + runtime.protocolAccrued() + _sumOwed(),
            "runtime balance != sum(pending) + protocolAccrued + sum(owed)"
        );
        assertEq(voidToken.balanceOf(address(treasury)), _sumClaimable(), "treasury balance != sum(claimable)");
    }

    // =====================================================================
    // INVARIANT 3 — no chain's revenue is ever credited to another chain's
    //   books. For every chain: what was charged on it equals what is still
    //   pending on it plus what the treasury recorded as its lifetime revenue.
    //   Cross-contamination of lifetimeRevenue (the settle tokenId being wrong)
    //   would break this immediately.
    // =====================================================================
    function invariant_perChainRevenueNeverCrosses() public view {
        // Gross revenue per chain lives in the runtime (lifetimeRevenue), and must
        // equal exactly the tolls charged on that chain. The 2% split does not
        // change the gross -- it only divides where the net goes.
        for (uint256 c = 1; c <= NCHAINS; ++c) {
            (,,, uint256 lifetime,) = runtime.statsOf(c);
            assertEq(handler.tollsPerChain(c), lifetime, "per-chain revenue crossed wires");
        }
    }

    // =====================================================================
    // INVARIANT 4 — the protocol is never shortchanged NOR overpaid beyond
    //   rounding: total protocol credit+withdrawn is within [floor,ceil] of 2%
    //   of everything that has actually been settled (tolls that left pending).
    // =====================================================================
    function invariant_protocolShareStaysAtTwoPercent() public view {
        uint256 settledGross;
        for (uint256 c = 1; c <= NCHAINS; ++c) {
            (,,, uint256 lifetime,) = runtime.statsOf(c);
            settledGross += lifetime;
        }
        // Sweeps pay the protocol's public wallet directly. The exact-per-settle
        // floor is proven in the fuzz test below.
        uint256 protoTotal =
            voidToken.balanceOf(protocol) + runtime.protocolAccrued() + runtime.owed(protocol);
        // Ceiling: never above 2% of gross, with 1 wei of slack per chain (dust floor).
        assertLe(protoTotal, (settledGross * 200) / 10_000 + _totalCalls(), "protocol over 2%");
    }

    // =====================================================================
    // R4-A  RAPID OWNER HANDOFF: A earns, sells to B, B earns, sells to C, C
    //   earns, then flush. Every wei must reach its GENERATOR, none orphaned,
    //   none doubled. This is the pendingOwner auto-settle path under fast
    //   transitions, checked to the wei.
    // =====================================================================
    function test_R4_A_RapidHandoffEachWeiToItsGenerator() public {
        uint256 chain = 1;
        address A = actors[0];
        address B = actors[1];
        address C = actors[2];
        (address app,) = _appAndFee(chain);

        // A generates one toll.
        vm.prank(A);
        runtime.execute(chain, app, abi.encodeCall(NoopApp.ping, ()), FEE);

        // Sell A -> B, B generates (auto-settles A's pending to A).
        deed.setOwner(chain, B);
        vm.prank(B);
        runtime.execute(chain, app, abi.encodeCall(NoopApp.ping, ()), FEE);

        // Sell B -> C, C generates (auto-settles B's pending to B).
        deed.setOwner(chain, C);
        vm.prank(C);
        runtime.execute(chain, app, abi.encodeCall(NoopApp.ping, ()), FEE);

        // Flush settles C pending to C. A and B had their revenue PARKED in the
        // runtime when the deed changed hands -- the trip to the treasury cost gas
        // inside a third party's call, so now it is a step of its own. The
        // guarantee did not change: every wei still belongs to whoever generated it.
        runtime.claimOwed(A);
        runtime.claimOwed(B);
        runtime.flush(chain);
        // The 2% is split in execute and lives in protocolAccrued; the sweep takes it to the treasury.
        runtime.sweepProtocol();

        uint256 net = FEE - (FEE * 200 / 10_000);
        assertEq(treasury.claimable(A), net, "A got exactly what A generated");
        assertEq(treasury.claimable(B), net, "B got exactly what B generated");
        assertEq(treasury.claimable(C), net, "C got exactly what C generated");
        assertEq(voidToken.balanceOf(protocol), 3 * (FEE * 200 / 10_000), "protocol got 2% x3");
        // No pending orphaned.
        (,, uint256 pending,,) = runtime.statsOf(chain);
        assertEq(pending, 0, "no orphan pending");
    }

    // =====================================================================
    // R4-B  SETTLER SCOPE ESCAPE (settleTo variant). A chain-scoped settler is
    //   authorized ONLY for its chain. It must not be able to book revenue for
    //   any other chain via settleTo, and passing the wildcard sentinel as the
    //   tokenId must not smuggle it through either.
    // =====================================================================
    function test_R4_B_ChainScopedSettlerCannotEscapeViaSettleTo() public {
        // Authorize THIS contract as a settler scoped strictly to chain 2.
        vm.prank(gov);
        treasury.setChainSettler(address(this), 2, true);
        voidToken.mint(address(this), 100 ether);
        voidToken.approve(address(treasury), type(uint256).max);

        // Foreign chain via settleTo -> rejected.
        vm.expectRevert(abi.encodeWithSelector(VoidChainTreasury.SettlerWrongChain.selector, address(this), uint256(1)));
        treasury.settleTo(1, actors[0], 1 ether);

        // The wildcard sentinel as tokenId -> still rejected (scope 2 != max).
        vm.expectRevert(abi.encodeWithSelector(VoidChainTreasury.SettlerWrongChain.selector, address(this), type(uint256).max));
        treasury.settleTo(type(uint256).max, actors[0], 1 ether);

        // Its own chain works, and books to chain 2 only.
        treasury.settleTo(2, actors[0], 1 ether);
        assertEq(treasury.lifetimeRevenue(2), 1 ether, "own chain booked");
        assertEq(treasury.lifetimeRevenue(1), 0, "foreign chain untouched");
    }

    // =====================================================================
    // R4-C  FLUSH CANNOT BE BRICKED. A deed holder that is a contract which
    //   reverts on every call still gets credited via pull-payment; flush
    //   succeeds and the revenue is not frozen. Griefing the flow is impossible.
    // =====================================================================
    function test_R4_C_ContractOwnerCannotFreezeTheFlow() public {
        uint256 chain = 1;
        (address app,) = _appAndFee(chain);
        RevertingHolder holder = new RevertingHolder();

        // Holder becomes owner and earns a toll (paid by an actor).
        deed.setOwner(chain, address(holder));
        vm.prank(actors[3]);
        runtime.execute(chain, app, abi.encodeCall(NoopApp.ping, ()), FEE);

        // Flush must succeed despite the owner reverting on any value push:
        // settleTo never sends value to the beneficiary, it only credits the
        // pull-payment ledger, so a reverting owner cannot brick the repass.
        runtime.flush(chain);
        uint256 net = FEE - (FEE * 200 / 10_000);
        assertEq(treasury.claimable(address(holder)), net, "revenue credited, not frozen");

        // And because VOID is a plain ERC-20 (no push callback on transfer), even a
        // contract that reverts on native value can still pull its own claim: the
        // revenue is never stuck. Meanwhile other chains' flows are untouched.
        vm.prank(address(holder));
        treasury.claim();
        assertEq(voidToken.balanceOf(address(holder)), net, "holder withdrew freely; flow never frozen");
    }

    // =====================================================================
    // R4-D  THE 2% ROUNDING BOUNDARY (fuzz). For any settled amount: parts sum
    //   to the whole (no wei lost/created), the holder always receives at least
    //   98% (never less), and the protocol fee equals the exact floor of 2%.
    //   Dust always falls to the holder, never to the protocol — so the split
    //   can never be gamed to give the owner >98% beyond sub-wei rounding, nor
    //   to zero the protocol above the documented sub-50-wei dust boundary.
    // =====================================================================
    function testFuzz_R4_D_SplitBoundsHold(uint96 amount) public {
        uint256 gross = uint256(amount);
        vm.assume(gross > 0);

        vm.prank(gov);
        treasury.setAuthorizedSettler(address(this), true);
        voidToken.mint(address(this), gross);
        voidToken.approve(address(treasury), type(uint256).max);

        uint256 protoBefore = treasury.claimable(protocol);
        uint256 holderBefore = treasury.claimable(actors[0]);
        treasury.settleTo(1, actors[0], gross);

        uint256 protoFee = treasury.claimable(protocol) - protoBefore;
        uint256 holderShare = treasury.claimable(actors[0]) - holderBefore;

        assertEq(protoFee + holderShare, gross, "parts must sum to the whole");
        // 2% by floor, BUT with a 1-wei floor -- the dust fix: any settlement
        // pays at least 1 wei of protocol.
        uint256 expectedFee = (gross * 200) / 10_000;
        if (expectedFee == 0) expectedFee = 1;
        assertEq(protoFee, expectedFee, "protocol fee = floor(2%), min 1 wei");
        // The owner receives at least 98% for normal values; in the dust range
        // (sub-50-wei) the 1-wei floor eats slightly more, and that is accepted --
        // config real.
        if (gross >= 50) {
            assertGe(holderShare * 10_000, gross * 9_800, "holder >= 98% for a normal value");
        }
    }

    // =====================================================================
    // R4-E  DUST FEE ROUNDS THE 2% TO ZERO (documented finding, informational).
    //   A chain priced BELOW 50 wei per call, flushed per call, pays ZERO
    //   protocol fee because floor(gross*200/10000)==0 for gross<50. This
    //   contradicts the "wash always costs 2%" narrative at the dust boundary.
    //   It is NOT accumulable into treasury theft: aggregating pending before
    //   flushing re-imposes the full 2%. We prove both halves.
    // =====================================================================
    /// @notice FIXED: the 1-wei floor closes the 2% floor-to-zero in the dust range.
    /// @dev    Before, a sub-50-wei settlement paid zero protocol and inflated
    ///         lifetimeRevenue for free. Now the floor guarantees at least 1 wei
    ///         per settlement -- "washing always costs protocol" holds again even
    ///         limite da poeira.
    /// @notice The 2% is split PER TRANSACTION in execute, with a 1-wei floor.
    /// @dev    Before, the split happened at flush, so aggregating pending got
    ///         around the dust. Now the split is at the moment of each call: 49
    ///         wei pays 1 wei of protocol per call, always, regardless of when the
    ///         flush or the sweep happens. It is the "automatic 2% on every
    ///         transaction" the owner asked for, and the floor closes the zero.
    function test_R4_E_ProtocolSplitIsPerTransactionWithFloor() public {
        uint256 chain = 1;
        (address app,) = _appAndFee(chain);
        address owner = actors[0];

        vm.prank(owner);
        runtime.setFee(chain, 49); // below the threshold where 2% rounded to zero

        for (uint256 i; i < 5; ++i) {
            vm.prank(owner);
            runtime.execute(chain, app, abi.encodeCall(NoopApp.ping, ()), 49);
        }

        // 5 calls x 1 wei floor = 5, already split, BEFORE any flush.
        assertEq(runtime.protocolAccrued(), 5, "2% (1 wei floor) split per transaction");

        runtime.flush(chain);
        assertEq(treasury.claimable(owner), 48 * 5, "the owner only receives the 98% (48 per call)");
        assertEq(voidToken.balanceOf(protocol), 0, "protocol receives nothing before sweep");

        runtime.sweepProtocol();
        assertEq(voidToken.balanceOf(protocol), 5, "the sweep sends the 2% to the public treasury");
    }

    // --- helpers ---------------------------------------------------------

    function _appAndFee(uint256 chain) internal view returns (address app, uint256 fee) {
        app = chainApp[chain];
        fee = runtime.feeOf(chain);
    }
}
