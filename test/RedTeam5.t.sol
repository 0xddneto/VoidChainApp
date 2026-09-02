// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {MockOracle} from "./MockOracle.sol";
import {
    VoidChainAppRuntime,
    IVoidChainDeed,
    IERC20 as IRuntimeERC20,
    IVoidChainTreasury,
    IVoidPriceOracle as IRuntimeOracle
} from "../contracts/parent/VoidChainAppRuntime.sol";
import {
    VoidPaymaster,
    IERC20 as IPaymasterERC20,
    IVoidChainAppRuntime as IPaymasterRuntime,
    IVoidPriceOracle as IPaymasterOracle
} from "../contracts/parent/VoidPaymaster.sol";

// =========================================================================
// Infraestrutura de teste
// =========================================================================

contract FakeDeed is IVoidChainDeed {
    mapping(uint256 => address) public owners;

    function setOwner(uint256 tokenId, address owner) external {
        owners[tokenId] = owner;
    }

    function ownerOf(uint256 tokenId) external view returns (address) {
        return owners[tokenId];
    }
}

contract MockVoid is IRuntimeERC20 {
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

/// @notice A minimal treasury: accepts the credit and pulls the token, like the real one.
contract MockTreasury is IVoidChainTreasury {
    MockVoid public immutable token;
    address public protocolTreasury;
    mapping(address => uint256) public credited;

    constructor(MockVoid token_, address protocolTreasury_) {
        token = token_;
        protocolTreasury = protocolTreasury_;
    }

    function settle(uint256, uint256 amount) external {
        token.transferFrom(msg.sender, address(this), amount);
    }

    function settleTo(uint256, address beneficiary, uint256 amount) external {
        token.transferFrom(msg.sender, address(this), amount);
        credited[beneficiary] += amount;
    }

    function creditTo(address beneficiary, uint256 amount) external {
        require(beneficiary != address(0), "zero beneficiary");
        token.transferFrom(msg.sender, address(this), amount);
        credited[beneficiary] += amount;
    }
}

/// @notice An ordinary app: it only records who the runtime said the user was.
contract Pinger {
    address public immutable runtime;
    uint256 public immutable chainId;
    uint256 public pings;
    address public lastCaller;

    constructor(address runtime_, uint256 chainId_) {
        runtime = runtime_;
        chainId = chainId_;
    }

    function ping() external {
        require(msg.sender == runtime, "runtime only");
        pings++;
        lastCaller = VoidChainAppRuntime(payable(runtime)).executingCaller();
    }
}

/// @notice An app that burns gas on command. It is the weapon of attack G1.
contract GasBurner {
    address public immutable runtime;
    uint256 public immutable chainId;
    bytes32 public sink;

    constructor(address runtime_, uint256 chainId_) {
        runtime = runtime_;
        chainId = chainId_;
    }

    function burn(uint256 rounds) external {
        bytes32 h = keccak256(abi.encodePacked(block.number));
        for (uint256 i; i < rounds; ++i) {
            h = keccak256(abi.encodePacked(h, i));
        }
        sink = h;
    }
}

/// @notice An app that dumps VOID into the paymaster during execution.
/// @dev    It serves to attack the toll leftover measurement by `balanceOf`.
contract Donor {
    address public immutable runtime;
    uint256 public immutable chainId;
    MockVoid public immutable token;
    address public immutable paymaster;

    constructor(address runtime_, uint256 chainId_, MockVoid token_, address paymaster_) {
        runtime = runtime_;
        chainId = chainId_;
        token = token_;
        paymaster = paymaster_;
    }

    function donate(uint256 amount) external {
        token.transfer(paymaster, amount);
    }
}

/// @notice An app that tries to reenter the paymaster mid-execution.
contract PaymasterReenterer {
    address public immutable runtime;
    uint256 public immutable chainId;
    address public immutable paymaster;
    bool public reentryFailed;
    bytes public lastError;

    constructor(address runtime_, uint256 chainId_, address paymaster_) {
        runtime = runtime_;
        chainId = chainId_;
        paymaster = paymaster_;
    }

    function tryBurn() external {
        (bool ok, bytes memory err) =
            paymaster.call(abi.encodeWithSignature("burnSurplus()"));
        reentryFailed = !ok;
        lastError = err;
    }

    function tryWithdraw() external {
        (bool ok,) = paymaster.call(
            abi.encodeWithSignature("withdrawReimbursable(address,uint256)", address(this), 1)
        );
        reentryFailed = !ok;
    }
}

/// @notice A contract relayer that reenters when it receives the ETH reimbursement.
contract EvilRelayer {
    VoidPaymaster public immutable paymaster;
    bool public reenteredOk;
    uint256 public received;

    constructor(VoidPaymaster p) {
        paymaster = p;
    }

    function relay(VoidPaymaster.SponsoredCall calldata req, bytes calldata sig) external {
        paymaster.sponsor(req, sig);
    }

    receive() external payable {
        received += msg.value;
        // No instante do reembolso, tenta voltar ao paymaster.
        (bool ok,) = address(paymaster).call(abi.encodeWithSignature("burnSurplus()"));
        reenteredOk = ok;
    }
}

/**
 * ROUND 5 -- the new surface: VoidPaymaster and executeFor.
 *
 * Every test prefixed `test_G` DEMONSTRATES A FINDING: it passes because the
 * attack works. Every test prefixed `test_N` is an attempt that did NOT work,
 * kept because knowing what holds is worth as much as knowing what
 * quebra.
 */
contract RedTeam5 is Test {
    function _noNfts() internal pure returns (VoidPaymaster.SpendNft[] memory) {
        return new VoidPaymaster.SpendNft[](0);
    }

    function _hashNftSpends(VoidPaymaster.SpendNft[] memory l) internal pure returns (bytes32) {
        bytes32[] memory h = new bytes32[](l.length);
        for (uint256 i; i < l.length; ++i) {
            h[i] = keccak256(abi.encode(
                keccak256("SpendNft(address collection,uint256 tokenId)"),
                l[i].collection, l[i].tokenId));
        }
        return keccak256(abi.encodePacked(h));
    }

    MockOracle oracle;

    /// @dev Mirrors the EIP-712 nested array hashing the paymaster performs.
    function _hashSpends(VoidPaymaster.Spend[] memory spends) internal pure returns (bytes32) {
        bytes32[] memory hashes = new bytes32[](spends.length);
        for (uint256 i; i < spends.length; ++i) {
            hashes[i] = keccak256(
                abi.encode(
                    keccak256("Spend(address token,uint256 amount)"),
                    spends[i].token,
                    spends[i].amount
                )
            );
        }
        return keccak256(abi.encodePacked(hashes));
    }

    function _noSpends() internal pure returns (VoidPaymaster.Spend[] memory) {
        return new VoidPaymaster.Spend[](0);
    }

    VoidChainAppRuntime runtime;
    VoidPaymaster paymaster;
    MockVoid voidToken;
    MockTreasury treasury;
    FakeDeed deed;

    Pinger pinger;

    /// @dev A paying chain, owned by the honest owner.
    uint256 constant CHAIN = 7;
    uint256 constant TOLL = 1e18;

    /// @dev A ZERO-toll chain, the attacker's. It is where the griefing lives.
    uint256 constant FREE_CHAIN = 99;

    uint256 constant RATE = 10_000e18; // 1 ETH = 10.000 VOID

    uint256 userPk = 0xA11CE;
    address user;
    uint256 attackerPk = 0xBADBAD;
    address attacker;

    address relayer = address(0xC0DE01);
    address chainOwner = address(0xC0FFEE);
    address governor = address(0x60E2);
    address runway = address(0x2117);

    function setUp() public {
        user = vm.addr(userPk);
        attacker = vm.addr(attackerPk);

        voidToken = new MockVoid();
        deed = new FakeDeed();
        treasury = new MockTreasury(voidToken, address(0x9005));
        oracle = new MockOracle();
        runtime = new VoidChainAppRuntime(
            IVoidChainDeed(address(deed)),
            IRuntimeERC20(address(voidToken)),
            IVoidChainTreasury(address(treasury))
        );
        runtime.setOracle(IRuntimeOracle(address(oracle)));
        paymaster = new VoidPaymaster(
            IPaymasterERC20(address(voidToken)),
            IPaymasterRuntime(address(runtime)),
            governor,
            runway,
            IPaymasterOracle(address(oracle))
        );
        runtime.setForwarderOnce(address(paymaster));

        vm.startPrank(governor);
        paymaster.setMargin(1_000);
        paymaster.setLimits(1 ether, 60_000, 10 gwei, 0);
        vm.stopPrank();

        // The honest chain, with a toll.
        deed.setOwner(CHAIN, chainOwner);
        vm.prank(chainOwner);
        runtime.activate(CHAIN, TOLL);
        pinger = new Pinger(address(runtime), CHAIN);
        runtime.registerApp(CHAIN, address(pinger));

        // The attacker's chain, zero toll.
        deed.setOwner(FREE_CHAIN, attacker);
        vm.prank(attacker);
        runtime.activate(FREE_CHAIN, 0);

        voidToken.mint(user, 1_000e18);
        vm.prank(user);
        voidToken.approve(address(paymaster), type(uint256).max);

        vm.deal(address(paymaster), 10 ether);
        vm.deal(relayer, 10 ether);
    }

    // ---------------------------------------------------------------------
    // Assinatura
    // ---------------------------------------------------------------------

    function _domain(address verifying) internal view returns (bytes32) {
        return keccak256(
            abi.encode(
                keccak256(
                    "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
                ),
                keccak256(bytes("VoidPaymaster")),
                keccak256(bytes("1")),
                block.chainid,
                verifying
            )
        );
    }

    function _digest(VoidPaymaster.SponsoredCall memory req, address verifying)
        internal
        view
        returns (bytes32)
    {
        bytes32 structHash = keccak256(
            abi.encode(
                paymaster.SPONSORED_CALL_TYPEHASH(),
                req.user,
                req.tokenId,
                req.target,
                keccak256(req.data),
                req.maxToll,
                req.maxGasVoid,
                req.callGasLimit,
                _hashSpends(req.spends),
                _hashNftSpends(req.nftSpends),
                req.nonce,
                req.deadline
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", _domain(verifying), structHash));
    }

    function _sign(uint256 pk, VoidPaymaster.SponsoredCall memory req)
        internal
        view
        returns (bytes memory)
    {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, _digest(req, address(paymaster)));
        return abi.encodePacked(r, s, v);
    }

    function _req(address who, uint256 tokenId, address target, bytes memory data)
        internal
        view
        returns (VoidPaymaster.SponsoredCall memory)
    {
        return VoidPaymaster.SponsoredCall({
            user: who,
            tokenId: tokenId,
            target: target,
            data: data,
            maxToll: 0,
            maxGasVoid: 100e18,
            callGasLimit: 2_000_000,
            spends: _noSpends(),
            nftSpends: _noNfts(),
            nonce: paymaster.nonces(who),
            deadline: block.timestamp + 1 hours
        });
    }

    function _pingReq(address who) internal view returns (VoidPaymaster.SponsoredCall memory r) {
        r = _req(who, CHAIN, address(pinger), abi.encodeCall(Pinger.ping, ()));
        r.maxToll = TOLL;
    }

    function _relay(VoidPaymaster.SponsoredCall memory req, uint256 pk, uint256 gasPrice)
        internal
    {
        bytes memory sig = _sign(pk, req);
        vm.txGasPrice(gasPrice);
        vm.prank(relayer);
        paymaster.sponsor(req, sig);
    }

    function _charged() internal view returns (uint256) {
        return paymaster.reimbursableVoid() + paymaster.surplusVoid();
    }

    // =====================================================================
    // G1 -- FINDING (HIGH): the user's ceiling is checked FAR TOO LATE.
    //
    // `maxGasVoid` is only compared AFTER the app executes. An attacker who has
    // NOTHING -- zero ETH, zero VOID, zero allowance -- publishes an app that
    // burns gas, signs a request with a low ceiling, and any relayer that picks
    // that request up burns millions of gas and gets ZERO back, because the
    // transaction reverts at the end.
    //
    // The relayer pays. The attacker pays nothing. Repeatable at will.
    // =====================================================================
    function test_G1_RelayerQueimaMilhoesDeGasEOAtacanteNaoPagaNada() public {
        GasBurner burner = new GasBurner(address(runtime), FREE_CHAIN);
        vm.prank(attacker);
        runtime.registerApp(FREE_CHAIN, address(burner));

        // The attacker has NOTHING. It is the premise of the attack.
        assertEq(voidToken.balanceOf(attacker), 0, "the attacker must have no VOID");
        assertEq(attacker.balance, 0, "the attacker must have no ETH");
        assertEq(voidToken.allowance(attacker, address(paymaster)), 0, "no allowance");

        VoidPaymaster.SponsoredCall memory req = _req(
            attacker, FREE_CHAIN, address(burner), abi.encodeCall(GasBurner.burn, (20_000))
        );
        // The ceiling the attacker "accepts" paying -- low on purpose.
        req.maxGasVoid = 1e15;
        bytes memory sig = _sign(attackerPk, req);

        uint256 reserveBefore = address(paymaster).balance;

        vm.txGasPrice(1 gwei);
        vm.prank(relayer);
        uint256 g0 = gasleft();
        (bool ok,) = address(paymaster).call(
            abi.encodeWithSelector(VoidPaymaster.sponsor.selector, req, sig)
        );
        uint256 burned = g0 - gasleft();

        // FIXED. The refusal now happens during VALIDATION, before anything
        // executes: the worst case is computed from the `callGasLimit` the
        // request itself declares, and the attacker's ceiling does not cover it.
        // The relayer finds that out spending a few thousand gas, not millions.
        assertFalse(ok, "the call is still refused");
        assertLt(burned, 200_000, "the refusal has to be cheap for the relayer");
        assertEq(address(paymaster).balance, reserveBefore, "nothing left the reserve");
        assertEq(_charged(), 0, "nothing was charged, because nothing executed");
    }

    /// @dev A variant with no hostile app at all: it is enough for the user to
    ///      REVOKE the permission after signing. The request stays valid for the
    ///      relayer to simulate and fails at the final charge, after full execution.
    function test_G1b_RetirarAllowanceDepoisDeAssinarMataOReembolso() public {
        VoidPaymaster.SponsoredCall memory req = _pingReq(user);
        bytes memory sig = _sign(userPk, req);

        // Between signing and inclusion, the user revokes.
        vm.prank(user);
        voidToken.approve(address(paymaster), 0);

        uint256 reserveBefore = address(paymaster).balance;
        vm.txGasPrice(1 gwei);
        vm.prank(relayer);
        uint256 g0 = gasleft();
        (bool ok,) = address(paymaster).call(
            abi.encodeWithSelector(VoidPaymaster.sponsor.selector, req, sig)
        );
        uint256 burned = g0 - gasleft();

        assertFalse(ok, "reverte");
        assertGt(burned, 20_000, "the relayer paid gas for nothing");
        assertEq(address(paymaster).balance, reserveBefore, "no reimbursement");
    }

    // =====================================================================
    // G2 -- FINDING (MEDIUM/HIGH): ETH reimbursement with a ZERO charge in VOID.
    //
    // `gasVoid = (ethSpent * voidPerEth) / 1e18` truncates. There is no guard
    // saying "if ETH left, VOID has to come in". With a `voidPerEth` low enough
    // pequeno — o resultado exato de digitar 1_000 em vez de 1_000e18, um erro
    // -- a decimal range `setRate` accepted without complaint -- the sum zeroes:
    //
    //   charge == 0 -> no VOID is pulled
    //   ethSpent  > 0 -> the ETH leaves the reserve anyway
    //
    // The result is a free-ETH tap, open to anyone, until the reserve dries up.
    // And since nothing is credited to `reimbursableVoid`, there is not even
    // VOID left to replace the ETH.
    // =====================================================================

    // =====================================================================
    // G3 -- FINDING (MEDIUM): MAX_MARGIN_BPS does not protect the user.
    //
    // The contract caps the margin at 30% and documents that as the guarantee
    // that "governance does not turn sponsorship into confiscation". Except the
    // final price is `gasVoid * (1 + margin)`, and `gasVoid` depends on
    // `voidPerEth`, which has NO ceiling, NO timelock and NO step limit.
    //
    // With a ZERO margin -- inside any ceiling -- governance multiplies the
    // user's bill by a thousand. The margin ceiling is decorative.
    // =====================================================================

    // =====================================================================
    // G4 -- FINDING (MEDIUM): the ETH reserve is drainable by anyone, with no
    //      per-block limit, and draining it takes the bubble down for EVERYONE.
    //
    // There is no `ethFloor` on the `sponsor` path -- the floor only exists for
    // the burn. A single actor relays their own calls until the reserve falls
    // below the cost of one transaction, and from then on no user without ETH
    // can transact on any chainapp. The cost of the attack is the margin.
    // =====================================================================
    function test_G4_UmAtorSozinhoSecaAReservaEDerrubaABolhaDeTodos() public {
        vm.deal(address(paymaster), 0.05 ether);

        // The per-block ceiling ON -- and calibrated ABOVE the worst case of a
        // single call, otherwise it does not limit the drain, it blocks
        // everything. At ~0.002 ETH worst case per call, 0.005 lets two through.
        vm.prank(governor);
        paymaster.setLimits(1 ether, 60_000, 10 gwei, 0.005 ether);

        voidToken.mint(attacker, 1_000e18);
        vm.prank(attacker);
        voidToken.approve(address(paymaster), type(uint256).max);

        GasBurner burner = new GasBurner(address(runtime), FREE_CHAIN);
        vm.prank(attacker);
        runtime.registerApp(FREE_CHAIN, address(burner));

        // Relays their own calls on their own zero-toll chain, at the same gas
        // price an honest user would use, until the reserve no longer covers even
        // one call. There is no per-block ceiling, and no floor on the `sponsor`
        // path -- only the balance runs out.
        uint256 feitas;
        for (uint256 i; i < 60; ++i) {
            VoidPaymaster.SponsoredCall memory req = _req(
                attacker, FREE_CHAIN, address(burner), abi.encodeCall(GasBurner.burn, (300))
            );
            bytes memory s = _sign(attackerPk, req);
            vm.txGasPrice(1 gwei);
            vm.prank(relayer);
            (bool relayed,) = address(paymaster).call(
                abi.encodeWithSelector(VoidPaymaster.sponsor.selector, req, s)
            );
            if (!relayed) break;
            feitas++;
        }

        // FIXED. The per-block ceiling (`maxEthPerBlock`) cuts the drain: the
        // attacker can no longer empty the reserve at once, and the honest user
        // keeps being served. The ceiling does not stop the reserve from being
        // gasta — enquanto a taxa estiver certa, gastar e o fluxo desenhado —
        // it stops it from being emptied in a single block.
        assertLe(feitas, 3, "the per-block ceiling cut the drain in a few calls");
        assertGt(address(paymaster).balance, 0.04 ether, "a reserva resistiu ao dreno");

        VoidPaymaster.SponsoredCall memory honest = _pingReq(user);
        bytes memory sig = _sign(userPk, honest);
        vm.txGasPrice(1 gwei);
        vm.roll(block.number + 1); // a new block, budget renewed
        vm.prank(relayer);
        (bool ok,) = address(paymaster).call(
            abi.encodeWithSelector(VoidPaymaster.sponsor.selector, honest, sig)
        );
        assertTrue(ok, "the honest user can still transact");
    }

    // =====================================================================
    // G5 -- FINDING (LOW/MEDIUM): the sponsored user pays, in VOID, the gas of
    //      the PREVIOUS OWNER's settlement.
    //
    // `_execute` settles the old owner's `pending` inside the paymaster's
    // measured window. Whoever happens to be passing pays that bill -- and the
    // one choosing the moment is the chain owner, transferring the deed at will.
    // =====================================================================
    function test_G5_UsuarioPatrocinadoPagaOGasDoAcertoDoDonoAnterior() public {
        // Two identical chains: A does not change owner, B does.
        uint256 CHAIN_A = 11;
        uint256 CHAIN_B = 12;
        address ownerA = address(0xA0);
        address ownerB1 = address(0xB1);
        address ownerB2 = address(0xB2);

        deed.setOwner(CHAIN_A, ownerA);
        vm.prank(ownerA);
        runtime.activate(CHAIN_A, TOLL);
        Pinger appA = new Pinger(address(runtime), CHAIN_A);
        runtime.registerApp(CHAIN_A, address(appA));

        deed.setOwner(CHAIN_B, ownerB1);
        vm.prank(ownerB1);
        runtime.activate(CHAIN_B, TOLL);
        Pinger appB = new Pinger(address(runtime), CHAIN_B);
        runtime.registerApp(CHAIN_B, address(appB));

        // First pass on each chain: generates `pending` for the owner of the day.
        VoidPaymaster.SponsoredCall memory r1 = _req(
            user, CHAIN_A, address(appA), abi.encodeCall(Pinger.ping, ())
        );
        r1.maxToll = TOLL;
        _relay(r1, userPk, 1 gwei);

        VoidPaymaster.SponsoredCall memory r2 = _req(
            user, CHAIN_B, address(appB), abi.encodeCall(Pinger.ping, ())
        );
        r2.maxToll = TOLL;
        _relay(r2, userPk, 1 gwei);

        // The owner of chain B sells the deed. Nothing else changes.
        deed.setOwner(CHAIN_B, ownerB2);

        // Second pass: chain A is the control, B carries the settlement.
        uint256 m0 = _charged();
        VoidPaymaster.SponsoredCall memory r3 = _req(
            user, CHAIN_A, address(appA), abi.encodeCall(Pinger.ping, ())
        );
        r3.maxToll = TOLL;
        _relay(r3, userPk, 1 gwei);
        uint256 controle = _charged() - m0;

        uint256 m1 = _charged();
        VoidPaymaster.SponsoredCall memory r4 = _req(
            user, CHAIN_B, address(appB), abi.encodeCall(Pinger.ping, ())
        );
        r4.maxToll = TOLL;
        _relay(r4, userPk, 1 gwei);
        uint256 comAcerto = _charged() - m1;

        // The settlement really happened, and went to the OLD owner.
        // FIXED. A change of owner no longer takes the revenue to the treasury
        // inside a third party's call: it stays parked in `owed`, and the
        // previous owner collects it when they like. Two writes instead of a trip.
        assertEq(treasury.credited(ownerB1), 0, "the settlement must not happen in a third party call");
        assertGt(runtime.owed(ownerB1), 0, "the value was parked for whoever generated it");

        // And the one who paid the gas for it was the user passing through.
        // The extra cost is now two writes, not a full settlement.
        // The previous owner's bill stopped landing on whoever was passing by.
        // From 33% down to the range of one storage write. The residual is
        // irreducible: parking it for whoever generated it costs ONE write, and
        // without it the guarantee that revenue follows the generator does not
        // sumiu foi a viagem ao cofre — approve + creditTo + transferFrom —
        // inside a third party's call.
        assertLt(
            comAcerto - controle,
            controle / 5,
            "a change of owner must no longer cost third parties a full settlement"
        );
        emit log_named_uint("VOID charged without settlement", controle);
        emit log_named_uint("VOID charged with previous owner settlement", comAcerto);
    }

    // =====================================================================
    // G6 -- FINDING (LOW/MEDIUM): the relayer is never reimbursed for calldata.
    //
    // The measured window starts INSIDE `sponsor`. The intrinsic cost and the
    // transaction's calldata fall outside it and are covered by a FIXED
    // `gasOverhead`. Since `req.data` is chosen by the attacker and ignored by
    // the app (leftover bytes are discarded during decoding), the calldata can
    // be inflated at will: the call SUCCEEDS, and the loss is all the relayer.
    // =====================================================================
    function test_G6_CalldataInfladoNaoEhReembolsadoEAChamadaAindaSucede() public {
        // FIXED -- AND THE FIRST FIX WAS WRONG TOO.
        //
        // The previous version charged `data.length * 16`, the EIP-2028 rule.
        // That is ETHEREUM's rule. Arbitrum does not charge that way: there the
        // cost of posting to L1 comes from compressing the data with brotli and
        // multiplying by ArbOS's calldata price. Estimating by raw size
        // overcharges repetitive data and undercharges dense data.
        //
        // Now the paymaster ASKS ArbOS, through the `ArbGasInfo` precompile. Here
        // it is mocked, because outside an Arbitrum chain the precompile does not
        // exist -- and there the L1 cost is genuinely zero, not an error.
        uint256 L1_FEE = 3_000_000_000_000_000; // 0.003 ETH of posting cost
        vm.mockCall(
            address(0x6C),
            abi.encodeWithSignature("getCurrentTxL1GasFees()"),
            abi.encode(L1_FEE)
        );

        uint256 reserve0 = address(paymaster).balance;
        _relay(_pingReq(user), userPk, 1 gwei);
        uint256 reembolso = reserve0 - address(paymaster).balance;

        assertEq(pinger.pings(), 1, "the call went through");
        assertGe(
            reembolso, L1_FEE,
            "the reimbursement has to cover the L1 cost ArbOS reported"
        );
        emit log_named_uint("L1 cost reported by ArbOS (wei)", L1_FEE);
        emit log_named_uint("reembolsado ao relayer (wei)         ", reembolso);

        vm.clearMockedCalls();
    }

    // =====================================================================
    // G7 -- FINDING (LOW): VOID reaching the paymaster outside a sponsorship
    //      is stuck forever.
    //
    // The two accounts (`reimbursableVoid` and `surplusVoid`) bound everything
    // that leaves. What comes in outside them is not withdrawable, not burnable
    // and has no rescue function. The accounting separation, which is the
    // design's virtue, becomes a one-way trap here.
    //
    // Note the asymmetry: the stuck ETH already gained an exit (`withdrawEth`,
    // and its comment recounts that two test paymasters were locked). The stuck
    // VOID still has none.
    // =====================================================================
    function test_G7_VoidEnviadoPorEngano_FicaPresoParaSempre() public {
        _relay(_pingReq(user), userPk, 1 gwei);

        uint256 perdido = 500e18;
        voidToken.mint(address(this), perdido);
        voidToken.transfer(address(paymaster), perdido);

        uint256 contabilizado = _charged();
        assertEq(
            voidToken.balanceOf(address(paymaster)),
            contabilizado + perdido,
            "the real balance is larger than the sum of the two accounts"
        );

        // Replacement withdrawal: bounded by the account, not by the balance.
        uint256 conta = paymaster.reimbursableVoid();
        vm.expectRevert(
            abi.encodeWithSelector(VoidPaymaster.AmountAboveBalance.selector, conta + 1, conta)
        );
        vm.prank(governor);
        paymaster.withdrawReimbursable(governor, conta + 1);

        // Burn: likewise, bounded by the other account.
        paymaster.burnSurplus();
        vm.prank(governor);
        paymaster.withdrawReimbursable(governor, conta);

        assertEq(paymaster.reimbursableVoid(), 0, "as duas contas zeradas");
        assertEq(paymaster.surplusVoid(), 0, "as duas contas zeradas");
        assertEq(
            voidToken.balanceOf(address(paymaster)), perdido, "e o VOID perdido continua la, preso"
        );
    }

    // =====================================================================
    // =====================================================================
    // WHAT DID NOT WORK -- attempts the design withstood.
    // =====================================================================
    // =====================================================================

    /// @dev N1 -- attacking the toll leftover measurement by `balanceOf`.
    ///      An app that dumps VOID into the paymaster mid-execution INFLATES the
    ///      leftover returned -- but the inflated VOID is the app's own, and the
    ///      books close exactly at zero. Conservation holds.
    function test_N1_DoacaoDuranteAExecucaoNaoQuebraAConservacao() public {
        Donor donor = new Donor(address(runtime), CHAIN, voidToken, address(paymaster));
        runtime.registerApp(CHAIN, address(donor));
        voidToken.mint(address(donor), 100e18);

        // Leaves the paymaster with both accounts full, so there is something to steal.
        _relay(_pingReq(user), userPk, 1 gwei);
        uint256 contasAntes = _charged();
        assertGt(contasAntes, 0, "precisa de saldo contabilizado no alvo");

        uint256 doacao = 5e17; // smaller than the toll, or `tollPaid` overflows
        VoidPaymaster.SponsoredCall memory req = _req(
            user, CHAIN, address(donor), abi.encodeCall(Donor.donate, (doacao))
        );
        req.maxToll = TOLL;

        uint256 saldoUsuarioAntes = voidToken.balanceOf(user);
        uint256 doadorAntes = voidToken.balanceOf(address(donor));
        _relay(req, userPk, 1 gwei);

        // The user got the donation back as "leftover" -- but it came out of the
        // app, not out of the paymaster's accounted balance.
        assertEq(doadorAntes - voidToken.balanceOf(address(donor)), doacao, "o app pagou a conta");
        // The toll measurement became the leftover ALLOWANCE, and not
        // `balanceOf`, so a donation mid-execution no longer touches the books.
        // The excess sits outside both accounts -- visible, and rescuable by
        // `sweepUnaccounted`.
        assertEq(
            voidToken.balanceOf(address(paymaster)) - _charged(),
            doacao,
            "the donation stays outside the accounts, without contaminating them"
        );
        assertGe(
            voidToken.balanceOf(address(paymaster)),
            paymaster.reimbursableVoid() + paymaster.surplusVoid(),
            "invariante de solvencia em VOID"
        );
        // The user did not get rich: they paid a smaller toll because the app covered part.
        assertLt(voidToken.balanceOf(user), saldoUsuarioAntes, "there was no extraction");
    }

    /// @dev N2 -- the app tries to reenter the paymaster during its own execution.
    function test_N2_AppNaoReentraNoPaymaster() public {
        PaymasterReenterer evil =
            new PaymasterReenterer(address(runtime), FREE_CHAIN, address(paymaster));
        vm.prank(attacker);
        runtime.registerApp(FREE_CHAIN, address(evil));

        // Fills the surplus so `burnSurplus` would have something to do.
        _relay(_pingReq(user), userPk, 1 gwei);
        uint256 surplusAntes = paymaster.surplusVoid();
        assertGt(surplusAntes, 0, "precisa de margem acumulada");

        voidToken.mint(attacker, 100e18);
        vm.prank(attacker);
        voidToken.approve(address(paymaster), type(uint256).max);

        VoidPaymaster.SponsoredCall memory req = _req(
            attacker, FREE_CHAIN, address(evil), abi.encodeCall(PaymasterReenterer.tryBurn, ())
        );
        _relay(req, attackerPk, 1 gwei);

        assertTrue(evil.reentryFailed(), "the reentry should have been blocked");
        assertEq(paymaster.surplusVoid() > 0, true, "the margin is still there, it was not burned");
        assertEq(
            voidToken.balanceOf(paymaster.BURN_ADDRESS()), 0, "nothing was burned by reentry"
        );
    }

    /// @dev N3 -- a contract relayer that reenters the paymaster on receiving the ETH.
    function test_N3_RelayerNaoReentraNoRecebimentoDoReembolso() public {
        EvilRelayer evil = new EvilRelayer(paymaster);
        vm.deal(address(evil), 1 ether);

        _relay(_pingReq(user), userPk, 1 gwei); // acumula margem
        uint256 surplusAntes = paymaster.surplusVoid();
        assertGt(surplusAntes, 0, "margin is needed for the target to exist");

        VoidPaymaster.SponsoredCall memory req = _pingReq(user);
        bytes memory sig = _sign(userPk, req);
        vm.txGasPrice(1 gwei);
        evil.relay(req, sig);

        assertGt(evil.received(), 0, "o relayer recebeu o reembolso");
        assertFalse(evil.reenteredOk(), "e a reentrada foi barrada");
        assertEq(voidToken.balanceOf(paymaster.BURN_ADDRESS()), 0, "nothing burned in between");
    }

    /// @dev N4 — maleabilidade de `s` no ECDSA.
    function test_N4_AssinaturaMaleavelEhRecusada() public {
        VoidPaymaster.SponsoredCall memory req = _pingReq(user);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(userPk, _digest(req, address(paymaster)));

        // s' = n - s, v flipped: the other valid signature of the same pair.
        uint256 n = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;
        bytes32 sFlip = bytes32(n - uint256(s));
        uint8 vFlip = v == 27 ? 28 : 27;
        bytes memory malleable = abi.encodePacked(r, sFlip, vFlip);

        vm.txGasPrice(1 gwei);
        vm.prank(relayer);
        vm.expectRevert();
        paymaster.sponsor(req, malleable);
    }

    /// @dev N5 — replay da mesma assinatura em outro paymaster.
    function test_N5_ReplayEmOutroPaymasterEhRecusado() public {
        VoidChainAppRuntime outroRuntime = new VoidChainAppRuntime(
            IVoidChainDeed(address(deed)),
            IRuntimeERC20(address(voidToken)),
            IVoidChainTreasury(address(treasury))
        );
        VoidPaymaster gemeo = new VoidPaymaster(
            IPaymasterERC20(address(voidToken)),
            IPaymasterRuntime(address(outroRuntime)),
            governor,
            runway,
            IPaymasterOracle(address(oracle))
        );
        outroRuntime.setForwarderOnce(address(gemeo));
        vm.startPrank(governor);
        gemeo.setMargin(1_000);
        gemeo.setLimits(1 ether, 60_000, 10 gwei, 0);
        vm.stopPrank();
        vm.deal(address(gemeo), 10 ether);

        VoidPaymaster.SponsoredCall memory req = _pingReq(user);
        bytes memory sig = _sign(userPk, req); // signed for the original paymaster

        vm.txGasPrice(1 gwei);
        vm.prank(relayer);
        vm.expectRevert(VoidPaymaster.BadSignature.selector);
        gemeo.sponsor(req, sig);
    }

    /// @dev N6 -- `executingCaller` does not leak after the sponsored execution.
    function test_N6_ExecutingCallerNaoVazaEntreChamadas() public {
        _relay(_pingReq(user), userPk, 1 gwei);

        assertEq(pinger.lastCaller(), user, "the app saw the real user");
        assertEq(runtime.executingCaller(), address(0), "e a variavel voltou a zero");
        assertEq(runtime.executingChain(), 0, "idem a chain");
    }

    /// @dev N7 -- conservation with both paths mixed (sponsored and direct):
    ///      the toll counted once only, the protocol 2% intact.
    function test_N7_CaminhoPatrocinadoEDiretoNaoDuplicamPedagio() public {
        voidToken.mint(attacker, 100e18);
        vm.prank(attacker);
        voidToken.approve(address(runtime), type(uint256).max);

        _relay(_pingReq(user), userPk, 1 gwei); // patrocinado

        vm.prank(attacker);
        runtime.execute(CHAIN, address(pinger), abi.encodeCall(Pinger.ping, ()), TOLL); // direto

        uint256 esperadoProtocolo = 2 * (TOLL * 200 / 10_000);
        (,,, uint256 pending,,,) = runtime.apps(CHAIN);

        assertEq(runtime.protocolAccrued(), esperadoProtocolo, "2% per call, no duplication");
        assertEq(pending, 2 * TOLL - esperadoProtocolo, "98% per call");
        assertEq(
            voidToken.balanceOf(address(runtime)),
            pending + runtime.protocolAccrued(),
            "the runtime holds exactly what it should"
        );
    }

    /// @dev N8 -- nobody but the paymaster speaks for another person, not even the owner
    ///      da chain, nem o publisher do app.
    function test_N8_NinguemAlemDoForwarderDeclaraUsuario() public {
        vm.prank(chainOwner);
        vm.expectRevert(
            abi.encodeWithSelector(VoidChainAppRuntime.NotTheForwarder.selector, chainOwner)
        );
        runtime.executeFor(user, CHAIN, address(pinger), abi.encodeCall(Pinger.ping, ()), TOLL);
    }

    /// @dev N9 -- the gas price ceiling really does limit the per-call drain.
    function test_N9_TetoDePrecoDeGasSeguraODrenoPorChamada() public {
        VoidPaymaster.SponsoredCall memory req = _pingReq(user);
        bytes memory sig = _sign(userPk, req);

        vm.txGasPrice(10 gwei + 1);
        vm.prank(relayer);
        vm.expectRevert(
            abi.encodeWithSelector(
                VoidPaymaster.GasPriceAboveLimit.selector, uint256(10 gwei + 1), uint256(10 gwei)
            )
        );
        paymaster.sponsor(req, sig);
    }

    // =====================================================================
    // G2 and G3 -- CLOSED BY CONSTRUCTION, not by patch.
    //
    // Both findings were about governance configuring `voidPerEth` wrongly:
    // pequeno demais (a reserva pagava o gas de todos de graca) ou grande demais
    // (the user's bill multiplied by a hundred, with the margin at zero, getting
    // o teto da margem).
    //
    // The rate stopped being configurable. It is read from the oracle. There is
    // no longer a function for governance to type a number into -- and that is
    // deixaram de ter superficie, em vez de terem sido consertados.
    // =====================================================================
    function test_G2_G3_ATaxaNaoEMaisConfiguravelPelaGovernanca() public {
        // There is no `setRate`. What governance still tunes is ONLY the margin,
        // and it still has a ceiling.
        vm.prank(governor);
        vm.expectRevert(
            abi.encodeWithSelector(
                VoidPaymaster.MarginTooHigh.selector, uint256(5_000), uint256(3_000)
            )
        );
        paymaster.setMargin(5_000);

        // And the rate comes from the oracle, not from paymaster storage.
        assertEq(paymaster.voidPerEth(), oracle.voidPerEth(), "the rate is a read, not a setting");
    }

    /// @dev The risk that REMAINS: governance points at a lying oracle. It cannot
    ///      be eliminated without making the oracle immutable -- and an immutable
    ///      oracle is a permanent point of failure when the feed dies. Recorded
    ///      as the price of the choice.
    function test_G8_GovernancaPodeApontarParaOraculoMentiroso() public {
        uint256 honesto = paymaster.voidPerEth();
        oracle.setVoidPerEth(honesto * 1000);
        assertEq(
            paymaster.voidPerEth(), honesto * 1000,
            "the paymaster follows the oracle, whichever one it is"
        );
    }
}
