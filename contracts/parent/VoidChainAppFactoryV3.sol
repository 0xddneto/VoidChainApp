// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Narrow V3 runtime surface needed by the application factory.
interface IVoidChainAppRuntimeV3Factory {
    function registerFromFactory(uint256 tokenId, address app, address publisher) external;
}

/// @title VoidChainAppGateway
/// @notice The only address registered as a V3 ChainApp.
///
/// @dev Logic runs by delegatecall so its state belongs to this gateway, while
/// `msg.sender` remains the Runtime. Calling a module implementation directly
/// only touches that implementation's isolated storage; it cannot use the
/// registered app's balances or state. State-changing calls to this gateway
/// are accepted only from the Runtime. Read-only calls use `query` below.
contract VoidChainAppGateway {
    address public immutable runtime;
    uint256 public immutable chainId;
    address public immutable implementation;

    error NotRuntime(address caller);
    error InvalidImplementation();
    error InitialisationFailed(bytes reason);
    error QueryFailed(bytes reason);

    constructor(address runtime_, uint256 chainId_, address implementation_, bytes memory initialiseData) {
        if (runtime_ == address(0) || chainId_ == 0 || implementation_.code.length == 0) {
            revert InvalidImplementation();
        }
        runtime = runtime_;
        chainId = chainId_;
        implementation = implementation_;
        if (initialiseData.length != 0) {
            (bool ok, bytes memory reason) = implementation_.delegatecall(initialiseData);
            if (!ok) revert InitialisationFailed(reason);
        }
    }

    fallback() external payable {
        // `address(this)` is only reached by `query`, which uses staticcall.
        // A mutating selector in that path necessarily reverts in the EVM;
        // it can never become a route around the Runtime or Paymaster.
        if (msg.sender != runtime && msg.sender != address(this)) revert NotRuntime(msg.sender);
        address implementation_ = implementation;
        assembly {
            calldatacopy(0, 0, calldatasize())
            let ok := delegatecall(gas(), implementation_, 0, calldatasize(), 0, 0)
            returndatacopy(0, 0, returndatasize())
            switch ok
            case 0 { revert(0, returndatasize()) }
            default { return(0, returndatasize()) }
        }
    }

    /// @notice Executes a view selector against this gateway's state.
    /// @dev Calling self with STATICCALL preserves delegatecall storage layout
    /// while making every attempted write fail. This keeps app state readable
    /// without letting wallets call a chain app outside the Runtime.
    function query(bytes calldata data) external view returns (bytes memory result) {
        (bool ok, bytes memory response) = address(this).staticcall(data);
        if (!ok) revert QueryFailed(response);
        return response;
    }
}

/// @title VoidChainAppFactoryV3
/// @notice Permissionless builder factory for apps that cannot be called outside their Chain.
contract VoidChainAppFactoryV3 {
    IVoidChainAppRuntimeV3Factory public immutable runtime;

    event AppPublished(
        uint256 indexed tokenId,
        address indexed app,
        address indexed publisher,
        address implementation,
        bytes32 salt
    );

    error ZeroAddress();
    error InvalidChainId();
    error InvalidImplementation();

    constructor(IVoidChainAppRuntimeV3Factory runtime_) {
        if (address(runtime_) == address(0)) revert ZeroAddress();
        runtime = runtime_;
    }

    /// @notice Deploys and registers a guarded app gateway in one transaction.
    function publish(uint256 tokenId, address implementation, bytes calldata initialiseData, bytes32 salt)
        external
        returns (address app)
    {
        if (tokenId == 0) revert InvalidChainId();
        if (implementation.code.length == 0) revert InvalidImplementation();
        bytes32 derivedSalt = keccak256(abi.encode(msg.sender, tokenId, implementation, salt));
        app = address(new VoidChainAppGateway{salt: derivedSalt}(
            address(runtime), tokenId, implementation, initialiseData
        ));
        runtime.registerFromFactory(tokenId, app, msg.sender);
        emit AppPublished(tokenId, app, msg.sender, implementation, derivedSalt);
    }

    function predict(
        address publisher,
        uint256 tokenId,
        address implementation,
        bytes calldata initialiseData,
        bytes32 salt
    ) external view returns (address) {
        bytes32 derivedSalt = keccak256(abi.encode(publisher, tokenId, implementation, salt));
        bytes memory creation = abi.encodePacked(
            type(VoidChainAppGateway).creationCode,
            abi.encode(address(runtime), tokenId, implementation, initialiseData)
        );
        bytes32 codeHash = keccak256(creation);
        return address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), derivedSalt, codeHash)))));
    }
}
