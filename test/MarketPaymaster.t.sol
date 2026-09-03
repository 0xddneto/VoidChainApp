// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {VoidChainAppRuntime, IVoidChainDeed as IRuntimeDeed, IERC20 as IRuntimeToken, IVoidChainTreasury, IVoidPriceOracle as IRuntimeOracle} from "../contracts/parent/VoidChainAppRuntime.sol";
import {VoidChainDeed} from "../contracts/parent/VoidChainDeed.sol";
import {VoidTestToken} from "../contracts/testnet/VoidTestToken.sol";
import {VoidNftAmm, IERC20 as IAmmToken, IERC721 as IAmmDeed} from "../contracts/testnet/VoidNftAmm.sol";
import {VoidCollectionMarket, ICollectionMarketToken, ICollectionMarketPool, ICollectionMarketDeed} from "../contracts/testnet/VoidCollectionMarket.sol";
import {VoidCollectionMintPaymaster, IMintPayToken, IMintPayOracle} from "../contracts/testnet/VoidCollectionMintPaymaster.sol";
import {MockOracle} from "./MockOracle.sol";

contract MarketPaymasterTreasury is IVoidChainTreasury {
    function protocolTreasury() external view returns (address) { return address(this); }
    function settle(uint256, uint256) external {}
    function settleTo(uint256, address, uint256) external {}
    function creditTo(address, uint256) external {}
}

/// @notice The collection mint is paid in VOID before the buyer activates a chain.
contract MarketPaymasterTest is Test {
    uint256 internal constant DEED_ID = 1;
    uint256 internal constant MAX_GAS = 20 ether;

    uint256 internal userPk = 0xA11CE;
    address internal user;
    address internal relayer = address(0xC0DE01);
    address internal holder = address(0xC0FFEE);
    address internal governor = address(0x600D);

    VoidTestToken internal token;
    VoidChainDeed internal deed;
    VoidChainAppRuntime internal runtime;
    VoidCollectionMintPaymaster internal paymaster;
    VoidNftAmm internal amm;
    VoidCollectionMarket internal collectionMarket;

    function setUp() public {
        user = vm.addr(userPk);
        token = new VoidTestToken();
        deed = new VoidChainDeed(46_630_000, address(this), address(this), 500);
        MarketPaymasterTreasury treasury = new MarketPaymasterTreasury();
        MockOracle oracle = new MockOracle();
        runtime = new VoidChainAppRuntime(
            IRuntimeDeed(address(deed)), IRuntimeToken(address(token)), IVoidChainTreasury(address(treasury))
        );
        runtime.setOracle(IRuntimeOracle(address(oracle)));
        paymaster = new VoidCollectionMintPaymaster(
            IMintPayToken(address(token)), IMintPayOracle(address(oracle)), governor
        );
        vm.startPrank(governor);
        paymaster.setLimits(1_000, 60_000, 10 gwei);
        vm.stopPrank();

        // This deed stays inactive: the collection market is not a chain app.
        deed.mint(holder, DEED_ID);
        amm = new VoidNftAmm(
            IAmmToken(address(token)), IAmmDeed(address(deed)), 100 ether, 1_000, 1_500, holder
        );
        token.mintTo(address(amm), 1_000 ether);
        vm.startPrank(holder);
        deed.setApprovalForAll(address(amm), true);
        amm.sell(DEED_ID, 0);
        vm.stopPrank();

        collectionMarket = new VoidCollectionMarket(
            ICollectionMarketToken(address(token)), ICollectionMarketPool(address(amm)),
            ICollectionMarketDeed(address(deed)), address(paymaster)
        );
        vm.prank(holder);
        amm.setSaleOperatorOnce(address(collectionMarket));
        vm.prank(governor);
        paymaster.setCollectionMarketOnce(address(collectionMarket));

        token.mintTo(user, 1_000 ether);
        vm.deal(address(paymaster), 10 ether);
        vm.deal(relayer, 10 ether);
    }

    function _request(uint256 maxCost)
        internal view returns (VoidCollectionMintPaymaster.MarketPrepaidCall memory req)
    {
        req = VoidCollectionMintPaymaster.MarketPrepaidCall({
            user: user, market: address(collectionMarket), paymentToken: address(token),
            paymentSymbol: "VOID", purchaseLabel: "VOID deed mint", appSpend: maxCost,
            maxGasVoid: MAX_GAS, callGasLimit: 1_500_000, nonce: paymaster.nonces(user),
            deadline: block.timestamp + 1 hours
        });
    }

    function _sign(VoidCollectionMintPaymaster.MarketPrepaidCall memory req) internal view returns (bytes memory) {
        bytes32 domain = keccak256(abi.encode(
            keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
            keccak256(bytes("VoidCollectionMintPaymaster")), keccak256(bytes("1")), block.chainid, address(paymaster)
        ));
        bytes memory encoded = abi.encode(
            paymaster.REQUEST_TYPEHASH(), req.user, req.market, req.paymentToken,
            keccak256(bytes(req.paymentSymbol)), keccak256(bytes(req.purchaseLabel)),
            req.appSpend, req.maxGasVoid, req.callGasLimit, req.nonce, req.deadline
        );
        bytes32 structHash = keccak256(encoded);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(
            userPk, keccak256(abi.encodePacked("\x19\x01", domain, structHash))
        );
        return abi.encodePacked(r, s, v);
    }

    function _approveExact(uint256 price) internal {
        vm.prank(user);
        token.approve(address(paymaster), price + MAX_GAS);
    }

    function test_oneExactApprovalAndOneSignatureMintsAnInactiveDeed() public {
        uint256 price = amm.priceToBuy(false);
        VoidCollectionMintPaymaster.MarketPrepaidCall memory req = _request(price);
        _approveExact(price);

        assertEq(user.balance, 0, "the buyer starts without ETH");
        assertEq(token.allowance(user, address(runtime)), 0, "runtime was never approved");
        vm.txGasPrice(1 gwei);
        vm.prank(relayer);
        (bool executed,) = paymaster.sponsorMarketPrepaid(req, _sign(req));

        assertTrue(executed, "the collection mint failed");
        assertEq(deed.ownerOf(DEED_ID), user, "the deed did not reach the signer");
        assertEq(amm.available(), 0, "the pool inventory was not consumed");
        assertTrue(collectionMarket.hasMinted(user), "mint limit was not recorded");
        assertEq(token.allowance(user, address(paymaster)), 0, "the exact approval remains");
        assertEq(token.allowance(address(paymaster), address(collectionMarket)), 0, "market allowance remains");
        (bool active,,,,) = runtime.statsOf(DEED_ID);
        assertFalse(active, "mint activated a chain without its owner");
    }

    function test_walletCannotMintTwiceEvenAfterTransfer() public {
        uint256 price = amm.priceToBuy(false);
        _approveExact(price);
        vm.txGasPrice(1 gwei);
        vm.prank(relayer);
        (bool first,) = paymaster.sponsorMarketPrepaid(_request(price), _sign(_request(price)));
        assertTrue(first, "first mint failed");

        vm.prank(user);
        deed.transferFrom(user, holder, DEED_ID);
        _approveExact(price);
        VoidCollectionMintPaymaster.MarketPrepaidCall memory second = _request(price);
        vm.prank(relayer);
        (bool executed,) = paymaster.sponsorMarketPrepaid(second, _sign(second));
        assertFalse(executed, "one wallet minted twice");
    }

    function test_marketRejectsEveryDirectCaller() public {
        uint256 price = amm.priceToBuy(false);
        vm.expectRevert(abi.encodeWithSelector(VoidCollectionMarket.NotPaymaster.selector, address(this)));
        collectionMarket.buyRandomFor(user, price);
    }

    function test_signedMaximumPriceStopsThePurchase() public {
        uint256 price = amm.priceToBuy(false);
        uint256 tooLow = price - 1;
        _approveExact(tooLow);
        VoidCollectionMintPaymaster.MarketPrepaidCall memory req = _request(tooLow);
        vm.txGasPrice(1 gwei);
        vm.prank(relayer);
        (bool executed,) = paymaster.sponsorMarketPrepaid(req, _sign(req));

        assertFalse(executed, "a price above the signed maximum bought the deed");
        assertEq(deed.ownerOf(DEED_ID), address(amm), "the pool released the deed anyway");
    }

    function test_signedMarketAddressCannotBeChanged() public {
        uint256 price = amm.priceToBuy(false);
        VoidCollectionMintPaymaster.MarketPrepaidCall memory req = _request(price);
        req.market = address(0xBEEF);
        _approveExact(price);

        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(
            VoidCollectionMintPaymaster.WrongMarket.selector, address(0xBEEF), address(collectionMarket)
        ));
        paymaster.sponsorMarketPrepaid(req, _sign(req));
    }
}
