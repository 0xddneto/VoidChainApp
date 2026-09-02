// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Price of 1 VOID expressed in wei of ETH, 18 decimals.
interface IVoidPriceOracle {
    function voidPerEth() external view returns (uint256);
    function lastUpdatedAt() external view returns (uint256);
}

/// @title VoidChainSolvency
/// @notice Keeps chains solvent when the gas token is VOID but the bills are in ETH.
///
/// @dev    THE CURRENCY MISMATCH, AND WHY IT NEEDS ITS OWN CONTRACT
///
///         Users pay gas in VOID. But posting a chain's batches to the parent
///         chain is paid in ETH, and that bill does not care what VOID is worth
///         today. If VOID drops 80%, revenue measured in ETH drops 80% while the
///         cost stays flat -- and all 1111 chains quietly start operating at a
///         loss at the same moment, for the same reason. That is a systemic
///         failure mode, not a per-chain one, so it cannot be left to each deed
///         holder to notice and fix.
///
///         THE FIX: DEED HOLDERS PRICE IN VALUE, NOT IN TOKENS
///
///         A deed holder does not set "0.5 VOID per transaction". They set the
///         ETH-equivalent they want their chain to charge, and this contract
///         converts to VOID at the current rate whenever the fee is pushed down
///         to the chain. The holder keeps full economic sovereignty -- they decide
///         how expensive their chain is in real terms -- while solvency is
///         maintained automatically and identically across every chain.
///
///         Debt is likewise denominated in ETH, never in VOID. Denominating debt
///         in the volatile asset would mean a chain's obligations shrink when VOID
///         rallies and balloon when it falls, which is exactly backwards: the
///         obligation is an ETH bill and should stay one.
contract VoidChainSolvency {
    IVoidPriceOracle public oracle;
    address public governance;

    /// @notice Refuse to price anything from a stale feed. Better to block a fee
    ///         update than to push a price derived from a dead oracle.
    uint256 public constant MAX_ORACLE_AGE = 1 hours;

    /// @notice Guard rails on a single conversion, so an oracle glitch cannot
    ///         translate into an absurd on-chain gas price.
    uint256 public constant MIN_VOID_PER_ETH = 1e15; // 0.001 VOID per ETH
    uint256 public constant MAX_VOID_PER_ETH = 1e30;

    event OracleUpdated(address previous, address next);

    error NotGovernance(address caller);
    error OracleStale(uint256 lastUpdatedAt, uint256 maxAge);
    error PriceOutOfBounds(uint256 price);
    error ZeroAddress();

    constructor(IVoidPriceOracle oracle_, address governance_) {
        if (address(oracle_) == address(0) || governance_ == address(0)) revert ZeroAddress();
        oracle = oracle_;
        governance = governance_;
    }

    /// @notice Converts an ETH-denominated fee target into the VOID amount to
    ///         actually set as the chain's minimum base fee.
    /// @param  ethEquivalentWei What the deed holder wants a unit of gas to be
    ///         worth, expressed in wei of ETH.
    /// @return voidAmount The equivalent amount denominated in VOID.
    function ethToVoid(uint256 ethEquivalentWei) public view returns (uint256 voidAmount) {
        uint256 rate = _freshRate();
        return (ethEquivalentWei * rate) / 1e18;
    }

    /// @notice Converts VOID revenue into the ETH value it settles for, used to
    ///         work out how much of a chain's ETH-denominated debt it just paid.
    function voidToEth(uint256 voidAmount) public view returns (uint256 ethWei) {
        uint256 rate = _freshRate();
        return (voidAmount * 1e18) / rate;
    }

    function _freshRate() internal view returns (uint256 rate) {
        uint256 updatedAt = oracle.lastUpdatedAt();
        if (block.timestamp - updatedAt > MAX_ORACLE_AGE) {
            revert OracleStale(updatedAt, MAX_ORACLE_AGE);
        }

        rate = oracle.voidPerEth();
        if (rate < MIN_VOID_PER_ETH || rate > MAX_VOID_PER_ETH) revert PriceOutOfBounds(rate);
    }

    function setOracle(IVoidPriceOracle next) external {
        if (msg.sender != governance) revert NotGovernance(msg.sender);
        if (address(next) == address(0)) revert ZeroAddress();
        emit OracleUpdated(address(oracle), address(next));
        oracle = next;
    }
}
