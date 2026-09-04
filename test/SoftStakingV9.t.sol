// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {VoidTokenV9} from "../contracts/genesis/VoidTokenV9.sol";
import {VoidSoftStakingV9, IVoidBurnableV9, IVoidStakeDeedV9} from "../contracts/genesis/VoidSoftStakingV9.sol";
import {VoidChainAppGateway} from "../contracts/parent/VoidChainAppFactoryV3.sol";
import {IVoidChainAppRuntime} from "../contracts/apps/ChainAppBase.sol";

contract StakingDeed is IVoidStakeDeedV9 {
    mapping(uint256 => address) public owner;
    mapping(uint256 => uint256) public ownershipEpoch;
    function setOwner(uint256 id, address next) external {
        if (owner[id] != address(0) && owner[id] != next) ++ownershipEpoch[id];
        owner[id] = next;
    }
    function ownerOf(uint256 id) external view returns (address) { return owner[id]; }
}

contract StakingRuntime is IVoidChainAppRuntime {
    uint256 public executingChain;
    address public executingCaller;
    address private target;
    function execute(address user, address app, bytes calldata data) external {
        executingChain = 1; executingCaller = user; target = app;
        (bool ok, bytes memory reason) = app.call(data);
        if (!ok) assembly { revert(add(reason, 32), mload(reason)) }
        executingChain = 0; executingCaller = address(0); target = address(0);
    }
    function spendFrom(address token, address to, uint256 amount) external {
        require(msg.sender == target, "wrong app");
        VoidTokenV9(token).protocolTransferFrom(executingCaller, to, amount);
    }
    function spendNftFrom(address, address, uint256) external pure { revert(); }
}

contract SoftStakingV9Test is Test {
    address private constant USER = address(0xA11CE);
    address private constant NEXT_OWNER = address(0xB0B);
    address private constant TREASURY = address(0xD00D);
    VoidTokenV9 private token;
    StakingDeed private deed;
    StakingRuntime private runtime;
    VoidSoftStakingV9 private implementation;
    VoidChainAppGateway private gateway;

    function setUp() public {
        runtime = new StakingRuntime();
        token = new VoidTokenV9(address(this), address(this));
        token.freezeProtocolOperators(address(runtime), address(0xBEEF));
        deed = new StakingDeed();
        deed.setOwner(1, USER);
        implementation = new VoidSoftStakingV9(
            IVoidChainAppRuntime(address(runtime)), 1, IVoidBurnableV9(address(token)),
            IVoidStakeDeedV9(address(deed)), TREASURY
        );
        gateway = new VoidChainAppGateway(address(runtime), 1, address(implementation), "");
        token.transfer(USER, 1_000_000 ether);
    }

    function test_ActivationBurns95PercentAndStreamsRewardsWithoutCustody() public {
        uint256 supplyBefore = token.totalSupply();
        runtime.execute(USER, address(gateway), abi.encodeCall(implementation.activate, (1, 1)));
        assertEq(deed.ownerOf(1), USER);
        assertEq(token.balanceOf(TREASURY), 2_500 ether);
        assertEq(supplyBefore - token.totalSupply(), 47_500 ether);

        uint256 reward = 30 days * 1 ether;
        token.transfer(address(gateway), reward);
        runtime.execute(USER, address(gateway), abi.encodeCall(implementation.syncRewards, ()));
        vm.warp(block.timestamp + 15 days);
        uint256 before = token.balanceOf(USER);
        runtime.execute(USER, address(gateway), abi.encodeCall(implementation.claim, (1)));
        assertApproxEqAbs(token.balanceOf(USER) - before, reward / 2, 2 ether);
    }

    function test_TransferInvalidatesPositionAndForfeitsUnclaimedRewards() public {
        runtime.execute(USER, address(gateway), abi.encodeCall(implementation.activate, (1, 2)));
        deed.setOwner(1, NEXT_OWNER);
        runtime.execute(NEXT_OWNER, address(gateway), abi.encodeCall(implementation.invalidate, (1)));
        bytes memory raw = gateway.query(abi.encodeCall(implementation.positions, (1)));
        (address positionOwner,,,,) = abi.decode(raw, (address, uint64, uint32, uint256, uint256));
        assertEq(positionOwner, address(0));
    }
}
