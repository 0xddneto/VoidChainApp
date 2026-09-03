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
import {IVoidChainAppRuntime} from "../contracts/apps/ChainAppBase.sol";
import {ChainAppSwap, IERC20 as ISwapERC20} from "../contracts/apps/ChainAppSwap.sol";
import {ChainAppLaunchpad, IERC20 as ILaunchERC20} from "../contracts/apps/ChainAppLaunchpad.sol";
import {
    ChainAppMarket, IERC20 as IMarketERC20, IERC721
} from "../contracts/apps/ChainAppMarket.sol";

contract LoadDeed is IVoidChainDeed {
    mapping(uint256 => address) public owners;
    function setOwner(uint256 t, address o) external { owners[t] = o; }
    function ownerOf(uint256 t) external view returns (address) { return owners[t]; }
}

contract LoadToken is IRuntimeERC20 {
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

contract LoadTreasury is IVoidChainTreasury {
    LoadToken public immutable token;
    address public protocolTreasury;
    mapping(address => uint256) public credited;
    constructor(LoadToken t, address sink) { token = t; protocolTreasury = sink; }
    function settle(uint256, uint256 a) external { token.transferFrom(msg.sender, address(this), a); }
    function settleTo(uint256, address b, uint256 a) external {
        token.transferFrom(msg.sender, address(this), a); credited[b] += a;
    }
    function creditTo(address b, uint256 a) external {
        token.transferFrom(msg.sender, address(this), a); credited[b] += a;
    }
}

/// @notice A minimal ERC-721, only what the market needs.
contract LoadNft is IERC721 {
    mapping(uint256 => address) internal _owner;
    mapping(address => mapping(address => bool)) public isApprovedForAll;

    function mint(address to, uint256 id) external { _owner[id] = to; }
    function setApprovalForAll(address op, bool ok) external { isApprovedForAll[msg.sender][op] = ok; }
    function ownerOf(uint256 id) external view returns (address) { return _owner[id]; }

    function transferFrom(address from, address to, uint256 id) external {
        require(_owner[id] == from, "not the owner");
        require(msg.sender == from || isApprovedForAll[from][msg.sender], "no permission");
        _owner[id] = to;
    }
}

/**
 * LOAD TEST: 100 spaces, three application types and 1,000 provisioned users.
 *
 * The question this test answers is not "does it work?" -- the others already
 * answer that. It is "what does it cost, and what breaks first as volume rises".
 *
 * Three deliberately different usage profiles, because each stresses a
 * parte distinta do sistema:
 *
 *   DEX        pool arithmetic and slippage
 *   LAUNCHPAD  state writes per buyer
 *   MARKET     an external call into a third-party contract inside the toll
 *
 * EVERY transaction goes through the paymaster. No user holds a wei of ETH,
 * start to finish -- it is the premise the test checks at the end.
 *
 * This remains intentionally bounded: Forge executes the whole test as one
 * EVM transaction, whereas production calls are independent transactions. The
 * chosen volume is 4,800 signed sponsored calls (100 * 12 * 4), enough to
 * exercise thousands of operations without turning a CI test into a fictional
 * multi-billion-gas block.
 */
contract MegaLoadTest is Test {
    function _noNfts() internal pure returns (VoidPaymaster.SpendNft[] memory) {
        return new VoidPaymaster.SpendNft[](0);
    }

    function _authThree() internal view returns (VoidChainAppRuntime.SpendAuth memory auth) {
        address[] memory t = new address[](3);
        t[0] = address(voidToken); t[1] = address(assetA); t[2] = address(assetB);
        uint256[] memory l = new uint256[](3);
        l[0] = type(uint256).max; l[1] = type(uint256).max; l[2] = type(uint256).max;
        auth = VoidChainAppRuntime.SpendAuth({
            tokens: t, limits: l,
            collections: new address[](0), nftIds: new uint256[](0)
        });
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

    /// @dev Must match the second nested-array hash in VoidPaymaster exactly.
    ///      Omitting an empty array still changes the EIP-712 struct hash.
    function _hashNftSpends(VoidPaymaster.SpendNft[] memory list)
        internal
        pure
        returns (bytes32)
    {
        bytes32[] memory hashes = new bytes32[](list.length);
        for (uint256 i; i < list.length; ++i) {
            hashes[i] = keccak256(
                abi.encode(
                    keccak256("SpendNft(address collection,uint256 tokenId)"),
                    list[i].collection,
                    list[i].tokenId
                )
            );
        }
        return keccak256(abi.encodePacked(hashes));
    }

    function _noSpends() internal pure returns (VoidPaymaster.Spend[] memory) {
        return new VoidPaymaster.Spend[](0);
    }

    /// @dev ONE token per call, and only what that call moves.
    ///
    ///      Declaring extra tokens is expensive: each one is a cold storage
    ///      write on opening and another on cleanup. Declaring three when the
    ///      call uses one made the transaction ~180k gas more expensive -- more
    ///      than the operation itself. The minimal budget is also the narrowest
    ///      permission, so the economic incentive and the security one point the
    ///      same way.
    function _oneSpend(address token, uint256 amount)
        internal pure returns (VoidPaymaster.Spend[] memory s)
    {
        s = new VoidPaymaster.Spend[](1);
        s[0] = VoidPaymaster.Spend({token: token, amount: amount});
    }



    VoidChainAppRuntime runtime;
    VoidPaymaster paymaster;
    LoadToken voidToken;
    LoadToken assetA;
    LoadToken assetB;
    LoadNft nft;
    LoadTreasury treasury;
    LoadDeed deed;

    uint256 constant CHAINS = 100;
    uint256 constant USERS = 1_000;
    /// @notice Four sponsored calls per round: swap, sale buy, market list and market buy.
    uint256 constant ROUNDS = 12;

    uint256 constant RATE = 10_000e18;
    uint256 constant MARGIN_BPS = 1_000;
    /// @dev A distinct toll per chain: a leak between chains would show up.
    function tollOf(uint256 id) internal pure returns (uint256) { return 0.01e18 * id; }

    address relayer = address(0xC0DE01);
    address governor = address(0x60E2);
    address marketFees = address(0xFEE5);

    ChainAppSwap[] swaps;
    ChainAppLaunchpad[] pads;
    ChainAppMarket[] markets;
    address[] owners;
    uint256[] userKeys;
    address[] users;
    uint256[] pmNonce;

    bytes32 domainSep;
    bytes32 typeHash;

    // Measurements
    uint256 public txCount;
    uint256 public gasSwap;
    uint256 public gasPad;
    uint256 public gasMarket;
    uint256 public nSwap;
    uint256 public nPad;
    uint256 public nMarket;
    uint256 internal nftId = 1;

    function setUp() public {
        voidToken = new LoadToken();
        assetA = new LoadToken();
        assetB = new LoadToken();
        nft = new LoadNft();
        deed = new LoadDeed();
        treasury = new LoadTreasury(voidToken, address(0x9005));
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
        // No per-block ceiling: the test measures cost, not throughput policy.
        paymaster.setLimits(1 ether, 60_000, 100 gwei, 0);
        vm.stopPrank();

        vm.deal(address(paymaster), 10_000 ether);
        vm.deal(relayer, 10_000 ether);

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

        for (uint256 i = 0; i < 32; i++) owners.push(address(uint160(0xD000 + i)));

        _buildChains();
        _buildUsers();
    }

    function _buildChains() internal {
        for (uint256 id = 1; id <= CHAINS; id++) {
            address owner = owners[id % owners.length];
            deed.setOwner(id, owner);
            vm.prank(owner);
            runtime.activate(id, tollOf(id));

            ChainAppSwap s = new ChainAppSwap(
                IVoidChainAppRuntime(address(runtime)), id,
                ISwapERC20(address(assetA)), ISwapERC20(address(assetB))
            );
            ChainAppLaunchpad p = new ChainAppLaunchpad(
                IVoidChainAppRuntime(address(runtime)), id, ILaunchERC20(address(voidToken))
            );
            ChainAppMarket m = new ChainAppMarket(
                IVoidChainAppRuntime(address(runtime)), id,
                IMarketERC20(address(voidToken)), 250, marketFees
            );
            swaps.push(s); pads.push(p); markets.push(m);
            runtime.registerApp(id, address(s));
            runtime.registerApp(id, address(p));
            runtime.registerApp(id, address(m));

            // The DEX initial liquidity, put up by the chain owner.
            assetA.mint(owner, 1e24);
            assetB.mint(owner, 1e24);
            vm.startPrank(owner);
            // With `spendFrom`, the puller is the RUNTIME -- one spender, for everything.
            assetA.approve(address(runtime), type(uint256).max);
            assetB.approve(address(runtime), type(uint256).max);
            voidToken.approve(address(runtime), type(uint256).max);
            vm.stopPrank();
            voidToken.mint(owner, 1e24);
            voidToken.approve(address(runtime), type(uint256).max);
            vm.prank(owner);
            runtime.executeWithBudget(
                id, address(s),
                abi.encodeCall(ChainAppSwap.addLiquidity, (1e23, 1e23, 0)), tollOf(id),
                _authThree()
            );
        }
    }

    function _buildUsers() internal {
        for (uint256 i = 0; i < USERS; i++) {
            uint256 k = 0x1000 + i;
            userKeys.push(k);
            address u = vm.addr(k);
            users.push(u);
            pmNonce.push(0);

            voidToken.mint(u, 1e26);
            assetA.mint(u, 1e26);
            assetB.mint(u, 1e26);

            // PER-APPLICATION PERMISSION -- and this is where a real limitation of
            // the model lived, measured by this test and not hidden by it: the
            // bubble covered EXECUTION, but every application that moves the
            // user's tokens needed their permission, and granting permission is a
            // transaction a user without ETH cannot send.
            //
            // Here that is free (it is a test). In real life, either the token
            // implementa EIP-2612 e o relayer apresenta a assinatura, ou o
            // user needs ETH once per application -- which punctures the bubble.
            vm.startPrank(u);
            voidToken.approve(address(paymaster), type(uint256).max);
            // ONE authorization, to the runtime, covers every application. It used
            // to be one per app -- and each of those was a transaction the user
            // without ETH could not send.
            voidToken.approve(address(runtime), type(uint256).max);
            assetA.approve(address(runtime), type(uint256).max);
            assetB.approve(address(runtime), type(uint256).max);
            vm.stopPrank();
        }
    }

    /// @dev Only the NFT still needs a per-app permission: ERC-721 does not go
    ///      through `spendFrom`, which is for ERC-20. Closing that door would
    ///      also require a path of its own -- noted, not hidden.
    function _approveApps(uint256 slot, uint256 chainIdx) internal {
        vm.prank(users[slot]);
        nft.setApprovalForAll(address(markets[chainIdx]), true);
    }

    /// @dev Montagem e assinatura ficam em funcoes proprias: o corpo inteiro
    ///      did not fit on the EVM stack once the budget became a parameter.
    function _mkReq(
        uint256 slot, uint256 id, address target, bytes memory data,
        address spendToken, uint256 spendLimit
    ) internal returns (VoidPaymaster.SponsoredCall memory req) {
        req = VoidPaymaster.SponsoredCall({
            user: users[slot],
            tokenId: id,
            target: target,
            data: data,
            maxToll: tollOf(id),
            maxGasVoid: 5_000e18,
            callGasLimit: 800_000,
            spends: _oneSpend(spendToken, spendLimit),
            nftSpends: _noNfts(),
            nonce: pmNonce[slot]++,
            deadline: block.timestamp + 30 days
        });
    }

    function _signReq(uint256 slot, VoidPaymaster.SponsoredCall memory req)
        internal
        view
        returns (bytes memory)
    {
        bytes32 structHash = keccak256(
            abi.encode(
                typeHash, req.user, req.tokenId, req.target, keccak256(req.data),
                req.maxToll, req.maxGasVoid, req.callGasLimit,
                _hashSpends(req.spends), _hashNftSpends(req.nftSpends), req.nonce, req.deadline
            )
        );
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(userKeys[slot], keccak256(abi.encodePacked("\x19\x01", domainSep, structHash)));
        return abi.encodePacked(r, s, v);
    }

    function _call(
        uint256 slot, uint256 chainIdx, address target, bytes memory data,
        address spendToken, uint256 spendLimit
    ) internal returns (bool ok, uint256 gasUsed) {
        VoidPaymaster.SponsoredCall memory req =
            _mkReq(slot, chainIdx + 1, target, data, spendToken, spendLimit);
        bytes memory sig = _signReq(slot, req);

        uint256 g0 = gasleft();
        vm.prank(relayer);
        (ok,) = paymaster.sponsor(req, sig);
        gasUsed = g0 - gasleft();
        txCount++;
    }

    /// @dev One round across the three applications of a chain. Extracted from
    ///      the loop because the whole body did not fit on the EVM stack.
    function _round(uint256 c, uint256 slot, uint256 r) internal {
        _approveApps(slot, c);

        // --- DEX ---
        (bool okS, uint256 gS) = _call(
            slot, c, address(swaps[c]),
            abi.encodeCall(ChainAppSwap.swap, (r % 2 == 0, 1e18, 0)),
            r % 2 == 0 ? address(assetA) : address(assetB), 1e18
        );
        if (okS) { nSwap++; gasSwap += gS; }

        // --- LAUNCHPAD ---
        (bool okP, uint256 gP) = _call(
            slot, c, address(pads[c]), abi.encodeCall(ChainAppLaunchpad.buy, (1, 1e18)),
            address(voidToken), 1e18
        );
        if (okP) { nPad++; gasPad += gP; }

        // --- MERCADO --- (um anuncia, o seguinte compra)
        _marketRound(c, slot);
    }

    function _marketRound(uint256 c, uint256 slot) internal {
        uint256 id = nftId++;
        nft.mint(users[slot], id);
        (bool okL,) = _call(
            slot, c, address(markets[c]),
            abi.encodeCall(ChainAppMarket.list, (IERC721(address(nft)), id, 1e18)),
            address(voidToken), 0
        );
        if (!okL) return;

        uint256 buyer = (slot + 1) % USERS;
        _approveApps(buyer, c);
        uint256 listingId = markets[c].listingCount();
        (bool okB, uint256 gM) = _call(
            buyer, c, address(markets[c]), abi.encodeCall(ChainAppMarket.buy, (listingId)),
            address(voidToken), 1e18
        );
        if (okB) { nMarket++; gasMarket += gM; }
    }

    // =====================================================================
    // A carga
    // =====================================================================
    function test_cargaMassivaNasCemRedes() public {
        uint256 voidBefore;
        for (uint256 i = 0; i < USERS; i++) voidBefore += voidToken.balanceOf(users[i]);

        vm.txGasPrice(0.01 gwei);

        uint256 slot;

        for (uint256 c = 0; c < CHAINS; c++) {
            uint256 id = c + 1;

            // One sale per chain, opened by the owner.
            // Sale stock = (cap * 1e18) / price = 1e25. The owner has to hold
            // that BEFORE opening, because the launchpad collects the entire
            // stock at creation -- a sale promising undeposited tokens is a promise.
            address owner = owners[id % owners.length];
            assetA.mint(owner, 1e26);
            vm.startPrank(owner);
            assetA.approve(address(runtime), type(uint256).max);
            vm.stopPrank();
            vm.prank(owner);
            runtime.executeWithBudget(
                id, address(pads[c]),
                abi.encodeCall(
                    ChainAppLaunchpad.createSale,
                    (ILaunchERC20(address(assetA)), 1e15, 1e22, block.timestamp + 60 days)
                ),
                tollOf(id), _authThree()
            );

            for (uint256 r = 0; r < ROUNDS; r++) {
                slot = (slot + 1) % USERS;
                _round(c, slot, r);
            }
        }

        // =================================================================
        // What happened
        // =================================================================
        emit log_named_uint("transacoes patrocinadas", txCount);
        emit log_named_uint("  swaps na DEX         ", nSwap);
        emit log_named_uint("  compras no launchpad ", nPad);
        emit log_named_uint("  vendas no mercado    ", nMarket);
        emit log_named_uint("gas medio DEX          ", nSwap == 0 ? 0 : gasSwap / nSwap);
        emit log_named_uint("gas medio LAUNCHPAD    ", nPad == 0 ? 0 : gasPad / nPad);
        emit log_named_uint("gas medio MERCADO      ", nMarket == 0 ? 0 : gasMarket / nMarket);

        // --- ninguem tocou em ETH ---
        for (uint256 i = 0; i < USERS; i++) {
            assertEq(users[i].balance, 0, "a bubble user must not hold ETH");
        }

        // --- fee conservation across the 100 networks ---
        uint256 tollSum;
        uint256 pendingSum;
        for (uint256 id = 1; id <= CHAINS; id++) {
            (, uint256 fee, uint256 pending, uint256 lifetime, uint256 calls) = runtime.statsOf(id);
            assertEq(fee, tollOf(id), "the chain toll was altered");
            assertEq(lifetime, tollOf(id) * calls, "take does not match the chain toll");
            tollSum += lifetime;
            pendingSum += pending;
        }
        uint256 accrued = runtime.protocolAccrued();
        assertEq(accrued, tollSum * 200 / 10_000, "the 2% does not add up under load");
        assertEq(pendingSum + accrued, tollSum, "conservacao de taxa quebrou sob carga");

        // --- contabilidade do paymaster ---
        uint256 voidAfter;
        for (uint256 i = 0; i < USERS; i++) voidAfter += voidToken.balanceOf(users[i]);
        emit log_named_uint("total toll (wei VOID)", tollSum);
        emit log_named_uint("gas cobrado   (wei VOID)", paymaster.reimbursableVoid() + paymaster.surplusVoid());
        emit log_named_uint("  reposicao             ", paymaster.reimbursableVoid());
        emit log_named_uint("  margem                ", paymaster.surplusVoid());
        assertEq(
            paymaster.surplusVoid(),
            paymaster.reimbursableVoid() * MARGIN_BPS / 10_000,
            "the margin is not the declared fraction"
        );
        assertGt(voidBefore, voidAfter, "the users paid in VOID");
    }
}
