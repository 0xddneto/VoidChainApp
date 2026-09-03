// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ChainAppBase, IVoidChainAppRuntime} from "./ChainAppBase.sol";

interface ITestAsset {
    function mint(uint256 amount) external;
    function transfer(address to, uint256 amount) external returns (bool);
}

/// @notice Test-asset dispenser that is itself a paid VOID Chain application.
/// @dev VOID must come from the public test faucet first. Claiming the two
///      non-VOID assets then goes through the runtime and pays the chain fee,
///      making the wallet flow and explorer accounting unambiguous.
contract VoidDexTestFaucet is ChainAppBase {
    ITestAsset public immutable testUsd;
    ITestAsset public immutable testLink;
    uint256 public immutable amountPerClaim;

    error TransferFailed();

    constructor(IVoidChainAppRuntime runtime_, uint256 chainId_, ITestAsset usd_, ITestAsset link_, uint256 amount_)
        ChainAppBase(runtime_, chainId_)
    {
        if (address(usd_) == address(0) || address(link_) == address(0) || amount_ == 0) revert ZeroAddress();
        testUsd = usd_;
        testLink = link_;
        amountPerClaim = amount_;
    }

    function claim() external onlyFromMyChain {
        address recipient = caller();
        testUsd.mint(amountPerClaim);
        testLink.mint(amountPerClaim);
        if (!testUsd.transfer(recipient, amountPerClaim) || !testLink.transfer(recipient, amountPerClaim)) {
            revert TransferFailed();
        }
    }
}
