// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {MockOracle} from "./MockOracle.sol";
import {
    VoidChainAppRuntime,
    IVoidChainDeed,
    IERC20,
    IVoidChainTreasury,
    IVoidPriceOracle
} from "../contracts/parent/VoidChainAppRuntime.sol";
import {VoidChainAppRuntimeV3} from "../contracts/parent/VoidChainAppRuntimeV3.sol";
import {ChainAppBase, IVoidChainAppRuntime} from "../contracts/apps/ChainAppBase.sol";

contract V3Deed is IVoidChainDeed {
    mapping(uint256 => address) public owner;
    function setOwner(uint256 tokenId, address holder) external { owner[tokenId] = holder; }
    function ownerOf(uint256 tokenId) external view returns (address) { return owner[tokenId]; }
}

contract V3Void is IERC20 {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    function mint(address to, uint256 amount) external { balanceOf[to] += amount; }
    function approve(address spender, uint256 amount) external returns (bool) { allowance[msg.sender][spender] = amount; return true; }
    function transfer(address to, uint256 amount) external returns (bool) { balanceOf[msg.sender] -= amount; balanceOf[to] += amount; return true; }
    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) allowance[from][msg.sender] = allowed - amount;
        balanceOf[from] -= amount; balanceOf[to] += amount; return true;
    }
}

contract V3Treasury is IVoidChainTreasury {
    function settle(uint256, uint256) external {}
    function settleTo(uint256, address, uint256) external {}
    function creditTo(address, uint256) external {}
    function protocolTreasury() external pure returns (address) { return address(0xBEEF); }
}

contract V3Recorder is ChainAppBase {
    address public lastCaller;
    constructor(IVoidChainAppRuntime runtime_, uint256 tokenId_) ChainAppBase(runtime_, tokenId_) {}
    function ping() external onlyFromMyChain { lastCaller = caller(); }
}

contract RuntimeV3Test is Test {
    uint256 private constant CHAIN = 1;
    uint256 private constant FEE = 1e15;
    address private constant HOLDER = address(0xA11CE);
    address private constant USER = address(0xB0B);
    address private constant FORWARDER = address(0xF0A4);

    V3Deed private deed;
    V3Void private token;
    VoidChainAppRuntimeV3 private runtime;
    V3Recorder private app;

    function setUp() public {
        deed = new V3Deed(); token = new V3Void();
        runtime = new VoidChainAppRuntimeV3(deed, token, new V3Treasury());
        runtime.setOracle(IVoidPriceOracle(address(new MockOracle())));
        runtime.setForwarderOnce(FORWARDER);
        runtime.setDaoFactoryOnce(address(this));
        runtime.registerDao(CHAIN, address(this));
        deed.setOwner(CHAIN, HOLDER);
        vm.prank(HOLDER); runtime.activate(CHAIN, FEE);
        app = new V3Recorder(IVoidChainAppRuntime(address(runtime)), CHAIN);
        runtime.setAppFactoryOnce(address(this));
        runtime.registerFromFactory(CHAIN, address(app), address(this));

        token.mint(FORWARDER, FEE);
        vm.prank(FORWARDER); token.approve(address(runtime), FEE);
    }

    function test_directExecutionSelectorsAlwaysRevert() public {
        vm.prank(USER);
        (bool executeOk, bytes memory executeReason) = address(runtime).call(
            abi.encodeCall(runtime.execute, (CHAIN, address(app), abi.encodeCall(V3Recorder.ping, ()), FEE))
        );
        assertFalse(executeOk);
        assertEq(bytes4(executeReason), VoidChainAppRuntimeV3.DirectExecutionDisabled.selector);

        address[] memory tokens = new address[](0);
        uint256[] memory limits = new uint256[](0);
        address[] memory collections = new address[](0);
        uint256[] memory nftIds = new uint256[](0);
        VoidChainAppRuntime.SpendAuth memory auth = VoidChainAppRuntime.SpendAuth(tokens, limits, collections, nftIds);
        vm.prank(USER);
        (bool budgetOk, bytes memory budgetReason) = address(runtime).call(
            abi.encodeCall(runtime.executeWithBudget, (CHAIN, address(app), abi.encodeCall(V3Recorder.ping, ()), FEE, auth))
        );
        assertFalse(budgetOk);
        assertEq(bytes4(budgetReason), VoidChainAppRuntimeV3.DirectExecutionDisabled.selector);
    }

    function test_onlyFrozenForwarderCanExecuteForAUser() public {
        vm.prank(USER);
        vm.expectRevert(abi.encodeWithSelector(VoidChainAppRuntime.NotTheForwarder.selector, USER));
        runtime.executeFor(USER, CHAIN, address(app), abi.encodeCall(V3Recorder.ping, ()), FEE);

        vm.prank(FORWARDER);
        runtime.executeFor(USER, CHAIN, address(app), abi.encodeCall(V3Recorder.ping, ()), FEE);
        assertEq(app.lastCaller(), USER);
    }
}
