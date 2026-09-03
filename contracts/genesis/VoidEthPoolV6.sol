// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

interface IVoidPoolToken {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

/// @title VoidEthPoolV6
/// @notice Permanently locked VOID/ETH constant-product genesis pool.
/// @dev The 30 bps trade fee remains in the pool, increasing the value of the
/// permanently locked liquidity. A cumulative VOID-per-ETH price is updated on
/// every state transition for the Paymaster TWAP oracle.
contract VoidEthPoolV6 is ReentrancyGuard {
    uint256 public constant BPS = 10_000;
    uint256 public constant SWAP_FEE_BPS = 30;

    IVoidPoolToken public immutable voidToken;
    address public immutable bootstrapGovernor;
    address public genesisController;
    address public immutable lpLock;

    uint112 public reserveVoid;
    uint112 public reserveEth;
    uint32 public lastTimestamp;
    uint256 public voidPerEthCumulative;
    uint256 public totalLiquidity;
    mapping(address provider => uint256) public liquidityOf;

    event GenesisLiquidityAdded(uint256 voidAmount, uint256 ethAmount, uint256 liquidity);
    event GenesisControllerSet(address indexed controller);
    event SwapVoidForEth(address indexed caller, uint256 voidIn, uint256 ethOut);
    event SwapEthForVoid(address indexed caller, uint256 ethIn, uint256 voidOut);
    event Sync(uint112 reserveVoid, uint112 reserveEth, uint256 cumulative);

    error ZeroAddress();
    error NotGenesisController(address caller);
    error NotBootstrapGovernor(address caller);
    error GenesisControllerAlreadySet(address controller);
    error ZeroLiquidity();
    error RatioMismatch();
    error Slippage(uint256 actual, uint256 minimum);
    error InsufficientLiquidity();
    error TokenTransferFailed();
    error EthTransferFailed();
    error DirectEthDisabled();

    constructor(IVoidPoolToken token_, address governor_, address lpLock_) {
        if (address(token_) == address(0) || governor_ == address(0) || lpLock_ == address(0)) {
            revert ZeroAddress();
        }
        voidToken = token_;
        bootstrapGovernor = governor_;
        lpLock = lpLock_;
        lastTimestamp = uint32(block.timestamp);
    }

    receive() external payable { revert DirectEthDisabled(); }

    /// @notice Pins the mint contract once before the pool receives liquidity.
    function setGenesisControllerOnce(address controller_) external {
        if (msg.sender != bootstrapGovernor) revert NotBootstrapGovernor(msg.sender);
        if (genesisController != address(0)) revert GenesisControllerAlreadySet(genesisController);
        if (controller_ == address(0)) revert ZeroAddress();
        genesisController = controller_;
        emit GenesisControllerSet(controller_);
    }

    /// @notice Adds the fixed-ratio ETH and VOID released by one ETH mint.
    /// @dev The caller first transfers `voidAmount` from the escrow into this
    /// pool, then calls this payable function atomically from the mint flow.
    function addGenesisLiquidity(uint256 voidAmount)
        external
        payable
        nonReentrant
        returns (uint256 liquidity)
    {
        if (msg.sender != genesisController) revert NotGenesisController(msg.sender);
        if (voidAmount == 0 || msg.value == 0) revert ZeroLiquidity();

        uint256 previousVoid = reserveVoid;
        uint256 previousEth = reserveEth;
        uint256 actualVoid = voidToken.balanceOf(address(this));
        if (actualVoid != previousVoid + voidAmount) revert RatioMismatch();

        _accumulate(previousVoid, previousEth);
        if (totalLiquidity == 0) {
            liquidity = Math.sqrt(voidAmount * msg.value);
        } else {
            uint256 byVoid = Math.mulDiv(voidAmount, totalLiquidity, previousVoid);
            uint256 byEth = Math.mulDiv(msg.value, totalLiquidity, previousEth);
            liquidity = byVoid < byEth ? byVoid : byEth;
        }
        if (liquidity == 0) revert ZeroLiquidity();
        totalLiquidity += liquidity;
        liquidityOf[lpLock] += liquidity;
        _setReserves(actualVoid, previousEth + msg.value);
        emit GenesisLiquidityAdded(voidAmount, msg.value, liquidity);
    }

    /// @notice VOID -> ETH path used by the Paymaster refill and any direct
    /// market participant. The 30 bps LP fee stays inside locked liquidity.
    function swapVoidForEth(uint256 voidIn, uint256 minEthOut)
        external
        nonReentrant
        returns (uint256 ethOut)
    {
        if (voidIn == 0) revert ZeroLiquidity();
        uint256 oldVoid = reserveVoid;
        uint256 oldEth = reserveEth;
        if (oldVoid == 0 || oldEth == 0) revert InsufficientLiquidity();
        if (!voidToken.transferFrom(msg.sender, address(this), voidIn)) revert TokenTransferFailed();
        uint256 effective = (voidIn * (BPS - SWAP_FEE_BPS)) / BPS;
        ethOut = Math.mulDiv(effective, oldEth, oldVoid + effective);
        if (ethOut < minEthOut) revert Slippage(ethOut, minEthOut);
        _accumulate(oldVoid, oldEth);
        _setReserves(voidToken.balanceOf(address(this)), oldEth - ethOut);
        (bool ok,) = payable(msg.sender).call{value: ethOut}("");
        if (!ok) revert EthTransferFailed();
        emit SwapVoidForEth(msg.sender, voidIn, ethOut);
    }

    /// @notice ETH -> VOID onboarding path. It is intentionally outside the
    /// chain-app flow: acquiring the gas token is the one economic entry point.
    function swapEthForVoid(uint256 minVoidOut)
        external
        payable
        nonReentrant
        returns (uint256 voidOut)
    {
        uint256 oldVoid = reserveVoid;
        uint256 oldEth = reserveEth;
        if (msg.value == 0 || oldVoid == 0 || oldEth == 0) revert InsufficientLiquidity();
        uint256 effective = (msg.value * (BPS - SWAP_FEE_BPS)) / BPS;
        voidOut = Math.mulDiv(effective, oldVoid, oldEth + effective);
        if (voidOut < minVoidOut) revert Slippage(voidOut, minVoidOut);
        _accumulate(oldVoid, oldEth);
        _setReserves(oldVoid - voidOut, oldEth + msg.value);
        if (!voidToken.transfer(msg.sender, voidOut)) revert TokenTransferFailed();
        emit SwapEthForVoid(msg.sender, msg.value, voidOut);
    }

    function currentVoidPerEth() public view returns (uint256) {
        if (reserveVoid == 0 || reserveEth == 0) return 0;
        return Math.mulDiv(reserveVoid, 1e18, reserveEth);
    }

    function observe() external view returns (uint256 cumulative, uint32 timestamp) {
        cumulative = voidPerEthCumulative;
        timestamp = uint32(block.timestamp);
        if (reserveVoid != 0 && reserveEth != 0 && timestamp > lastTimestamp) {
            cumulative += currentVoidPerEth() * (timestamp - lastTimestamp);
        }
    }

    function _accumulate(uint256 voidReserve, uint256 ethReserve) private {
        uint32 nowTs = uint32(block.timestamp);
        if (voidReserve != 0 && ethReserve != 0 && nowTs > lastTimestamp) {
            uint256 price = Math.mulDiv(voidReserve, 1e18, ethReserve);
            voidPerEthCumulative += price * (nowTs - lastTimestamp);
        }
        lastTimestamp = nowTs;
    }

    function _setReserves(uint256 voidReserve, uint256 ethReserve) private {
        reserveVoid = uint112(voidReserve);
        reserveEth = uint112(ethReserve);
        emit Sync(reserveVoid, reserveEth, voidPerEthCumulative);
    }
}
