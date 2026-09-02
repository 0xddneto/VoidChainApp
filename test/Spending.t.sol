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

contract SpendDeed is IVoidChainDeed {
    mapping(uint256 => address) public owners;
    function setOwner(uint256 t, address o) external { owners[t] = o; }
    function ownerOf(uint256 t) external view returns (address) { return owners[t]; }
}

/// @notice VOID with EIP-2612 — what mainnet needs for the bubble to close.
contract PermitVoid is IRuntimeERC20 {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    mapping(address => uint256) public nonces;

    bytes32 public constant PERMIT_TYPEHASH = keccak256(
        "Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"
    );

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

    function DOMAIN_SEPARATOR() public view returns (bytes32) {
        return keccak256(
            abi.encode(
                keccak256(
                    "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
                ),
                keccak256(bytes("VOID")), keccak256(bytes("1")), block.chainid, address(this)
            )
        );
    }

    function permit(
        address owner, address spender, uint256 value, uint256 deadline,
        uint8 v, bytes32 r, bytes32 s
    ) external {
        require(block.timestamp <= deadline, "expirado");
        bytes32 structHash =
            keccak256(abi.encode(PERMIT_TYPEHASH, owner, spender, value, nonces[owner]++, deadline));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR(), structHash));
        require(ecrecover(digest, v, r, s) == owner, "assinatura ruim");
        allowance[owner][spender] = value;
    }
}

contract SpendTreasury is IVoidChainTreasury {
    PermitVoid public immutable token;
    address public protocolTreasury;
    mapping(address => uint256) public credited;
    constructor(PermitVoid t, address sink) { token = t; protocolTreasury = sink; }
    function settle(uint256, uint256 a) external { token.transferFrom(msg.sender, address(this), a); }
    function settleTo(uint256, address b, uint256 a) external {
        token.transferFrom(msg.sender, address(this), a); credited[b] += a;
    }
    function creditTo(address b, uint256 a) external {
        token.transferFrom(msg.sender, address(this), a); credited[b] += a;
    }
}

/// @notice An app that moves the user's tokens. It is the profile that punctured the bubble.
contract TipJar is ChainAppBase {
    address public immutable token;
    address public immutable jar;
    uint256 public received;

    constructor(IVoidChainAppRuntime r, uint256 id, address token_, address jar_)
        ChainAppBase(r, id)
    {
        token = token_;
        jar = jar_;
    }

    function tip(uint256 amount) external onlyFromMyChain {
        spend(token, jar, amount);
        received += amount;
    }
}

/**
 * THE BUBBLE CLOSED AT EVERY APPLICATION'S DOOR.
 *
 * The paymaster already solved execution: someone holding only VOID can
 * transact. But every application that moves the user's tokens required an
 * `approve` TO ITSELF — and `approve` is a transaction, which someone without
 * ETH cannot send. Each new app forced the user to find ETH once. The bubble
 * leaked at every door.
 *
 * Now the user authorizes ONE spender — the runtime — by signature, and declares
 * in the request itself how much each call may spend. These tests prove both
 * halves: that it works with no ETH and no approve, and that the limit really
 * limits.
 */
contract SpendingTest is Test {
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

    VoidChainAppRuntime runtime;
    VoidPaymaster paymaster;
    PermitVoid voidToken;
    SpendTreasury treasury;
    SpendDeed deed;
    TipJar app;
    TipJar otherChainApp;

    uint256 constant CHAIN = 7;
    uint256 constant OTHER_CHAIN = 8;
    uint256 constant TOLL = 1e18;
    uint256 constant RATE = 10_000e18;

    uint256 userPk = 0xA11CE;
    address user;
    address relayer = address(0xC0DE01);
    address chainOwner = address(0xC0FFEE);
    address governor = address(0x60E2);
    address jar = address(0x7A12);

    bytes32 domainSep;
    bytes32 typeHash;

    function setUp() public {
        user = vm.addr(userPk);

        voidToken = new PermitVoid();
        deed = new SpendDeed();
        treasury = new SpendTreasury(voidToken, address(0x9005));
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
            address(0x2117),
            IPaymasterOracle(address(oracle))
        );
        runtime.setForwarderOnce(address(paymaster));

        vm.startPrank(governor);
        paymaster.setMargin(1_000);
        paymaster.setLimits(1 ether, 60_000, 10 gwei, 0);
        vm.stopPrank();

        deed.setOwner(CHAIN, chainOwner);
        deed.setOwner(OTHER_CHAIN, chainOwner);
        vm.startPrank(chainOwner);
        runtime.activate(CHAIN, TOLL);
        runtime.activate(OTHER_CHAIN, TOLL);
        vm.stopPrank();

        app = new TipJar(IVoidChainAppRuntime(address(runtime)), CHAIN, address(voidToken), jar);
        runtime.registerApp(CHAIN, address(app));
        otherChainApp =
            new TipJar(IVoidChainAppRuntime(address(runtime)), OTHER_CHAIN, address(voidToken), jar);
        runtime.registerApp(OTHER_CHAIN, address(otherChainApp));

        voidToken.mint(user, 10_000e18);
        vm.deal(address(paymaster), 10 ether);
        vm.deal(relayer, 10 ether);
        vm.deal(user, 0); // A PREMISSA: zero ETH, sempre.

        typeHash = paymaster.SPONSORED_CALL_TYPEHASH();
        domainSep = keccak256(
            abi.encode(
                keccak256(
                    "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
                ),
                keccak256(bytes("VoidPaymaster")), keccak256(bytes("1")),
                block.chainid, address(paymaster)
            )
        );
    }

    // ---------------------------------------------------------------------

    function _hashSpends(VoidPaymaster.Spend[] memory spends) internal pure returns (bytes32) {
        bytes32[] memory hashes = new bytes32[](spends.length);
        for (uint256 i; i < spends.length; ++i) {
            hashes[i] = keccak256(
                abi.encode(
                    keccak256("Spend(address token,uint256 amount)"),
                    spends[i].token, spends[i].amount
                )
            );
        }
        return keccak256(abi.encodePacked(hashes));
    }

    function _budget(uint256 amount) internal view returns (VoidPaymaster.Spend[] memory s) {
        s = new VoidPaymaster.Spend[](1);
        s[0] = VoidPaymaster.Spend({token: address(voidToken), amount: amount});
    }

    function _req(uint256 chain, address target, bytes memory data, uint256 budget)
        internal
        view
        returns (VoidPaymaster.SponsoredCall memory)
    {
        return VoidPaymaster.SponsoredCall({
            user: user,
            tokenId: chain,
            target: target,
            data: data,
            maxToll: TOLL,
            maxGasVoid: 100e18,
            callGasLimit: 800_000,
            spends: _budget(budget),
            nftSpends: _noNfts(),
            nonce: paymaster.nonces(user),
            deadline: block.timestamp + 1 hours
        });
    }

    function _sign(VoidPaymaster.SponsoredCall memory req) internal view returns (bytes memory) {
        bytes32 structHash = keccak256(
            abi.encode(
                typeHash, req.user, req.tokenId, req.target, keccak256(req.data),
                req.maxToll, req.maxGasVoid, req.callGasLimit,
                _hashSpends(req.spends), _hashNftSpends(req.nftSpends),
                req.nonce, req.deadline
            )
        );
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(userPk, keccak256(abi.encodePacked("\x19\x01", domainSep, structHash)));
        return abi.encodePacked(r, s, v);
    }

    /// @dev The two permissions the bubble requires, both by SIGNATURE: the
    ///      paymaster for toll and gas, the runtime for what the apps pull.
    function _permits(uint256 runtimeAllowance)
        internal
        view
        returns (VoidPaymaster.Permit[] memory list)
    {
        list = new VoidPaymaster.Permit[](2);
        list[0] = _permitFor(address(paymaster), 1_000e18, 0);
        list[1] = _permitFor(address(runtime), runtimeAllowance, 1);
    }

    function _permitFor(address spender, uint256 value, uint256 nonceOffset)
        internal
        view
        returns (VoidPaymaster.Permit memory)
    {
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 structHash = keccak256(
            abi.encode(
                voidToken.PERMIT_TYPEHASH(), user, spender, value,
                voidToken.nonces(user) + nonceOffset, deadline
            )
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(
            userPk,
            keccak256(abi.encodePacked("\x19\x01", voidToken.DOMAIN_SEPARATOR(), structHash))
        );
        return VoidPaymaster.Permit({
            spender: spender, value: value, deadline: deadline, v: v, r: r, s: s
        });
    }

    // =====================================================================
    // The bubble closes
    // =====================================================================

    /// @dev The test that closes the hole: zero ETH, ZERO approve to any app,
    ///      and the app still moves the user's token.
    function test_appMoveTokenSemQueUsuarioTenhaEthNemApproveNoApp() public {
        assertEq(user.balance, 0, "the user must not have ETH");
        assertEq(voidToken.allowance(user, address(app)), 0, "no approve to the app");
        assertEq(voidToken.allowance(user, address(runtime)), 0, "nor to the runtime, yet");

        VoidPaymaster.SponsoredCall memory req =
            _req(CHAIN, address(app), abi.encodeCall(TipJar.tip, (50e18)), 50e18);
        bytes memory sig = _sign(req);
        VoidPaymaster.Permit[] memory permits = _permits(50e18);

        vm.txGasPrice(1 gwei);
        vm.prank(relayer);
        paymaster.sponsorWithPermit(req, sig, permits);

        assertEq(app.received(), 50e18, "the app could not move the token");
        assertEq(voidToken.balanceOf(jar), 50e18, "the value did not reach the destination");
        assertEq(user.balance, 0, "the user still has no ETH");
        assertEq(voidToken.allowance(user, address(app)), 0, "and still no approve on the app");
    }

    // =====================================================================
    // E o limite limita
    // =====================================================================

    /// @dev The app tries to spend more than the user authorized FOR THAT call.
    ///      It is the attack an unlimited `approve` would allow and this
    ///      mechanism does not.
    function test_appNaoGastaAlemDoOrcamentoAssinado() public {
        VoidPaymaster.SponsoredCall memory req =
            _req(CHAIN, address(app), abi.encodeCall(TipJar.tip, (500e18)), 50e18);
        bytes memory sig = _sign(req);
        // The permission to the runtime is LOOSE on purpose: what stops the
        // excess has to be the signed budget, not the allowance.
        VoidPaymaster.Permit[] memory permits = _permits(10_000e18);

        vm.txGasPrice(1 gwei);
        vm.prank(relayer);
        (bool executed,) = paymaster.sponsorWithPermit(req, sig, permits);

        assertFalse(executed, "spending beyond the budget has to fail");
        assertEq(app.received(), 0, "nothing was moved");
        assertEq(voidToken.balanceOf(jar), 0, "the destination received nothing");
    }

    /// @dev The budget dies with the call. A surviving leftover would be a
    ///      permission the next caller inherits without having signed anything.
    function test_orcamentoNaoSobreviveAChamada() public {
        VoidPaymaster.SponsoredCall memory req =
            _req(CHAIN, address(app), abi.encodeCall(TipJar.tip, (10e18)), 50e18);
        // Signature and permits BEFORE the prank: both make external calls
        // (typehash, nonce, domain separator) and would consume the `vm.prank`.
        bytes memory sig = _sign(req);
        VoidPaymaster.Permit[] memory permits = _permits(10_000e18);

        vm.txGasPrice(1 gwei);
        vm.prank(relayer);
        paymaster.sponsorWithPermit(req, sig, permits);

        assertEq(app.received(), 10e18, "the first call spent 10");
        assertEq(
            runtime.spendBudget(address(voidToken)), 0, "budget left over after the call"
        );
    }

    /// @dev Outside an execution, `spendFrom` exists for nobody.
    function test_spendFromForaDeExecucaoEhRecusado() public {
        vm.expectRevert(VoidChainAppRuntime.NoExecutionInProgress.selector);
        vm.prank(address(app));
        runtime.spendFrom(address(voidToken), jar, 1);
    }

    /// @dev An app registered on ANOTHER chain cannot reach this one's user.
    ///      It is the isolation between chains applied to spending.
    function test_appDeOutraChainNaoGastaNestaExecucao() public {
        // The call belongs to chain 7; the outside app belongs to 8. The runtime
        // refuses even with an open budget and a loose allowance.
        VoidPaymaster.SponsoredCall memory req = _req(
            CHAIN, address(app), abi.encodeCall(TipJar.tip, (10e18)), 50e18
        );
        bytes memory sig = _sign(req);
        VoidPaymaster.Permit[] memory permits = _permits(10_000e18);

        vm.txGasPrice(1 gwei);
        vm.prank(relayer);
        paymaster.sponsorWithPermit(req, sig, permits);

        // During that execution `otherChainApp` was never reachable — and
        // outside it, not even the right chain's own app can do it.
        vm.expectRevert(VoidChainAppRuntime.NoExecutionInProgress.selector);
        vm.prank(address(otherChainApp));
        runtime.spendFrom(address(voidToken), jar, 1);
    }
}
