// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {VoidTokenV9} from "../contracts/genesis/VoidTokenV9.sol";
import {
    VoidChainAppRuntime, IVoidChainDeed, IERC20, IVoidChainTreasury,
    IVoidPriceOracle as IRuntimeOracle
} from "../contracts/parent/VoidChainAppRuntime.sol";
import {
    VoidPaymaster, IERC20 as IPaymasterToken,
    IVoidChainAppRuntime as IPaymasterRuntime,
    IVoidPriceOracle as IPaymasterOracle
} from "../contracts/parent/VoidPaymaster.sol";
import {ChainAppBase, IVoidChainAppRuntime} from "../contracts/apps/ChainAppBase.sol";
import {MockOracle} from "./MockOracle.sol";

contract HundredsDeed is IVoidChainDeed {
    address public holder;
    constructor(address holder_) { holder = holder_; }
    function ownerOf(uint256) external view returns (address) { return holder; }
}

contract HundredsTreasury is IVoidChainTreasury {
    IERC20 public immutable token;
    address public protocolTreasury = address(0x9005);
    uint256 public settled;
    constructor(IERC20 token_) { token = token_; }
    function settle(uint256, uint256 amount) external { settled += amount; token.transferFrom(msg.sender, address(this), amount); }
    function settleTo(uint256, address, uint256 amount) external { settled += amount; token.transferFrom(msg.sender, address(this), amount); }
    function creditTo(address, uint256 amount) external { settled += amount; token.transferFrom(msg.sender, address(this), amount); }
}

contract HundredsApp is ChainAppBase {
    uint256 public calls;
    mapping(address => uint256) public callsByUser;
    constructor(IVoidChainAppRuntime runtime_) ChainAppBase(runtime_, 1) {}
    function ping() external onlyFromMyChain {
        ++calls;
        ++callsByUser[caller()];
    }
}

/// @notice 256 distinct zero-ETH users make 1,024 V10 sponsored calls.
/// @dev This specifically exercises the frozen protocol-operator path: no user
///      grants an allowance to either Paymaster or Runtime.
contract V10HundredsUsersTest is Test {
    uint256 private constant USERS = 256;
    uint256 private constant CALLS_PER_USER = 4;
    uint256 private constant TOLL = 1 ether;

    VoidTokenV9 private token;
    VoidChainAppRuntime private runtime;
    VoidPaymaster private paymaster;
    HundredsApp private app;

    receive() external payable {}

    function setUp() public {
        token = new VoidTokenV9(address(this), address(this));
        HundredsDeed deed = new HundredsDeed(address(this));
        HundredsTreasury treasury = new HundredsTreasury(IERC20(address(token)));
        MockOracle oracle = new MockOracle();
        runtime = new VoidChainAppRuntime(
            IVoidChainDeed(address(deed)), IERC20(address(token)), IVoidChainTreasury(address(treasury))
        );
        runtime.setDaoFactoryOnce(address(this));
        runtime.registerDao(1, address(this));
        runtime.setOracle(IRuntimeOracle(address(oracle)));
        paymaster = new VoidPaymaster(
            IPaymasterToken(address(token)), IPaymasterRuntime(address(runtime)), address(this),
            address(0x2117), IPaymasterOracle(address(oracle))
        );
        runtime.setForwarderOnce(address(paymaster));
        token.freezeProtocolOperators(address(runtime), address(paymaster));
        paymaster.setLimits(1 ether, 60_000, 10 gwei, 0);
        runtime.activate(1, TOLL);
        app = new HundredsApp(IVoidChainAppRuntime(address(runtime)));
        runtime.registerApp(1, address(app));
        vm.deal(address(paymaster), 1_000 ether);
        vm.deal(address(this), 1_000 ether);
        vm.txGasPrice(1 gwei);
    }

    function test_256UsersMake1024CallsWithoutEthOrAllowances() public {
        for (uint256 slot; slot < USERS; ++slot) {
            uint256 key = 10_000 + slot;
            address user = vm.addr(key);
            token.transfer(user, 1_000 ether);
            for (uint256 nonce; nonce < CALLS_PER_USER; ++nonce) {
                VoidPaymaster.SponsoredCall memory request = _request(user, nonce);
                (bool executed,) = paymaster.sponsor(request, _sign(key, request));
                assertTrue(executed, "sponsored call failed under load");
            }
            assertEq(user.balance, 0, "a sponsored user received ETH");
            assertEq(token.allowance(user, address(paymaster)), 0, "Paymaster allowance appeared");
            assertEq(token.allowance(user, address(runtime)), 0, "Runtime allowance appeared");
            assertEq(app.callsByUser(user), CALLS_PER_USER, "wrong per-user call count");
            assertEq(paymaster.nonces(user), CALLS_PER_USER, "wrong replay nonce");
        }

        uint256 expectedCalls = USERS * CALLS_PER_USER;
        (,, uint256 pending, uint256 lifetime, uint256 calls) = runtime.statsOf(1);
        assertEq(app.calls(), expectedCalls);
        assertEq(calls, expectedCalls);
        assertEq(lifetime, expectedCalls * TOLL);
        assertEq(pending + runtime.protocolAccrued(), lifetime, "fee conservation failed");
        assertEq(token.totalSupply(), token.MAX_SUPPLY(), "fixed supply changed under load");
    }

    function _request(address user, uint256 nonce)
        private view returns (VoidPaymaster.SponsoredCall memory)
    {
        return VoidPaymaster.SponsoredCall({
            user: user, tokenId: 1, target: address(app), data: abi.encodeCall(app.ping, ()),
            maxToll: TOLL, maxGasVoid: 100 ether, callGasLimit: 500_000,
            spends: new VoidPaymaster.Spend[](0), nftSpends: new VoidPaymaster.SpendNft[](0),
            nonce: nonce, deadline: block.timestamp + 1 days
        });
    }

    function _sign(uint256 key, VoidPaymaster.SponsoredCall memory request)
        private view returns (bytes memory)
    {
        bytes32[] memory spendHashes = new bytes32[](0);
        bytes32[] memory nftHashes = new bytes32[](0);
        bytes32 domain = keccak256(abi.encode(
            keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
            keccak256(bytes("VoidPaymaster")), keccak256(bytes("1")), block.chainid, address(paymaster)
        ));
        bytes memory first = abi.encode(
            paymaster.SPONSORED_CALL_TYPEHASH(), request.user, request.tokenId, request.target,
            keccak256(request.data), request.maxToll
        );
        bytes memory second = abi.encode(
            request.maxGasVoid, request.callGasLimit, keccak256(abi.encodePacked(spendHashes)),
            keccak256(abi.encodePacked(nftHashes)), request.nonce, request.deadline
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(
            key, keccak256(abi.encodePacked("\x19\x01", domain, keccak256(bytes.concat(first, second))))
        );
        return abi.encodePacked(r, s, v);
    }
}
