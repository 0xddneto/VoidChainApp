// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Checkpoints} from "@openzeppelin/contracts/utils/structs/Checkpoints.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

/// @title VoidTestToken
/// @notice TESTNET VOID: permit, an open tap, and wallet-balance voting snapshots.
/// @dev This does not go to mainnet. The production token is created by the
///      market factory and must expose equivalent historical balance snapshots
///      before this DAO model can be used there.
contract VoidTestToken {
    using Checkpoints for Checkpoints.Trace208;
    using SafeCast for uint256;

    string public constant name = "VOID";
    string public constant symbol = "VOID";
    uint8 public constant decimals = 18;

    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    mapping(address => uint256) public nonces;

    Checkpoints.Trace208 private _supplyHistory;
    mapping(address => Checkpoints.Trace208) private _balanceHistory;

    uint256 public constant FAUCET_AMOUNT = 10_000e18;
    uint256 public constant FAUCET_COOLDOWN = 1 hours;
    mapping(address => uint256) public lastFaucet;

    bytes32 public constant PERMIT_TYPEHASH = keccak256(
        "Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"
    );

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    error PermitExpired(uint256 deadline);
    error BadSignature();
    error FaucetTooSoon(uint256 availableAt);
    error SnapshotNotInPast(uint256 blockNumber);

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

    /// @notice Returns this wallet's VOID balance at the end of a completed block.
    function getPastVotes(address account, uint256 blockNumber) external view returns (uint256) {
        if (blockNumber >= block.number) revert SnapshotNotInPast(blockNumber);
        return _balanceHistory[account].upperLookupRecent(blockNumber.toUint48());
    }

    /// @notice Returns total VOID supply at the end of a completed block.
    function getPastTotalSupply(uint256 blockNumber) external view returns (uint256) {
        if (blockNumber >= block.number) revert SnapshotNotInPast(blockNumber);
        return _supplyHistory.upperLookupRecent(blockNumber.toUint48());
    }

    function faucet() external returns (uint256) {
        uint256 available = lastFaucet[msg.sender] + FAUCET_COOLDOWN;
        if (lastFaucet[msg.sender] != 0 && block.timestamp < available) revert FaucetTooSoon(available);
        lastFaucet[msg.sender] = block.timestamp;
        _mint(msg.sender, FAUCET_AMOUNT);
        return FAUCET_AMOUNT;
    }

    function mintTo(address to, uint256 amount) external {
        _mint(to, amount);
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
        if (allowed != type(uint256).max) allowance[from][msg.sender] = allowed - value;
        _transfer(from, to, value);
        return true;
    }

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
        totalSupply += amount;
        balanceOf[to] += amount;
        _writeCheckpoint(to);
        _supplyHistory.push(block.number.toUint48(), totalSupply.toUint208());
        emit Transfer(address(0), to, amount);
    }

    function _transfer(address from, address to, uint256 value) private {
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
