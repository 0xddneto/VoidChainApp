// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

interface IVoidClaimRuntimeV11 {
    function flush(uint256 tokenId) external;
    function claimOwed(address beneficiary) external returns (uint256);
    function apps(uint256 tokenId) external view returns (
        bool active,
        uint256 feePerCallUsd,
        bool permissionlessDeploy,
        uint256 pending,
        address pendingOwner,
        uint256 lifetimeRevenue,
        uint256 callCount
    );
    function owed(address beneficiary) external view returns (uint256);
}

interface IVoidClaimTreasuryV11 {
    function claimFor(address beneficiary) external;
    function claimable(address beneficiary) external view returns (uint256);
}

interface IVoidClaimDeedV11 {
    function ownerOf(uint256 tokenId) external view returns (address);
}

/// @notice One atomic claim path: flush chain revenue, settle Runtime credit,
///         and transfer Treasury credit to the current Deed holder.
contract VoidRevenueClaimerV11 {
    IVoidClaimRuntimeV11 public immutable runtime;
    IVoidClaimTreasuryV11 public immutable treasury;
    IVoidClaimDeedV11 public immutable deed;

    error ZeroAddress();

    constructor(IVoidClaimRuntimeV11 runtime_, IVoidClaimTreasuryV11 treasury_, IVoidClaimDeedV11 deed_) {
        if (address(runtime_) == address(0) || address(treasury_) == address(0) || address(deed_) == address(0)) {
            revert ZeroAddress();
        }
        runtime = runtime_;
        treasury = treasury_;
        deed = deed_;
    }

    function claimAll(uint256 tokenId) external {
        address beneficiary = deed.ownerOf(tokenId);
        (,,, uint256 pending,,,) = runtime.apps(tokenId);
        if (pending != 0) runtime.flush(tokenId);
        if (runtime.owed(beneficiary) != 0) runtime.claimOwed(beneficiary);
        if (treasury.claimable(beneficiary) != 0) treasury.claimFor(beneficiary);
    }
}
