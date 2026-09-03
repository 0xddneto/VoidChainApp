// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {
    VoidChainAppRuntime,
    IVoidChainDeed,
    IERC20,
    IVoidChainTreasury
} from "./VoidChainAppRuntime.sol";

/// @title VoidChainAppRuntimeV3
/// @notice The mandatory VOID-only execution runtime for newly published chains.
///
/// @dev The V2 runtime proved the sponsored route, but retained direct user
/// execution for backwards compatibility. That makes it possible for an
/// interface written incorrectly to ask a user for parent-chain ETH. V3 leaves
/// the selector in the ABI only to produce an explicit, stable revert; it can
/// never execute. Every successful app action must enter via the frozen
/// Paymaster forwarder and therefore carries the user's bounded EIP-712
/// signature and VOID charge.
contract VoidChainAppRuntimeV3 is VoidChainAppRuntime {
    error DirectExecutionDisabled();
    error DirectAppRegistrationDisabled();
    error NotAppFactory(address caller);
    error AppFactoryAlreadySet(address current);

    /// @notice The sole publisher of V3 application gateways. Written once.
    address public appFactory;

    event AppFactorySet(address indexed factory);
    event FactoryAppPublished(uint256 indexed tokenId, address indexed app, address indexed publisher);

    constructor(IVoidChainDeed deed_, IERC20 voidToken_, IVoidChainTreasury treasury_)
        VoidChainAppRuntime(deed_, voidToken_, treasury_)
    {}

    /// @notice Disabled permanently. Use VoidPaymaster sponsored execution.
    function execute(uint256, address, bytes calldata, uint256)
        external
        pure
        override
        returns (bytes memory)
    {
        revert DirectExecutionDisabled();
    }

    /// @notice Disabled permanently. User token budgets are signature-only.
    function executeWithBudget(uint256, address, bytes calldata, uint256, SpendAuth calldata)
        external
        pure
        override
        returns (bytes memory)
    {
        revert DirectExecutionDisabled();
    }

    /// @notice Sets the gateway factory once, before builders can publish.
    function setAppFactoryOnce(address factory) external {
        if (msg.sender != deployer) revert NotTheDeployer(msg.sender);
        if (appFactory != address(0)) revert AppFactoryAlreadySet(appFactory);
        if (factory == address(0)) revert ZeroAddress();
        appFactory = factory;
        emit AppFactorySet(factory);
    }

    /// @notice Direct registration is permanently disabled in V3.
    function registerApp(uint256, address) public pure override {
        revert DirectAppRegistrationDisabled();
    }

    /// @notice Registers a gateway made by the immutable V3 application factory.
    /// @dev `super.registerApp` keeps the original runtime's tenant checks;
    ///      replacing the publisher afterward preserves the builder's right to
    ///      remove their own app.
    function registerFromFactory(uint256 tokenId, address app, address publisher) external {
        if (msg.sender != appFactory) revert NotAppFactory(msg.sender);
        if (publisher == address(0)) revert ZeroAddress();
        super.registerApp(tokenId, app);
        publisherOf[tokenId][app] = publisher;
        emit FactoryAppPublished(tokenId, app, publisher);
    }
}
