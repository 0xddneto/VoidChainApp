// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Checkpoints} from "@openzeppelin/contracts/utils/structs/Checkpoints.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

/// @title VoidToken
/// @notice Rejected V5 testnet candidate retained only for forensic review.
/// @dev Its one-million-VOID-per-Deed parameter was deployed to testnet before
/// the Anvil reserve model was fully reviewed. It MUST NOT be used for a
/// launch or promotion; see docs/ANVIL_LAUNCH_MODEL.md. A reviewed successor
/// will have a distinct contract name and immutable bucket model.
contract VoidToken {
    using Checkpoints for Checkpoints.Trace208;
    using SafeCast for uint256;

    string public constant name = "VOID";
    string public constant symbol = "VOID";
    uint8 public constant decimals = 18;

    uint256 public constant DEED_SUPPLY = 1111;
    uint256 public constant VOID_PER_DEED = 1_000_000e18;
    uint256 public constant MAX_SUPPLY = DEED_SUPPLY * VOID_PER_DEED;

    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    mapping(address => uint256) public nonces;

    Checkpoints.Trace208 private _supplyHistory;
    mapping(address => Checkpoints.Trace208) private _balanceHistory;

    bytes32 public constant PERMIT_TYPEHASH = keccak256(
        "Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"
    );

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    error ZeroAddress();
    error PermitExpired(uint256 deadline);
    error BadSignature();
    error InsufficientAllowance(uint256 available, uint256 requested);
    error SnapshotNotInPast(uint256 blockNumber);

    /// @param genesisVault Immutable distribution vault. It receives the whole
    /// fixed supply once; the token itself has no post-deployment issuance path.
    constructor(address genesisVault) {
        if (genesisVault == address(0)) revert ZeroAddress();
        _mint(genesisVault, MAX_SUPPLY);
    }

    function DOMAIN_SEPARATOR() public view returns (bytes32) {
        return keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes(name)),
                keccak256(bytes("1")),
                block.chainid,
                address(this)
            )
        );
    }

    /// @notice Historical wallet balance; no locking or delegation is required.
    function getPastVotes(address account, uint256 blockNumber) external view returns (uint256) {
        if (blockNumber >= block.number) revert SnapshotNotInPast(blockNumber);
        return _balanceHistory[account].upperLookupRecent(blockNumber.toUint48());
    }

    function getPastTotalSupply(uint256 blockNumber) external view returns (uint256) {
        if (blockNumber >= block.number) revert SnapshotNotInPast(blockNumber);
        return _supplyHistory.upperLookupRecent(blockNumber.toUint48());
    }

    function approve(address spender, uint256 value) external returns (bool) {
        allowance[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
        return true;
    }

    function transfer(address to, uint256 value) external returns (bool) {
        _transfer(msg.sender, to, value);
        return true;
    }

    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) {
            if (allowed < value) revert InsufficientAllowance(allowed, value);
            allowance[from][msg.sender] = allowed - value;
        }
        _transfer(from, to, value);
        return true;
    }

    /// @notice EIP-2612 permit used by the sponsored VOID path.
    function permit(
        address owner,
        address spender,
        uint256 value,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external {
        if (block.timestamp > deadline) revert PermitExpired(deadline);
        bytes32 structHash = keccak256(
            abi.encode(PERMIT_TYPEHASH, owner, spender, value, nonces[owner]++, deadline)
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR(), structHash));
        address signer = ecrecover(digest, v, r, s);
        if (signer == address(0) || signer != owner) revert BadSignature();
        allowance[owner][spender] = value;
        emit Approval(owner, spender, value);
    }

    function _mint(address to, uint256 amount) private {
        totalSupply = amount;
        balanceOf[to] = amount;
        _writeCheckpoint(to);
        _supplyHistory.push(block.number.toUint48(), amount.toUint208());
        emit Transfer(address(0), to, amount);
    }

    function _transfer(address from, address to, uint256 value) private {
        if (to == address(0)) revert ZeroAddress();
        balanceOf[from] -= value;
        balanceOf[to] += value;
        _writeCheckpoint(from);
        _writeCheckpoint(to);
        emit Transfer(from, to, value);
    }

    function _writeCheckpoint(address account) private {
        _balanceHistory[account].push(block.number.toUint48(), balanceOf[account].toUint208());
    }
}
