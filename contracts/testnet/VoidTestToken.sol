// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title VoidTestToken
/// @notice The TESTNET VOID: an ERC-20 with EIP-2612 and an open tap.
///
/// @dev    THIS DOES NOT GO TO MAINNET. There the token is created by the
///         market's own factory — we do not write the real token, and it
///         already has `permit`.
///
///         This exists because the test VOID we were using does NOT have
///         `permit`, and without `permit` the bubble does not close: someone
///         holding only VOID cannot authorize anyone, because authorizing is a
///         transaction that costs ETH. Without this contract, the real path
///         cannot be tested.
///
///         The tap (`faucet`) is open on purpose: this is a testnet, and the
///         goal is for someone to be able to test without asking anyone for
///         anything.
contract VoidTestToken {
    string public constant name = "VOID";
    string public constant symbol = "VOID";
    uint8 public constant decimals = 18;

    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    mapping(address => uint256) public nonces;

    /// @notice How much the tap hands out per call.
    uint256 public constant FAUCET_AMOUNT = 10_000e18;

    /// @notice Minimum interval between two taps from the same address.
    /// @dev    It is not security — this is a testnet, and anyone wanting to get
    ///         around it just creates wallets. It only keeps the supply from
    ///         becoming noise in the explorer.
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

    function DOMAIN_SEPARATOR() public view returns (bytes32) {
        return keccak256(
            abi.encode(
                keccak256(
                    "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
                ),
                keccak256(bytes(name)),
                keccak256(bytes("1")),
                block.chainid,
                address(this)
            )
        );
    }

    /// @notice Gets VOID for free. This is a testnet.
    function faucet() external returns (uint256) {
        uint256 available = lastFaucet[msg.sender] + FAUCET_COOLDOWN;
        if (lastFaucet[msg.sender] != 0 && block.timestamp < available) {
            revert FaucetTooSoon(available);
        }
        lastFaucet[msg.sender] = block.timestamp;
        _mint(msg.sender, FAUCET_AMOUNT);
        return FAUCET_AMOUNT;
    }

    /// @notice Mints to another address. Open: testnet.
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
        if (allowed != type(uint256).max) {
            allowance[from][msg.sender] = allowed - value;
        }
        _transfer(from, to, value);
        return true;
    }

    /// @notice The permission by signature, without which the bubble does not close.
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
        emit Transfer(address(0), to, amount);
    }

    function _transfer(address from, address to, uint256 value) private {
        balanceOf[from] -= value;
        balanceOf[to] += value;
        emit Transfer(from, to, value);
    }
}
