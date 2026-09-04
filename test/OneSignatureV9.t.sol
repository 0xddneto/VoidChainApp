// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {VoidTokenV9} from "../contracts/genesis/VoidTokenV9.sol";
import {
    VoidChainAppRuntime,
    IVoidChainDeed,
    IERC20,
    IVoidChainTreasury,
    IVoidPriceOracle as IRuntimeOracle
} from "../contracts/parent/VoidChainAppRuntime.sol";
import {
    VoidPaymaster,
    IERC20 as IPaymasterToken,
    IVoidChainAppRuntime as IPaymasterRuntime,
    IVoidPriceOracle as IPaymasterOracle
} from "../contracts/parent/VoidPaymaster.sol";
import {ChainAppBase, IVoidChainAppRuntime} from "../contracts/apps/ChainAppBase.sol";
import {MockOracle} from "./MockOracle.sol";

contract OneSigDeed is IVoidChainDeed {
    mapping(uint256 => address) public owner;
    function setOwner(uint256 id, address value) external { owner[id] = value; }
    function ownerOf(uint256 id) external view returns (address) { return owner[id]; }
}

contract OneSigTreasury is IVoidChainTreasury {
    IERC20 public immutable token;
    address public protocolTreasury = address(0x9005);
    constructor(IERC20 token_) { token = token_; }
    function settle(uint256, uint256 amount) external { token.transferFrom(msg.sender, address(this), amount); }
    function settleTo(uint256, address, uint256 amount) external { token.transferFrom(msg.sender, address(this), amount); }
    function creditTo(address, uint256 amount) external { token.transferFrom(msg.sender, address(this), amount); }
}

contract OneSigApp is ChainAppBase {
    uint256 public calls;
    constructor(IVoidChainAppRuntime runtime_, uint256 chain_) ChainAppBase(runtime_, chain_) {}
    function ping() external onlyFromMyChain { ++calls; }
}

contract OneSignatureV9Test is Test {
    uint256 private constant USER_KEY = 0xA11CE;
    uint256 private constant CHAIN = 1;
    address private user;
    VoidTokenV9 private token;
    VoidChainAppRuntime private runtime;
    VoidPaymaster private paymaster;
    OneSigApp private app;

    receive() external payable {}

    function setUp() public {
        user = vm.addr(USER_KEY);
        OneSigDeed deed = new OneSigDeed();
        deed.setOwner(CHAIN, address(this));
        MockOracle oracle = new MockOracle();
        token = new VoidTokenV9(address(this), address(this));
        OneSigTreasury treasury = new OneSigTreasury(IERC20(address(token)));
        runtime = new VoidChainAppRuntime(
            IVoidChainDeed(address(deed)), IERC20(address(token)), IVoidChainTreasury(address(treasury))
        );
        runtime.setDaoFactoryOnce(address(this));
        runtime.registerDao(CHAIN, address(this));
        runtime.setOracle(IRuntimeOracle(address(oracle)));
        paymaster = new VoidPaymaster(
            IPaymasterToken(address(token)), IPaymasterRuntime(address(runtime)), address(this),
            address(0x2117), IPaymasterOracle(address(oracle))
        );
        runtime.setForwarderOnce(address(paymaster));
        token.freezeProtocolOperators(address(runtime), address(paymaster));
        paymaster.setLimits(1 ether, 60_000, 10 gwei, 0);
        runtime.activate(CHAIN, 1 ether);
        app = new OneSigApp(IVoidChainAppRuntime(address(runtime)), CHAIN);
        runtime.registerApp(CHAIN, address(app));
        token.transfer(user, 1_000 ether);
        vm.deal(address(paymaster), 10 ether);
        vm.deal(address(this), 1 ether);
    }

    function test_FirstUseNeedsOnlyActionSignatureAndNoAllowance() public {
        VoidPaymaster.SponsoredCall memory request = VoidPaymaster.SponsoredCall({
            user: user,
            tokenId: CHAIN,
            target: address(app),
            data: abi.encodeCall(app.ping, ()),
            maxToll: 1 ether,
            maxGasVoid: 100 ether,
            callGasLimit: 500_000,
            spends: new VoidPaymaster.Spend[](0),
            nftSpends: new VoidPaymaster.SpendNft[](0),
            nonce: 0,
            deadline: block.timestamp + 1 hours
        });
        assertEq(token.allowance(user, address(paymaster)), 0);
        assertEq(token.allowance(user, address(runtime)), 0);
        vm.txGasPrice(1 gwei);
        (bool executed,) = paymaster.sponsor(request, _sign(request));
        assertTrue(executed);
        assertEq(app.calls(), 1);
        assertEq(token.allowance(user, address(paymaster)), 0);
        assertEq(token.allowance(user, address(runtime)), 0);
    }

    function _sign(VoidPaymaster.SponsoredCall memory request) private view returns (bytes memory) {
        bytes32[] memory spendHashes = new bytes32[](request.spends.length);
        bytes32[] memory nftHashes = new bytes32[](request.nftSpends.length);
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
        bytes32 structHash = keccak256(bytes.concat(first, second));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(
            USER_KEY, keccak256(abi.encodePacked("\x19\x01", domain, structHash))
        );
        return abi.encodePacked(r, s, v);
    }
}
