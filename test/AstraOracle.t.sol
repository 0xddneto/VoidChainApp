// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;
import {Test} from "forge-std/Test.sol";
import {VoidTwapOracleV6, IVoidTwapPoolV6, IAggregatorV3V6} from "../contracts/genesis/VoidTwapOracleV6.sol";

contract AstraOraclePool is IVoidTwapPoolV6 {
    function observe() external view returns (uint256, uint32) {
        return (block.timestamp * 1000 ether, uint32(block.timestamp));
    }
}
contract AstraOracleFeed is IAggregatorV3V6 {
    uint80 public round = 2;
    uint80 public answered = 2;
    uint256 public updated;
    function decimals() external pure returns (uint8) { return 8; }
    function set(uint80 round_, uint80 answered_, uint256 updated_) external {
        round = round_; answered = answered_; updated = updated_;
    }
    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return (round, 2000e8, updated, updated, answered);
    }
}
contract AstraOracleTest is Test {
    VoidTwapOracleV6 oracle;
    AstraOracleFeed feed;
    function setUp() public {
        vm.warp(10000);
        feed = new AstraOracleFeed();
        oracle = new VoidTwapOracleV6(new AstraOraclePool(), feed, 60, 3600);
        oracle.bootstrap();
        vm.warp(10060);
        oracle.update();
        feed.set(2, 2, block.timestamp);
    }
    function test_FreshCompleteFeedIsAccepted() public view {
        assertEq(oracle.voidUsd(), 2 ether);
        assertEq(oracle.usdToVoid(2 ether), 1 ether);
    }
    function test_FutureFeedTimestampIsRejected() public {
        feed.set(2, 2, block.timestamp + 1);
        vm.expectRevert(abi.encodeWithSelector(VoidTwapOracleV6.StaleEthUsd.selector, block.timestamp + 1));
        oracle.voidUsd();
    }
    function test_IncompleteRoundIsRejected() public {
        feed.set(2, 1, block.timestamp);
        vm.expectRevert(VoidTwapOracleV6.BadEthUsdAnswer.selector);
        oracle.usdToVoid(1 ether);
    }
    function test_ExpiredFeedIsRejected() public {
        feed.set(2, 2, block.timestamp - 3601);
        vm.expectRevert(abi.encodeWithSelector(VoidTwapOracleV6.StaleEthUsd.selector, block.timestamp - 3601));
        oracle.voidUsd();
    }
}
