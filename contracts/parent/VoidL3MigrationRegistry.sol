// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

interface IVoidL3Deed {
    function ownerOf(uint256 tokenId) external view returns (address);
}

/// @title VoidL3MigrationRegistry
/// @notice Public, Deed-controlled directory for independently operated L3 migrations.
/// @dev This contract records commitments and endpoints; it cannot prove that a
///      sequencer, bridge, RPC or data-availability layer is safe. Those remain
///      external infrastructure and must be audited independently.
contract VoidL3MigrationRegistry {
    enum Status { None, Planned, Live, Retired }

    struct Migration {
        uint256 eip155ChainId;
        address settlementContract;
        address canonicalBridge;
        bytes32 rpcUriHash;
        bytes32 explorerUriHash;
        bytes32 configHash;
        Status status;
        uint64 updatedAt;
    }

    IVoidL3Deed public immutable deed;
    mapping(uint256 tokenId => Migration) public migrationOf;
    mapping(uint256 eip155ChainId => uint256 tokenId) public deedForChainId;

    event MigrationPlanned(
        uint256 indexed tokenId,
        uint256 indexed eip155ChainId,
        address indexed holder,
        bytes32 configHash
    );
    event MigrationActivated(
        uint256 indexed tokenId,
        uint256 indexed eip155ChainId,
        address settlementContract,
        address canonicalBridge,
        bytes32 rpcUriHash,
        bytes32 explorerUriHash,
        bytes32 configHash
    );
    event MigrationRetired(uint256 indexed tokenId, uint256 indexed eip155ChainId, address indexed holder);

    error ZeroAddress();
    error NotDeedHolder(address caller, uint256 tokenId);
    error InvalidChainId(uint256 chainId);
    error ChainIdAlreadyReserved(uint256 chainId, uint256 tokenId);
    error MigrationNotPlanned(uint256 tokenId);
    error IncompleteLiveConfiguration();

    constructor(IVoidL3Deed deed_) {
        if (address(deed_) == address(0)) revert ZeroAddress();
        deed = deed_;
    }

    modifier onlyHolder(uint256 tokenId) {
        if (deed.ownerOf(tokenId) != msg.sender) revert NotDeedHolder(msg.sender, tokenId);
        _;
    }

    /// @notice Reserves a unique EIP-155 ID and commits the intended L3 config.
    function plan(uint256 tokenId, uint256 eip155ChainId, bytes32 configHash)
        external
        onlyHolder(tokenId)
    {
        if (eip155ChainId == 0 || eip155ChainId == block.chainid) {
            revert InvalidChainId(eip155ChainId);
        }
        uint256 reservedFor = deedForChainId[eip155ChainId];
        if (reservedFor != 0 && reservedFor != tokenId) {
            revert ChainIdAlreadyReserved(eip155ChainId, reservedFor);
        }

        Migration storage current = migrationOf[tokenId];
        if (current.eip155ChainId != 0 && current.eip155ChainId != eip155ChainId
            && deedForChainId[current.eip155ChainId] == tokenId) {
            delete deedForChainId[current.eip155ChainId];
        }
        deedForChainId[eip155ChainId] = tokenId;
        migrationOf[tokenId] = Migration({
            eip155ChainId: eip155ChainId,
            settlementContract: address(0),
            canonicalBridge: address(0),
            rpcUriHash: bytes32(0),
            explorerUriHash: bytes32(0),
            configHash: configHash,
            status: Status.Planned,
            updatedAt: uint64(block.timestamp)
        });
        emit MigrationPlanned(tokenId, eip155ChainId, msg.sender, configHash);
    }

    /// @notice Publishes a holder-attested live deployment after external audit.
    function activate(
        uint256 tokenId,
        address settlementContract,
        address canonicalBridge,
        bytes32 rpcUriHash,
        bytes32 explorerUriHash,
        bytes32 configHash
    ) external onlyHolder(tokenId) {
        Migration storage current = migrationOf[tokenId];
        if (current.status != Status.Planned) revert MigrationNotPlanned(tokenId);
        if (
            settlementContract == address(0) || canonicalBridge == address(0)
                || rpcUriHash == bytes32(0) || explorerUriHash == bytes32(0)
                || configHash == bytes32(0) || configHash != current.configHash
        ) revert IncompleteLiveConfiguration();
        current.settlementContract = settlementContract;
        current.canonicalBridge = canonicalBridge;
        current.rpcUriHash = rpcUriHash;
        current.explorerUriHash = explorerUriHash;
        current.status = Status.Live;
        current.updatedAt = uint64(block.timestamp);
        emit MigrationActivated(
            tokenId,
            current.eip155ChainId,
            settlementContract,
            canonicalBridge,
            rpcUriHash,
            explorerUriHash,
            configHash
        );
    }

    /// @notice Removes the active directory entry and releases its chain ID.
    function retire(uint256 tokenId) external onlyHolder(tokenId) {
        Migration storage current = migrationOf[tokenId];
        uint256 chainId = current.eip155ChainId;
        if (chainId == 0 || current.status == Status.Retired) revert MigrationNotPlanned(tokenId);
        delete deedForChainId[chainId];
        current.status = Status.Retired;
        current.updatedAt = uint64(block.timestamp);
        emit MigrationRetired(tokenId, chainId, msg.sender);
    }
}
