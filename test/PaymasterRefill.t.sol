// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, StdStorage, stdStorage} from "forge-std/Test.sol";
import {MockOracle} from "./MockOracle.sol";
import {
    VoidPaymaster,
    IERC20 as IPaymasterToken,
    IVoidChainAppRuntime as IPaymasterRuntime,
    IVoidPriceOracle as IPaymasterOracle,
    ISwapRouter,
    IWETH
} from "../contracts/parent/VoidPaymaster.sol";

contract RefillToken is IPaymasterToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external { balanceOf[to] += amount; }

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
        uint256 approved = allowance[from][msg.sender];
        if (approved != type(uint256).max) allowance[from][msg.sender] = approved - amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

contract RefillWeth is IWETH {
    mapping(address => uint256) public balanceOf;

    function mint(address to, uint256 amount) external { balanceOf[to] += amount; }

    function withdraw(uint256 amount) external {
        balanceOf[msg.sender] -= amount;
        (bool ok,) = payable(msg.sender).call{value: amount}("");
        require(ok, "eth transfer");
    }
}

contract RefillRouter is ISwapRouter {
    RefillToken public immutable token;
    RefillWeth public immutable weth;
    uint256 public immutable voidPerEth;

    constructor(RefillToken token_, RefillWeth weth_, uint256 voidPerEth_) {
        token = token_;
        weth = weth_;
        voidPerEth = voidPerEth_;
    }

    function exactInputSingle(ExactInputSingleParams calldata p)
        external
        payable
        returns (uint256 amountOut)
    {
        require(p.tokenIn == address(token) && p.tokenOut == address(weth), "wrong route");
        require(token.transferFrom(msg.sender, address(this), p.amountIn), "pull failed");
        amountOut = (p.amountIn * 1e18) / voidPerEth;
        require(amountOut >= p.amountOutMinimum, "slippage");
        weth.mint(p.recipient, amountOut);
    }
}

contract PaymasterRefillTest is Test {
    using stdStorage for StdStorage;

    uint256 internal constant RATE = 10_000e18;
    address internal constant GOVERNOR = address(0xBEEF);

    RefillToken internal token;
    RefillWeth internal weth;
    RefillRouter internal router;
    MockOracle internal oracle;
    VoidPaymaster internal paymaster;

    function setUp() public {
        token = new RefillToken();
        weth = new RefillWeth();
        router = new RefillRouter(token, weth, RATE);
        oracle = new MockOracle();
        oracle.setVoidPerEth(RATE);
        paymaster = new VoidPaymaster(
            IPaymasterToken(address(token)),
            IPaymasterRuntime(address(0x1001)),
            GOVERNOR,
            address(0x1002),
            IPaymasterOracle(address(oracle))
        );
        vm.deal(address(weth), 100 ether);
        vm.prank(GOVERNOR);
        paymaster.setSwapRoute(ISwapRouter(address(router)), address(weth), 3_000);
        vm.prank(GOVERNOR);
        paymaster.setRefillPolicy(0.95 ether, 1 ether, 500);
    }

    function _fundReplacement(uint256 voidAmount) internal {
        token.mint(address(paymaster), voidAmount);
        stdstore.target(address(paymaster)).sig("reimbursableVoid()").checked_write(voidAmount);
    }

    function test_publicRefillUsesTheBoundedPlanAndClearsAllowance() public {
        uint256 missing = 0.1 ether;
        vm.deal(address(paymaster), 1 ether - missing);
        _fundReplacement(missing * RATE / 1e18);

        (bool shouldRefill, uint256 amountVoid, uint256 minEthOut) = paymaster.refillPlan();
        assertTrue(shouldRefill, "reserve should need a refill");
        assertEq(amountVoid, missing * RATE / 1e18, "plan uses only the missing reserve");
        assertEq(minEthOut, missing * 9_500 / 10_000, "minimum honors the 5 percent cap");

        paymaster.refill(amountVoid, minEthOut);

        assertEq(address(paymaster).balance, 1 ether, "reserve returned to its target");
        assertEq(paymaster.reimbursableVoid(), 0, "replacement account was settled");
        assertEq(token.allowance(address(paymaster), address(router)), 0, "router allowance cleared");
    }

    function test_refillRejectsAUserChosenDiscountBelowTheTwapFloor() public {
        uint256 missing = 0.1 ether;
        vm.deal(address(paymaster), 1 ether - missing);
        _fundReplacement(missing * RATE / 1e18);
        (, uint256 amountVoid, uint256 minEthOut) = paymaster.refillPlan();

        vm.expectRevert(abi.encodeWithSelector(
            VoidPaymaster.RefillMinOutTooLow.selector, minEthOut - 1, minEthOut
        ));
        paymaster.refill(amountVoid, minEthOut - 1);
    }

    function test_refillRejectsASaleWhenTheReserveIsHealthy() public {
        vm.deal(address(paymaster), 1 ether);
        _fundReplacement(1_000e18);

        vm.expectRevert(abi.encodeWithSelector(
            VoidPaymaster.RefillNotNeeded.selector, 1 ether, 0.95 ether, 1_000e18
        ));
        paymaster.refill(1e18, 1);
    }

    function test_governanceCannotSetAnUnsafeRefillPolicy() public {
        vm.prank(GOVERNOR);
        vm.expectRevert(abi.encodeWithSelector(
            VoidPaymaster.BadRefillPolicy.selector, 1 ether, 1 ether, 500
        ));
        paymaster.setRefillPolicy(1 ether, 1 ether, 500);

        vm.prank(GOVERNOR);
        vm.expectRevert(abi.encodeWithSelector(
            VoidPaymaster.BadRefillPolicy.selector, 0.5 ether, 1 ether, 501
        ));
        paymaster.setRefillPolicy(0.5 ether, 1 ether, 501);
    }
}
