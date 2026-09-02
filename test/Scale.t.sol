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
import {Counter} from "../contracts/apps/Counter.sol";

contract ScaleDeed is IVoidChainDeed {
    mapping(uint256 => address) public owners;

    function setOwner(uint256 tokenId, address owner) external {
        owners[tokenId] = owner;
    }

    function ownerOf(uint256 tokenId) external view returns (address) {
        return owners[tokenId];
    }
}

contract ScaleVoid is IRuntimeERC20 {
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

contract ScaleTreasury is IVoidChainTreasury {
    ScaleVoid public immutable token;
    address public protocolTreasury;
    mapping(address => uint256) public credited;

    constructor(ScaleVoid token_, address sink) {
        token = token_;
        protocolTreasury = sink;
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

/**
 * THE WHOLE COLLECTION: 1,111 chainapps, all inside the bubble.
 *
 * The testnet run stopped at 300 chains for lack of gas ETH — the network's
 * faucet is unreachable from here, and native ETH cannot be minted. This test
 * answers the question that was left, and it is the code question: does the
 * system hold the COMPLETE collection, or is there some limit that only appears
 * at real scale?
 *
 * What it proves, with all 1,111 actually switched on and used:
 *
 *   1. all 1,111 activate, publish an application and execute — no structural
 *      limit;
 *   2. EVERY call goes through the paymaster: the users never spend ETH;
 *   3. every toll stayed on the chain that charged it. The toll is distinct per
 *      chain, so a wei crossing from one to another would show up in the books;
 *   4. the 2% / 98% split adds up exactly across all 1,111;
 *   5. the paymaster's accounting balances: what the users paid in gas is
 *      exactly replacement + margin.
 *
 * What it does NOT prove, and why the testnet run is still necessary: that the
 * real network orders, sequences and confirms that volume. That is a property of
 * the network, not of the contract, and it can only be measured there.
 */
contract ScaleTest is Test {
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
    ScaleVoid voidToken;
    ScaleTreasury treasury;
    ScaleDeed deed;

    uint256 constant CHAINS = 1111;
    uint256 constant USERS = 8;
    uint256 constant RATE = 10_000e18;
    uint256 constant MARGIN_BPS = 1_000;

    address relayer = address(0xC0DE01);
    address governor = address(0x60E2);

    address[] owners;
    Counter[] apps;
    uint256[] userKeys;
    address[] users;

    /// @dev A distinct toll per chain: a leak between chains would show up.
    function tollOf(uint256 id) internal pure returns (uint256) {
        return 0.01e18 * id;
    }

    function setUp() public {
        voidToken = new ScaleVoid();
        deed = new ScaleDeed();
        treasury = new ScaleTreasury(voidToken, address(0x9005));
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
        paymaster.setMargin(MARGIN_BPS);
        paymaster.setLimits(1 ether, 60_000, 100 gwei, 0);
        vm.stopPrank();

        vm.deal(address(paymaster), 100 ether);
        vm.deal(relayer, 100 ether);

        typeHash = paymaster.SPONSORED_CALL_TYPEHASH();
        domainSep = keccak256(
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

        // Different owners, so the revenue has to find the right one 1,111 times.
        for (uint256 i = 0; i < 16; i++) owners.push(address(uint160(0xD000 + i)));

        for (uint256 i = 0; i < USERS; i++) {
            uint256 k = 0xB0B + i;
            userKeys.push(k);
            address u = vm.addr(k);
            users.push(u);
            voidToken.mint(u, 1_000_000e18);
            vm.prank(u);
            voidToken.approve(address(paymaster), type(uint256).max);
            // The premise: NO user has any ETH.
            vm.deal(u, 0);
        }
    }

    /// @dev Cached in setUp ON PURPOSE, instead of being read from the contract
    ///      on every signature. Reading the typehash is an external call, and an
    ///      external call evaluated as an argument CONSUMES the `vm.prank` from
    ///      the previous line — the transaction then comes from the test contract
    ///      instead of the relayer, and the ETH reimbursement fails. It has
    ///      broken tests twice; with the values in memory the mistake stops being
    ///      possible.
    bytes32 domainSep;
    bytes32 typeHash;

    function _sign(uint256 pk, VoidPaymaster.SponsoredCall memory req)
        internal
        view
        returns (bytes memory)
    {
        bytes32 domain = domainSep;
        bytes32 structHash = keccak256(
            abi.encode(
                typeHash,
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
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    function test_asMilCentoEOnzeChainappsNaBolha() public {
        // --- ligar e publicar -------------------------------------------------
        for (uint256 id = 1; id <= CHAINS; id++) {
            address owner = owners[id % owners.length];
            deed.setOwner(id, owner);
            vm.prank(owner);
            runtime.activate(id, tollOf(id));

            Counter c = new Counter(IVoidChainAppRuntime(address(runtime)), id);
            apps.push(c);
            runtime.registerApp(id, address(c));
        }
        assertEq(apps.length, CHAINS, "nem todas as chains publicaram aplicacao");

        // --- usar, TODAS patrocinadas ----------------------------------------
        uint256[] memory pmNonce = new uint256[](USERS);
        uint256 voidBefore;
        for (uint256 i = 0; i < USERS; i++) voidBefore += voidToken.balanceOf(users[i]);

        vm.txGasPrice(1 gwei);
        for (uint256 id = 1; id <= CHAINS; id++) {
            uint256 slot = id % USERS;
            VoidPaymaster.SponsoredCall memory req = VoidPaymaster.SponsoredCall({
                user: users[slot],
                tokenId: id,
                target: address(apps[id - 1]),
                data: abi.encodeCall(Counter.bump, ()),
                maxToll: tollOf(id),
                maxGasVoid: 1_000e18,
                callGasLimit: 2_000_000,
                spends: _noSpends(),
                nftSpends: _noNfts(),
                nonce: pmNonce[slot]++,
                deadline: block.timestamp + 1 days
            });
            bytes memory sig = _sign(userKeys[slot], req);
            vm.prank(relayer);
            paymaster.sponsor(req, sig);
        }

        // --- 1. todas executaram ---------------------------------------------
        uint256 executed;
        for (uint256 id = 1; id <= CHAINS; id++) {
            if (apps[id - 1].count() == 1) executed++;
        }
        assertEq(executed, CHAINS, "nem todas as chamadas chegaram ao app");

        // --- 2. no user spent any ETH ----------------------------------------
        for (uint256 i = 0; i < USERS; i++) {
            assertEq(users[i].balance, 0, "a bubble user must never have touched ETH");
        }

        // --- 3. every toll stayed on the chain that charged it ---------------
        uint256 tollSum;
        uint256 pendingSum;
        for (uint256 id = 1; id <= CHAINS; id++) {
            (, uint256 fee, uint256 pending, uint256 lifetime, uint256 calls) = runtime.statsOf(id);
            assertEq(fee, tollOf(id), "the chain toll was altered");
            assertEq(calls, 1, "chamadas fora do esperado");
            assertEq(lifetime, tollOf(id), "take does not match this chain toll");
            tollSum += lifetime;
            pendingSum += pending;
        }

        // --- 4. the 2% / 98% split adds up exactly ---------------------------
        uint256 accrued = runtime.protocolAccrued();
        assertEq(accrued, tollSum * 200 / 10_000, "the protocol 2% does not add up");
        assertEq(pendingSum + accrued, tollSum, "conservacao de taxa quebrou na escala");

        // --- 5. the paymaster accounting balances ---------------------------
        uint256 voidAfter;
        for (uint256 i = 0; i < USERS; i++) voidAfter += voidToken.balanceOf(users[i]);
        uint256 spent = voidBefore - voidAfter;
        uint256 gasPaid = spent - tollSum;

        assertEq(
            paymaster.reimbursableVoid() + paymaster.surplusVoid(),
            gasPaid,
            "what the users paid in gas does not match the paymaster books"
        );
        assertEq(
            paymaster.surplusVoid(),
            paymaster.reimbursableVoid() * MARGIN_BPS / 10_000,
            "the margin is not the declared fraction"
        );
    }

    /// @dev The revenue has to find the right owner 1,111 times, with different owners.
    function test_receitaChegaAoDonoDeCadaUmaDasMilCentoEOnze() public {
        for (uint256 id = 1; id <= CHAINS; id++) {
            address owner = owners[id % owners.length];
            deed.setOwner(id, owner);
            vm.prank(owner);
            runtime.activate(id, tollOf(id));
            Counter c = new Counter(IVoidChainAppRuntime(address(runtime)), id);
            apps.push(c);
            runtime.registerApp(id, address(c));
        }

        uint256[] memory pmNonce = new uint256[](USERS);
        vm.txGasPrice(1 gwei);
        for (uint256 id = 1; id <= CHAINS; id++) {
            uint256 slot = id % USERS;
            VoidPaymaster.SponsoredCall memory req = VoidPaymaster.SponsoredCall({
                user: users[slot],
                tokenId: id,
                target: address(apps[id - 1]),
                data: abi.encodeCall(Counter.bump, ()),
                maxToll: tollOf(id),
                maxGasVoid: 1_000e18,
                callGasLimit: 2_000_000,
                spends: _noSpends(),
                nftSpends: _noNfts(),
                nonce: pmNonce[slot]++,
                deadline: block.timestamp + 1 days
            });
            vm.prank(relayer);
            paymaster.sponsor(req, _sign(userKeys[slot], req));
        }

        for (uint256 id = 1; id <= CHAINS; id++) runtime.flush(id);

        // Each owner received 98% of the sum of their own chains — and nothing more.
        uint256 total;
        for (uint256 i = 0; i < owners.length; i++) {
            uint256 expected;
            for (uint256 id = 1; id <= CHAINS; id++) {
                if (owners[id % owners.length] == owners[i]) {
                    expected += tollOf(id) - (tollOf(id) * 200 / 10_000);
                }
            }
            assertEq(treasury.credited(owners[i]), expected, "owner received the wrong amount");
            total += treasury.credited(owners[i]);
        }

        runtime.sweepProtocol();
        assertEq(
            treasury.credited(treasury.protocolTreasury()) + total,
            _tollTotal(),
            "the settled sum does not close against the take"
        );
    }

    function _tollTotal() internal pure returns (uint256 t) {
        for (uint256 id = 1; id <= CHAINS; id++) t += tollOf(id);
    }
}
