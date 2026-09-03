// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title VoidPermanentLpLockV6
/// @notice Marker address that permanently owns the genesis pool shares.
/// @dev The paired pool has no redeem route at all. This contract has no
/// privileged function and no recovery path, making the genesis LP permanent.
contract VoidPermanentLpLockV6 {}
