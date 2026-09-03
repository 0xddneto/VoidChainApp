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
import {ChainAppBase, IVoidChainAppRuntime} from "../contracts/apps/ChainAppBase.sol";

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

/// @notice VOID with EIP-2612, which is what mainnet needs to have.
/// @dev    It verifies the signature for real: a mock that accepted any permit
///         would prove the test passes, not that the mechanism works.
contract MockVoidPermit is MockVoid {
    bytes32 public constant PERMIT_TYPEHASH = keccak256(
        "Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"
    );

    mapping(address => uint256) public nonces;

    error PermitExpired();
    error PermitBadSignature();

    function DOMAIN_SEPARATOR() public view returns (bytes32) {
        return keccak256(
            abi.encode(
                keccak256(
                    "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
                ),
                keccak256(bytes("VOID")),
                keccak256(bytes("1")),
                block.chainid,
                address(this)
            )
        );
    }

    function permit(
        address owner,
        address spender,
        uint256 value,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external {
        if (block.timestamp > deadline) revert PermitExpired();
        bytes32 structHash = keccak256(
            abi.encode(PERMIT_TYPEHASH, owner, spender, value, nonces[owner]++, deadline)
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR(), structHash));
        if (ecrecover(digest, v, r, s) != owner) revert PermitBadSignature();
        allowance[owner][spender] = value;
    }
}

/// @notice A minimal treasury: it only needs to accept the credit for the paymaster test.
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
        token.transferFrom(msg.sender, address(this), amount);
        credited[beneficiary] += amount;
    }
}

/// @notice An app that records who the runtime said the user was.
contract Recorder is ChainAppBase {
    address public lastCaller;
    uint256 public timesCalled;

    constructor(IVoidChainAppRuntime r, uint256 id) ChainAppBase(r, id) {}

    function ping() external onlyFromMyChain {
        lastCaller = caller();
        timesCalled++;
    }
}

/**
 * A bolha.
 *
 * What these tests have to prove: that someone with ZERO ETH can use a
 * chainapp; that the app sees that someone, and not the postman; that the gas
 * cost and the margin land in separate accounts; and that nobody but the
 * paymaster can act on behalf of others.
 */
contract PaymasterTest is Test {
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
    Recorder app;

    uint256 constant CHAIN = 7;
    uint256 constant TOLL = 1e18;

    uint256 userPk = 0xA11CE;
    address user;
    address relayer = address(0xC0DE01);
    address chainOwner = address(0xC0FFEE);
    address protocolSink = address(0x9005);
    address governor = address(0x60E2);
    address runway = address(0x2117);

    /// @dev 1 ETH = 10,000 VOID. Round numbers so the check can be done by hand.
    uint256 constant RATE = 10_000e18;

    function setUp() public {
        user = vm.addr(userPk);

        voidToken = new MockVoid();
        deed = new FakeDeed();
        treasury = new MockTreasury(voidToken, protocolSink);
        oracle = new MockOracle();
        runtime = new VoidChainAppRuntime(
            IVoidChainDeed(address(deed)),
            IRuntimeERC20(address(voidToken)),
            IVoidChainTreasury(address(treasury))
        );
        runtime.setDaoFactoryOnce(address(this));
        runtime.registerDao(CHAIN, address(this));
        runtime.setOracle(IRuntimeOracle(address(oracle)));

        paymaster = new VoidPaymaster(
            IPaymasterERC20(address(voidToken)),
            IPaymasterRuntime(address(runtime)),
            governor,
            runway,
            IPaymasterOracle(address(oracle))
        );
        runtime.setForwarderOnce(address(paymaster));

        vm.prank(governor);
        paymaster.setMargin(1_000); // 10% de margem
        vm.prank(governor);
        paymaster.setLimits(1 ether, 60_000, 10 gwei, 0);

        deed.setOwner(CHAIN, chainOwner);
        vm.prank(chainOwner);
        runtime.activate(CHAIN, TOLL);

        app = new Recorder(IVoidChainAppRuntime(address(runtime)), CHAIN);
        runtime.registerApp(CHAIN, address(app));

        // The user has VOID and NO ETH. It is the premise of the whole test.
        voidToken.mint(user, 1_000e18);
        vm.prank(user);
        voidToken.approve(address(paymaster), type(uint256).max);

        // The paymaster reserve and a relayer with ETH to front.
        vm.deal(address(paymaster), 10 ether);
        vm.deal(relayer, 10 ether);
    }

    // ---------------------------------------------------------------------
    // Utilidades de assinatura
    // ---------------------------------------------------------------------

    function _sign(VoidPaymaster.SponsoredCall memory req) internal view returns (bytes memory) {
        bytes32 domain = keccak256(
            abi.encode(
                keccak256(
                    "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
                ),
                keccak256(bytes("VoidPaymaster")),
                keccak256(bytes("1")),
                block.chainid,
                address(paymaster)
            )
        );
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
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domain, structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(userPk, digest);
        return abi.encodePacked(r, s, v);
    }

    function _call(address who) internal view returns (VoidPaymaster.SponsoredCall memory req) {
        req = VoidPaymaster.SponsoredCall({
            user: who,
            tokenId: CHAIN,
            target: address(app),
            data: abi.encodeCall(Recorder.ping, ()),
            maxToll: TOLL,
            maxGasVoid: 100e18,
            callGasLimit: 2_000_000,
            spends: _noSpends(),
            nftSpends: _noNfts(),
            nonce: paymaster.nonces(who),
            deadline: block.timestamp + 1 hours
        });
    }

    function _relay(VoidPaymaster.SponsoredCall memory req) internal {
        bytes memory sig = _sign(req);
        vm.txGasPrice(1 gwei);
        vm.prank(relayer);
        paymaster.sponsor(req, sig);
    }

    // ---------------------------------------------------------------------
    // A bolha funciona
    // ---------------------------------------------------------------------

    function test_usuarioSemEthTransaciona() public {
        assertEq(user.balance, 0, "the user must have no ETH at all");

        _relay(_call(user));

        assertEq(app.timesCalled(), 1, "the call did not reach the app");
        assertEq(user.balance, 0, "the user still has no ETH");
    }

    /// @dev The most important test in the file. If the app sees the paymaster, a
    ///      DEX swap would credit the postman instead of whoever paid.
    function test_appEnxergaOUsuarioNaoOPaymaster() public {
        _relay(_call(user));

        assertEq(app.lastCaller(), user, "the app should see the user");
        assertTrue(app.lastCaller() != address(paymaster), "o app viu o carteiro");
    }

    function test_pedagioEDivididoNormalmente() public {
        _relay(_call(user));

        // 2% of 1 VOID to the protocol, 98% to the owner. The sponsored path
        // must not change the chain's economy.
        assertEq(runtime.protocolAccrued(), TOLL * 200 / 10_000, "2% do protocolo");
        (,,, uint256 pending,,,) = runtime.apps(CHAIN);
        assertEq(pending, TOLL - (TOLL * 200 / 10_000), "the owner 98%");
    }

    function test_usuarioPagaPedagioMaisGasEmVoid() public {
        uint256 before = voidToken.balanceOf(user);
        _relay(_call(user));
        uint256 spent = before - voidToken.balanceOf(user);

        assertGt(spent, TOLL, "should pay toll + gas");
        // The gas charged is the toll plus the conversion; the excess over the
        // toll is exactly what entered the two paymaster accounts.
        assertEq(
            spent - TOLL,
            paymaster.reimbursableVoid() + paymaster.surplusVoid(),
            "what left the user has to match what entered the accounts"
        );
    }

    // ---------------------------------------------------------------------
    // The separation of the two accounts
    // ---------------------------------------------------------------------

    /// @dev The margin is 10%, so the surplus has to be 1/11 of the total charged
    ///      for gas (cost = 10 parts, margin = 1 part).
    function test_custoEMargemEntramSeparados() public {
        _relay(_call(user));

        uint256 cost = paymaster.reimbursableVoid();
        uint256 margin = paymaster.surplusVoid();

        assertGt(cost, 0, "gas cost should be positive");
        assertGt(margin, 0, "margin should be positive");
        assertEq(margin, cost * 1_000 / 10_000, "the margin has to be 10% of the cost");
    }

    function test_reservaEhReembolsadaAoRelayer() public {
        uint256 reserveBefore = address(paymaster).balance;
        uint256 relayerBefore = relayer.balance;

        _relay(_call(user));

        uint256 drained = reserveBefore - address(paymaster).balance;
        assertGt(drained, 0, "the reserve should have paid the gas");
        // The relayer really spent gas and was reimbursed; its balance does not
        // drop by more than what the reserve did not cover.
        assertGe(relayer.balance + drained, relayerBefore, "relayer saiu no prejuizo");
    }

    // ---------------------------------------------------------------------
    // Nobody acts on behalf of anybody
    // ---------------------------------------------------------------------

    function test_executeForSoAceitaOForwarder() public {
        vm.expectRevert(
            abi.encodeWithSelector(VoidChainAppRuntime.NotTheForwarder.selector, address(this))
        );
        runtime.executeFor(user, CHAIN, address(app), abi.encodeCall(Recorder.ping, ()), TOLL);
    }

    function test_forwarderNaoPodeSerTrocado() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                VoidChainAppRuntime.ForwarderAlreadySet.selector, address(paymaster)
            )
        );
        runtime.setForwarderOnce(address(0xBEEF));
    }

    function test_assinaturaDeOutroEhRecusada() public {
        VoidPaymaster.SponsoredCall memory req = _call(user);
        bytes memory sig = _sign(req);

        // Swaps the user after signing: the signature stops matching.
        req.user = address(0xBAD);
        vm.txGasPrice(1 gwei);
        vm.prank(relayer);
        vm.expectRevert(VoidPaymaster.BadSignature.selector);
        paymaster.sponsor(req, sig);
    }

    function test_naoDaParaReapresentarAMesmaAssinatura() public {
        VoidPaymaster.SponsoredCall memory req = _call(user);
        bytes memory sig = _sign(req);

        vm.txGasPrice(1 gwei);
        vm.prank(relayer);
        paymaster.sponsor(req, sig);

        vm.txGasPrice(1 gwei);
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(VoidPaymaster.BadNonce.selector, 0, 1));
        paymaster.sponsor(req, sig);
    }

    function test_prazoVencidoEhRecusado() public {
        VoidPaymaster.SponsoredCall memory req = _call(user);
        req.deadline = block.timestamp - 1;
        bytes memory sig = _sign(req);

        vm.txGasPrice(1 gwei);
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(VoidPaymaster.Expired.selector, req.deadline));
        paymaster.sponsor(req, sig);
    }

    // ---------------------------------------------------------------------
    // Os tetos protegem os dois lados
    // ---------------------------------------------------------------------

    function test_usuarioNaoPagaMaisGasDoQueAceitou() public {
        VoidPaymaster.SponsoredCall memory req = _call(user);
        req.maxGasVoid = 1; // one wei of VOID: any real gas blows past it
        bytes memory sig = _sign(req);

        vm.txGasPrice(1 gwei);
        vm.prank(relayer);
        vm.expectRevert();
        paymaster.sponsor(req, sig);
    }

    function test_relayerNaoDrenaAReservaComGasCaro() public {
        VoidPaymaster.SponsoredCall memory req = _call(user);
        bytes memory sig = _sign(req);

        vm.txGasPrice(100 gwei); // acima do teto de 10 gwei
        vm.prank(relayer);
        vm.expectRevert(
            abi.encodeWithSelector(
                VoidPaymaster.GasPriceAboveLimit.selector, uint256(100 gwei), uint256(10 gwei)
            )
        );
        paymaster.sponsor(req, sig);
    }

    function test_sobraDePedagioVoltaAoUsuario() public {
        // The user authorizes a ceiling well above the real toll.
        VoidPaymaster.SponsoredCall memory req = _call(user);
        req.maxToll = 5e18;
        req.maxGasVoid = 100e18;

        uint256 before = voidToken.balanceOf(user);
        bytes memory sig = _sign(req);
        vm.txGasPrice(1 gwei);
        vm.prank(relayer);
        paymaster.sponsor(req, sig);

        uint256 spent = before - voidToken.balanceOf(user);
        uint256 gasCharged = paymaster.reimbursableVoid() + paymaster.surplusVoid();
        assertEq(spent, TOLL + gasCharged, "only the real toll should have been charged");
    }

    // ---------------------------------------------------------------------
    // A queima
    // ---------------------------------------------------------------------

    function test_abaixoDoPisoNadaEhQueimado() public {
        _relay(_call(user));

        // Drops the reserve below the 1 ether floor.
        vm.deal(address(paymaster), 0.5 ether);

        vm.expectRevert(VoidPaymaster.NothingToBurn.selector);
        paymaster.burnSurplus();
    }

    function test_acimaDoPisoQueimaSoAMargem() public {
        _relay(_call(user));

        uint256 margin = paymaster.surplusVoid();
        uint256 cost = paymaster.reimbursableVoid();
        assertGt(margin, 0, "there has to be margin for the test to mean anything");

        paymaster.burnSurplus();

        assertEq(
            voidToken.balanceOf(paymaster.BURN_ADDRESS()), margin, "only the margin should burn"
        );
        assertEq(paymaster.surplusVoid(), 0, "a margem foi destinada");
        assertEq(paymaster.reimbursableVoid(), cost, "the cost must NOT be burnable");
    }

    /// @dev The mistake the architecture has to make impossible: burning the VOID
    ///      that replaces ETH leaves the reserve with no way to rebuild itself.
    function test_oCustoDeGasNuncaEhQueimavel() public {
        _relay(_call(user));
        paymaster.burnSurplus();

        uint256 cost = paymaster.reimbursableVoid();
        assertGt(cost, 0, "o custo continua reservado");
        assertEq(voidToken.balanceOf(address(paymaster)), cost, "o saldo restante e so o custo");
    }

    function test_reposicaoSaiMarcadaComoReposicao() public {
        _relay(_call(user));
        uint256 cost = paymaster.reimbursableVoid();

        vm.prank(governor);
        paymaster.withdrawReimbursable(governor, cost);

        assertEq(paymaster.reimbursableVoid(), 0, "a conta de reposicao zerou");
        assertEq(voidToken.balanceOf(governor), cost, "the VOID left to be sold");
    }

    function test_naoDaParaSacarMaisQueAConta() public {
        _relay(_call(user));
        uint256 cost = paymaster.reimbursableVoid();

        vm.prank(governor);
        vm.expectRevert(
            abi.encodeWithSelector(VoidPaymaster.AmountAboveBalance.selector, cost + 1, cost)
        );
        paymaster.withdrawReimbursable(governor, cost + 1);
    }

    // ---------------------------------------------------------------------
    // An empty reserve stops the system, and that has to be visible
    // ---------------------------------------------------------------------

    function test_reservaVaziaRecusaEmVezDeExecutarDeGraca() public {
        vm.deal(address(paymaster), 0);

        VoidPaymaster.SponsoredCall memory req = _call(user);
        bytes memory sig = _sign(req);

        vm.txGasPrice(1 gwei);
        vm.prank(relayer);
        vm.expectRevert();
        paymaster.sponsor(req, sig);
    }

    /// @notice An oracle returning zero stops the system, instead of operating blind.
    ///
    /// @dev    The old test checked "rate not configured". That condition stopped
    ///         existing: the rate is no longer typed, it is read. What can
    ///         dar errado agora e o ORACULO — e a resposta certa continua sendo
    ///         recusar, nunca cobrar zero de gas e pagar ETH de verdade.
    function test_oraculoMudoDerrubaOPatrocinioEmVezDeOperarCego() public {
        oracle.setVoidPerEth(0);

        VoidPaymaster.SponsoredCall memory req = _call(user);
        bytes memory sig = _sign(req);

        vm.txGasPrice(1 gwei);
        vm.prank(relayer);
        vm.expectRevert(VoidPaymaster.RateNotSet.selector);
        paymaster.sponsor(req, sig);
    }

    // ---------------------------------------------------------------------
    // Governance has limits
    // ---------------------------------------------------------------------

    function test_margemTemTeto() public {
        vm.prank(governor);
        vm.expectRevert(
            abi.encodeWithSelector(
                VoidPaymaster.MarginTooHigh.selector, uint256(5_000), uint256(3_000)
            )
        );
        paymaster.setMargin(5_000);
    }

    function test_custoFixoTemTeto() public {
        vm.prank(governor);
        vm.expectRevert(
            abi.encodeWithSelector(
                VoidPaymaster.OverheadTooHigh.selector, uint256(500_000), uint256(200_000)
            )
        );
        paymaster.setLimits(1 ether, 500_000, 10 gwei, 0);
    }

    /// @dev The reserve must not be a one-way door. With no exit, every ETH
    ///      deposited is stuck forever -- including during a migration.
    function test_governorRecuperaOEthDaReserva() public {
        uint256 reserve = address(paymaster).balance;
        assertGt(reserve, 0, "there has to be a reserve for the test to mean anything");

        vm.prank(governor);
        paymaster.withdrawEth(payable(governor), reserve);

        assertEq(address(paymaster).balance, 0, "the reserve should have left");
        assertEq(governor.balance, reserve, "the ETH should have arrived");
    }

    function test_soOGovernorRetiraEth() public {
        vm.expectRevert(
            abi.encodeWithSelector(VoidPaymaster.NotGovernor.selector, address(this))
        );
        paymaster.withdrawEth(payable(address(this)), 1);
    }

    function test_naoRetiraMaisEthDoQueTem() public {
        uint256 reserve = address(paymaster).balance;
        vm.prank(governor);
        vm.expectRevert(
            abi.encodeWithSelector(
                VoidPaymaster.AmountAboveBalance.selector, reserve + 1, reserve
            )
        );
        paymaster.withdrawEth(payable(governor), reserve + 1);
    }

    function test_soOGovernorCalibra() public {
        vm.expectRevert(
            abi.encodeWithSelector(VoidPaymaster.NotGovernor.selector, address(this))
        );
        paymaster.setMargin(500);
    }
}

/**
 * A bolha fechada.
 *
 * The test above still depended on an `approve` made by the user -- and
 * `approve` is a transaction, which costs ETH. While that is necessary, the
 * bubble has a hole at the front door: a user without ETH cannot even authorize.
 *
 * Here VOID implements EIP-2612 and the authorization becomes a signature. The
 * user sends no transaction at all, at any moment.
 */
contract PaymasterPermitTest is Test {
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

    /// @dev The paymaster accepts several permits because there are TWO spenders:
    ///      itself (toll and gas) and the runtime (what the applications pull).
    function _one(VoidPaymaster.Permit memory p)
        internal pure returns (VoidPaymaster.Permit[] memory list)
    {
        list = new VoidPaymaster.Permit[](1);
        list[0] = p;
    }

    VoidChainAppRuntime runtime;
    VoidPaymaster paymaster;
    MockVoidPermit voidToken;
    MockTreasury treasury;
    FakeDeed deed;
    Recorder app;

    uint256 constant CHAIN = 7;
    uint256 constant TOLL = 1e18;
    uint256 constant RATE = 10_000e18;

    uint256 userPk = 0xA11CE;
    address user;
    address relayer = address(0xC0DE01);
    address chainOwner = address(0xC0FFEE);
    address governor = address(0x60E2);

    function setUp() public {
        user = vm.addr(userPk);

        voidToken = new MockVoidPermit();
        deed = new FakeDeed();
        treasury = new MockTreasury(MockVoid(address(voidToken)), address(0x9005));
        oracle = new MockOracle();
        runtime = new VoidChainAppRuntime(
            IVoidChainDeed(address(deed)),
            IRuntimeERC20(address(voidToken)),
            IVoidChainTreasury(address(treasury))
        );
        runtime.setDaoFactoryOnce(address(this));
        runtime.registerDao(CHAIN, address(this));
        runtime.setOracle(IRuntimeOracle(address(oracle)));
        paymaster = new VoidPaymaster(
            IPaymasterERC20(address(voidToken)),
            IPaymasterRuntime(address(runtime)),
            governor,
            address(0x2117),
            IPaymasterOracle(address(oracle))
        );
        runtime.setForwarderOnce(address(paymaster));

        vm.startPrank(governor);
        paymaster.setMargin(1_000);
        paymaster.setLimits(1 ether, 60_000, 10 gwei, 0);
        vm.stopPrank();

        deed.setOwner(CHAIN, chainOwner);
        vm.prank(chainOwner);
        runtime.activate(CHAIN, TOLL);

        app = new Recorder(IVoidChainAppRuntime(address(runtime)), CHAIN);
        runtime.registerApp(CHAIN, address(app));

        voidToken.mint(user, 1_000e18);
        vm.deal(address(paymaster), 10 ether);
        vm.deal(relayer, 10 ether);
        // Note what does NOT happen here: no approve from the user.
    }

    function _permit(uint256 value) internal view returns (VoidPaymaster.Permit memory p) {
        bytes32 structHash = keccak256(
            abi.encode(
                voidToken.PERMIT_TYPEHASH(),
                user,
                address(paymaster),
                value,
                voidToken.nonces(user),
                block.timestamp + 1 hours
            )
        );
        bytes32 digest =
            keccak256(abi.encodePacked("\x19\x01", voidToken.DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(userPk, digest);
        p = VoidPaymaster.Permit({
            spender: address(paymaster),
            value: value,
            deadline: block.timestamp + 1 hours,
            v: v,
            r: r,
            s: s
        });
    }

    function _req() internal view returns (VoidPaymaster.SponsoredCall memory) {
        return VoidPaymaster.SponsoredCall({
            user: user,
            tokenId: CHAIN,
            target: address(app),
            data: abi.encodeCall(Recorder.ping, ()),
            maxToll: TOLL,
            maxGasVoid: 100e18,
            callGasLimit: 2_000_000,
            spends: _noSpends(),
            nftSpends: _noNfts(),
            nonce: paymaster.nonces(user),
            deadline: block.timestamp + 1 hours
        });
    }

    function _sign(VoidPaymaster.SponsoredCall memory req) internal view returns (bytes memory) {
        bytes32 domain = keccak256(
            abi.encode(
                keccak256(
                    "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
                ),
                keccak256(bytes("VoidPaymaster")),
                keccak256(bytes("1")),
                block.chainid,
                address(paymaster)
            )
        );
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
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domain, structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(userPk, digest);
        return abi.encodePacked(r, s, v);
    }

    /// @dev The test that closes the bubble: zero ETH, zero approve, zero transactions.
    function test_zeroEthZeroApproveAindaTransaciona() public {
        assertEq(user.balance, 0, "the user must not have ETH");
        assertEq(voidToken.allowance(user, address(paymaster)), 0, "there must be no prior approve");

        // Signature and permission are computed BEFORE the prank: `_sign` and
        // `_permit` make staticcalls, and one of them would consume the
        // `vm.prank` before the real call happened.
        VoidPaymaster.SponsoredCall memory req = _req();
        bytes memory sig = _sign(req);
        VoidPaymaster.Permit memory p = _permit(500e18);

        vm.txGasPrice(1 gwei);
        vm.prank(relayer);
        paymaster.sponsorWithPermit(req, sig, _one(p));

        assertEq(app.timesCalled(), 1, "the call did not arrive");
        assertEq(app.lastCaller(), user, "the app has to see the user");
        assertEq(user.balance, 0, "the user still has no ETH");
    }

    /// @dev Somebody presents the permit before the relayer, spending its nonce.
    ///      The permission stands, so the sponsorship must NOT fall with it.
    function test_permitAdiantadoNaoDerrubaOPatrocinio() public {
        VoidPaymaster.Permit memory p = _permit(500e18);

        // O front-run: qualquer um pode apresentar a assinatura.
        vm.prank(address(0xF00D));
        voidToken.permit(user, address(paymaster), p.value, p.deadline, p.v, p.r, p.s);
        assertEq(voidToken.nonces(user), 1, "the permit nonce was spent");

        VoidPaymaster.SponsoredCall memory req = _req();
        bytes memory sig = _sign(req);

        vm.txGasPrice(1 gwei);
        vm.prank(relayer);
        paymaster.sponsorWithPermit(req, sig, _one(p)); // the SAME permission, already used

        assertEq(app.timesCalled(), 1, "o front-run virou negacao de servico");
    }

    /// @dev And if the permission really does not exist, the error surfaces -- it
    ///      is not swallowed by the `catch`.
    function test_permitInvalidoRevertaComErroClaro() public {
        VoidPaymaster.Permit memory bogus =
            VoidPaymaster.Permit({spender: address(paymaster), value: 500e18, deadline: block.timestamp + 1 hours, v: 27, r: bytes32(uint256(1)), s: bytes32(uint256(2))});

        VoidPaymaster.SponsoredCall memory req = _req();
        bytes memory sig = _sign(req);

        vm.txGasPrice(1 gwei);
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(VoidPaymaster.PermitDidNotStick.selector, user));
        paymaster.sponsorWithPermit(req, sig, _one(bogus));
    }
}
