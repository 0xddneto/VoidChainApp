// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {
    VoidChainAppRuntime,
    IVoidChainDeed as IRuntimeDeed,
    IERC20 as IRuntimeToken,
    IVoidChainTreasury,
    IVoidPriceOracle as IRuntimeOracle
} from "../contracts/parent/VoidChainAppRuntime.sol";
import {
    VoidPaymaster,
    IERC20 as IPaymasterToken,
    IVoidChainAppRuntime as IPaymasterRuntime,
    IVoidPriceOracle as IPaymasterOracle
} from "../contracts/parent/VoidPaymaster.sol";
import {VoidChainDeed} from "../contracts/parent/VoidChainDeed.sol";
import {VoidTestToken} from "../contracts/testnet/VoidTestToken.sol";
import {VoidNftAmm, IERC20 as IAmmToken, IERC721 as IAmmDeed} from "../contracts/testnet/VoidNftAmm.sol";
import {
    VoidMarketApp,
    IMarketVoidToken,
    IVoidDeedMarket,
    IMarketDeed
} from "../contracts/apps/VoidMarketApp.sol";
import {ChainAppBase, IVoidChainAppRuntime} from "../contracts/apps/ChainAppBase.sol";
import {MockOracle} from "./MockOracle.sol";

contract MarketPaymasterTreasury is IVoidChainTreasury {
    address public protocolTreasury = address(0xD00D);

    function settle(uint256, uint256) external {}
    function settleTo(uint256, address, uint256) external {}
    function creditTo(address, uint256) external {}
}

/// @notice The market purchase path for a wallet with VOID but zero ETH.
contract MarketPaymasterTest is Test {
    uint256 internal constant CHAIN = 1111;
    uint256 internal constant TOLL = 1 ether;
    uint256 internal constant MAX_GAS = 20 ether;

    uint256 internal userPk = 0xA11CE;
    address internal user;
    address internal relayer = address(0xC0DE01);
    address internal chainHolder = address(0xC0FFEE);
    address internal governor = address(0x600D);

    VoidTestToken internal token;
    VoidChainDeed internal deed;
    VoidChainAppRuntime internal runtime;
    VoidPaymaster internal paymaster;
    VoidNftAmm internal amm;
    VoidMarketApp internal marketApp;

    function setUp() public {
        user = vm.addr(userPk);
        token = new VoidTestToken();
        deed = new VoidChainDeed(46_630_000, address(this), address(this), 500);
        MarketPaymasterTreasury treasury = new MarketPaymasterTreasury();
        MockOracle oracle = new MockOracle();

        runtime = new VoidChainAppRuntime(
            IRuntimeDeed(address(deed)), IRuntimeToken(address(token)), IVoidChainTreasury(address(treasury))
        );
        runtime.setDaoFactoryOnce(address(this));
        runtime.registerDao(CHAIN, address(this));
        runtime.setOracle(IRuntimeOracle(address(oracle)));
        paymaster = new VoidPaymaster(
            IPaymasterToken(address(token)),
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

        deed.mint(chainHolder, CHAIN);
        vm.prank(chainHolder);
        runtime.activate(CHAIN, TOLL);

        amm = new VoidNftAmm(IAmmToken(address(token)), IAmmDeed(address(deed)), 100 ether, 1_000, 1_500);
        token.mintTo(address(amm), 1_000 ether);
        vm.prank(chainHolder);
        deed.setApprovalForAll(address(amm), true);
        vm.prank(chainHolder);
        amm.sell(CHAIN, 0);

        marketApp = new VoidMarketApp(
            IVoidChainAppRuntime(address(runtime)),
            CHAIN,
            IMarketVoidToken(address(token)),
            IVoidDeedMarket(address(amm)),
            IMarketDeed(address(deed))
        );
        runtime.registerApp(CHAIN, address(marketApp));

        token.mintTo(user, 1_000 ether);
        vm.deal(address(paymaster), 10 ether);
        vm.deal(relayer, 10 ether);
    }

    function _noNfts() internal pure returns (VoidPaymaster.SpendNft[] memory) {
        return new VoidPaymaster.SpendNft[](0);
    }

    function _spend(uint256 amount) internal view returns (VoidPaymaster.Spend[] memory spends) {
        spends = new VoidPaymaster.Spend[](1);
        spends[0] = VoidPaymaster.Spend({token: address(token), amount: amount});
    }

    function _hashSpends(VoidPaymaster.Spend[] memory spends) internal pure returns (bytes32) {
        bytes32[] memory hashes = new bytes32[](spends.length);
        for (uint256 i; i < spends.length; ++i) {
            hashes[i] = keccak256(
                abi.encode(keccak256("Spend(address token,uint256 amount)"), spends[i].token, spends[i].amount)
            );
        }
        return keccak256(abi.encodePacked(hashes));
    }

    function _hashNftSpends(VoidPaymaster.SpendNft[] memory spends) internal pure returns (bytes32) {
        bytes32[] memory hashes = new bytes32[](spends.length);
        for (uint256 i; i < spends.length; ++i) {
            hashes[i] = keccak256(
                abi.encode(
                    keccak256("SpendNft(address collection,uint256 tokenId)"),
                    spends[i].collection,
                    spends[i].tokenId
                )
            );
        }
        return keccak256(abi.encodePacked(hashes));
    }

    function _request(uint256 maxCost) internal view returns (VoidPaymaster.SponsoredCall memory req) {
        req = VoidPaymaster.SponsoredCall({
            user: user,
            tokenId: CHAIN,
            target: address(marketApp),
            data: abi.encodeCall(VoidMarketApp.buyRandom, (maxCost)),
            maxToll: TOLL,
            maxGasVoid: MAX_GAS,
            callGasLimit: 1_500_000,
            spends: _spend(maxCost),
            nftSpends: _noNfts(),
            nonce: paymaster.nonces(user),
            deadline: block.timestamp + 1 hours
        });
    }

    function _sign(VoidPaymaster.SponsoredCall memory req) internal view returns (bytes memory) {
        bytes32 domain = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
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
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(userPk, keccak256(abi.encodePacked("\x19\x01", domain, structHash)));
        return abi.encodePacked(r, s, v);
    }

    function _permit(address spender, uint256 value, uint256 nonceOffset)
        internal
        view
        returns (VoidPaymaster.Permit memory p)
    {
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 structHash = keccak256(
            abi.encode(
                token.PERMIT_TYPEHASH(), user, spender, value, token.nonces(user) + nonceOffset, deadline
            )
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(
            userPk, keccak256(abi.encodePacked("\x19\x01", token.DOMAIN_SEPARATOR(), structHash))
        );
        return VoidPaymaster.Permit({spender: spender, value: value, deadline: deadline, v: v, r: r, s: s});
    }

    function _permits(uint256 marketBudget) internal view returns (VoidPaymaster.Permit[] memory list) {
        list = new VoidPaymaster.Permit[](2);
        list[0] = _permit(address(paymaster), TOLL + MAX_GAS, 0);
        list[1] = _permit(address(runtime), marketBudget, 1);
    }

    function test_zeroEthWalletBuysThroughThePaymaster() public {
        uint256 price = amm.priceToBuy(false);
        VoidPaymaster.SponsoredCall memory req = _request(price);
        bytes memory signature = _sign(req);
        VoidPaymaster.Permit[] memory permissions = _permits(price);

        assertEq(user.balance, 0, "the buyer starts without ETH");
        vm.txGasPrice(1 gwei);
        vm.prank(relayer);
        (bool executed,) = paymaster.sponsorWithPermit(req, signature, permissions);

        assertTrue(executed, "the sponsored market call failed");
        assertEq(deed.ownerOf(CHAIN), user, "the purchased deed did not reach the buyer");
        assertEq(amm.available(), 0, "the pool inventory was not consumed");
        assertEq(token.allowance(address(marketApp), address(amm)), 0, "market kept an allowance");
        assertEq(user.balance, 0, "the buyer needed ETH");
    }

    function test_marketCannotBeCalledOutsideItsChainRuntime() public {
        uint256 price = amm.priceToBuy(false);
        vm.expectRevert(
            abi.encodeWithSelector(ChainAppBase.NotCalledByRuntime.selector, address(this))
        );
        marketApp.buyRandom(price);
    }

    function test_signedMaximumPriceStopsThePurchase() public {
        uint256 price = amm.priceToBuy(false);
        uint256 tooLow = price - 1;
        VoidPaymaster.SponsoredCall memory req = _request(tooLow);
        bytes memory signature = _sign(req);
        VoidPaymaster.Permit[] memory permissions = _permits(tooLow);

        vm.txGasPrice(1 gwei);
        vm.prank(relayer);
        (bool executed,) = paymaster.sponsorWithPermit(req, signature, permissions);

        assertFalse(executed, "a price above the signed maximum bought the deed");
        assertEq(deed.ownerOf(CHAIN), address(amm), "the AMM released the deed anyway");
    }

    function test_paymasterRejectsAThirdPartyPermitSpender() public {
        uint256 price = amm.priceToBuy(false);
        VoidPaymaster.SponsoredCall memory req = _request(price);
        VoidPaymaster.Permit[] memory permits = new VoidPaymaster.Permit[](1);
        permits[0] = VoidPaymaster.Permit({
            spender: address(0xBEEF), value: 1, deadline: block.timestamp + 1 hours, v: 27, r: bytes32(0), s: bytes32(0)
        });
        bytes memory signature = _sign(req);

        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(VoidPaymaster.UnexpectedPermitSpender.selector, address(0xBEEF)));
        paymaster.sponsorWithPermit(req, signature, permits);
    }

    function test_runtimePermitMustCoverTheSignedMarketBudget() public {
        uint256 price = amm.priceToBuy(false);
        VoidPaymaster.SponsoredCall memory req = _request(price);
        VoidPaymaster.Permit[] memory permits = _permits(price - 1);
        bytes memory signature = _sign(req);

        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(VoidPaymaster.PermitDidNotStick.selector, user));
        paymaster.sponsorWithPermit(req, signature, permits);
    }
}
