// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {ERC721Enumerable} from "@openzeppelin/contracts/token/ERC721/extensions/ERC721Enumerable.sol";
import {ERC2981} from "@openzeppelin/contracts/token/common/ERC2981.sol";
import {IERC4906} from "@openzeppelin/contracts/interfaces/IERC4906.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";
import {Base64} from "@openzeppelin/contracts/utils/Base64.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";

/// @dev ERC-4494 is intentionally declared locally because OpenZeppelin 5.1
///      does not ship the interface. Its ERC-165 id is 0x5604e225.
interface IERC4494 is IERC165 {
    function permit(address spender, uint256 tokenId, uint256 deadline, bytes calldata sig) external;
    function nonces(uint256 tokenId) external view returns (uint256);
    function DOMAIN_SEPARATOR() external view returns (bytes32);
}

/// @title VoidChainDeed
/// @notice Title of ownership over one isolated Void ChainApp execution space.
/// @dev    The deed carries NO execution authority of its own. It is a pure
///         ownership record; every privileged action is performed by
///         `VoidChainController`, which reads `ownerOf` at call time. This split is
///         deliberate: transferring the deed on any marketplace transfers the
///         chain instantly, with no migration step and no cooperation from the
///         seller, because authority is never stored -- only derived.
///
///         Immutable per token (fixed at collection genesis, never editable):
///           - tokenId
///           - runtime ID
///         Mutable by the deed holder (identity only, never consensus):
///           - display name, description, artwork, social profiles
contract VoidChainDeed is ERC721Enumerable, ERC2981, IERC4906, IERC4494, EIP712 {
    using Strings for uint256;

    /// @notice Total chains. Fixed forever; there is no mint function after genesis.
    uint256 public constant MAX_SUPPLY = 1111;

    /// @notice First protocol runtime ID in the deterministic contiguous block.
    /// @dev This is not an EIP-155 network chain ID. A Deed becomes an independent
    ///      L3 only after its holder explicitly provisions and migrates to one.
    uint256 public immutable CHAIN_ID_BASE;

    /// @notice Per-chain mutable identity. Never touched by consensus.
    struct Identity {
        string name;
        string description;
        string imageURI;
        string externalURL;
        string[] socials;
    }

    mapping(uint256 tokenId => Identity) private _identity;

    /// @notice ERC-4494-style approval nonces, one per Deed.
    /// @dev The original collection was deployed before this existed. This is
    /// the V5 relaunch path: an owner can authorize the Runtime to move one
    /// exact Deed by signature, so listing it never requires an ETH approval.
    mapping(uint256 tokenId => uint256) public nonces;

    /// @notice Changes only when ownership changes. Governance uses this to
    ///         invalidate proposals created by a seller before a Deed transfer.
    mapping(uint256 tokenId => uint256) public ownershipEpoch;

    bytes32 public constant PERMIT_TYPEHASH = keccak256(
        "Permit(address spender,uint256 tokenId,uint256 nonce,uint256 deadline)"
    );

    /// @notice Names already taken, lowercased, to block impersonation of other
    ///         networks ("Arbitrum One", "Base", ...) and of sibling chains.
    mapping(bytes32 lowercasedName => uint256 tokenId) public nameClaimedBy;


    event VoidChainRenamed(uint256 indexed tokenId, string previousName, string newName);
    event IdentityUpdated(uint256 indexed tokenId);

    error NotDeedHolder(uint256 tokenId, address caller);
    error NameTaken(string name);
    error NameEmpty();
    error NameTooLong();
    error NameHasInvalidChars();
    error TooManySocials();
    error IdentityFieldTooLong();
    error InvalidIdentityCharacter();
    error ZeroAddress();

    /// @notice Who may mint, until minting is sealed forever.
    address public minter;

    /// @notice Once sealed, no issuance ever exists again.
    /// @dev    The supply of 1,111 is only a promise while somebody can still
    ///         mint the 1,112nd. `sealMinting` turns the promise into a
    ///         verifiable fact, and is irreversible on purpose.
    bool public mintingSealed;

    event Minted(uint256 indexed tokenId, address indexed to, uint256 runtimeId);
    event MintingSealed(uint256 totalMinted);
    event MinterTransferred(address previous, address next);

    error NotMinter(address caller);
    error MintingIsSealed();
    error TokenIdOutOfRange(uint256 tokenId);
    error PermitExpired(uint256 deadline);
    error InvalidPermitSigner(address signer, address owner);

    constructor(uint256 chainIdBase, address minter_, address royaltyReceiver, uint96 royaltyBps)
        ERC721("VOIDS Chain Deed", "VOIDS")
        EIP712("VOIDS Chain Deed", "1")
    {
        if (minter_ == address(0) || royaltyReceiver == address(0)) revert ZeroAddress();
        CHAIN_ID_BASE = chainIdBase;
        minter = minter_;
        _setDefaultRoyalty(royaltyReceiver, royaltyBps);
    }

    // ---------------------------------------------------------------------
    // Cunhagem
    // ---------------------------------------------------------------------

    /// @notice Mints a deed. The tokenId picks the chain, so it is explicit
    ///         rather than sequential — the buyer of #417 receives chain #417,
    ///         not the next one in line.
    function mint(address to, uint256 tokenId) public {
        if (msg.sender != minter) revert NotMinter(msg.sender);
        if (mintingSealed) revert MintingIsSealed();
        if (tokenId == 0 || tokenId > MAX_SUPPLY) revert TokenIdOutOfRange(tokenId);

        _safeMint(to, tokenId);
        emit Minted(tokenId, to, CHAIN_ID_BASE + tokenId - 1);
    }

    /// @notice Mints several at once, for the collection launch.
    function mintBatch(address to, uint256[] calldata tokenIds) external {
        for (uint256 i; i < tokenIds.length; ++i) {
            mint(to, tokenIds[i]);
        }
    }

    /// @notice Seals minting forever.
    /// @dev    No way back. After this, `totalSupply()` is the final number and
    ///         anyone can verify there is no way to issue more.
    function sealMinting() external {
        if (msg.sender != minter) revert NotMinter(msg.sender);
        if (mintingSealed) revert MintingIsSealed();
        mintingSealed = true;
        emit MintingSealed(totalSupply());
    }

    function transferMinter(address next) external {
        if (msg.sender != minter) revert NotMinter(msg.sender);
        if (next == address(0)) revert ZeroAddress();
        emit MinterTransferred(minter, next);
        minter = next;
    }

    // ---------------------------------------------------------------------
    // Signature approval
    // ---------------------------------------------------------------------

    /// @notice Approves `spender` for one Deed with an EIP-712 signature.
    /// @dev Compatible with ERC-4494 callers. The approval has the normal
    /// ERC-721 lifetime, but Void's Runtime uses it only within the signed
    /// sponsored request that carries this NFT id. It removes the ETH approval
    /// transaction from a marketplace listing without granting an unlimited
    /// collection-wide operator.
    function permit(address spender, uint256 tokenId, uint256 deadline, bytes calldata sig) external {
        if (block.timestamp > deadline) revert PermitExpired(deadline);
        address owner = ownerOf(tokenId);
        uint256 nonce = nonces[tokenId]++;
        bytes32 structHash = keccak256(
            abi.encode(PERMIT_TYPEHASH, spender, tokenId, nonce, deadline)
        );
        bytes32 digest = _hashTypedDataV4(structHash);
        if (!SignatureChecker.isValidSignatureNow(owner, digest, sig)) {
            revert InvalidPermitSigner(address(0), owner);
        }
        _approve(spender, tokenId, owner);
    }

    /// @notice ERC-4494 domain separator used by wallets and marketplaces.
    function DOMAIN_SEPARATOR() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    // ---------------------------------------------------------------------
    // Identity: the only thing a deed holder may change here
    // ---------------------------------------------------------------------

    /// @notice Renames a chain. The chain ID is untouched -- only the label is.
    /// @dev    Emits ERC-4906 `MetadataUpdate` so marketplaces refresh the item.
    ///         Wallets that already added the network keep showing the old name;
    ///         that is a wallet cache limitation, not a contract one, and the
    ///         portal detects it and offers a re-add.
    function rename(uint256 tokenId, string calldata newName) external {
        _requireDeedHolder(tokenId);

        bytes memory raw = bytes(newName);
        if (raw.length == 0) revert NameEmpty();
        if (raw.length > 32) revert NameTooLong();
        _requireCleanName(raw);

        bytes32 key = _nameKey(newName);
        uint256 heldBy = nameClaimedBy[key];
        if (heldBy != 0 && heldBy != tokenId) revert NameTaken(newName);

        Identity storage id = _identity[tokenId];
        string memory previous = id.name;

        if (bytes(previous).length != 0) delete nameClaimedBy[_nameKey(previous)];
        nameClaimedBy[key] = tokenId;
        id.name = newName;
        emit VoidChainRenamed(tokenId, previous, newName);
        emit MetadataUpdate(tokenId);
    }

    /// @notice Updates the cosmetic fields of a chain.
    function setIdentity(
        uint256 tokenId,
        string calldata description,
        string calldata imageURI,
        string calldata externalURL,
        string[] calldata socials
    ) external {
        _requireDeedHolder(tokenId);
        if (socials.length > 8) revert TooManySocials();
        if (bytes(description).length > 1_024 || bytes(imageURI).length > 512 || bytes(externalURL).length > 512) {
            revert IdentityFieldTooLong();
        }
        for (uint256 i; i < socials.length; ++i) {
            if (bytes(socials[i]).length > 256) revert IdentityFieldTooLong();
        }

        Identity storage id = _identity[tokenId];
        id.description = description;
        id.imageURI = imageURI;
        id.externalURL = externalURL;

        // `id.socials = socials` does not compile: copying a string array from
        // calldata straight into storage is a nested copy the default code
        // generator does not implement. Copying element by element solves it
        // without needing the via-IR generator, which would double the whole
        // project's compile time for the sake of one cosmetic field.
        delete id.socials;
        for (uint256 i; i < socials.length; ++i) {
            id.socials.push(socials[i]);
        }

        emit IdentityUpdated(tokenId);
        emit MetadataUpdate(tokenId);
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    /// @notice Legacy alias for the deterministic Runtime ID.
    function chainIdOf(uint256 tokenId) public view returns (uint256) {
        _requireOwned(tokenId);
        return CHAIN_ID_BASE + tokenId - 1;
    }

    function identityOf(uint256 tokenId) external view returns (Identity memory) {
        _requireOwned(tokenId);
        return _identity[tokenId];
    }

    function runtimeIdOf(uint256 tokenId) external view returns (uint256) {
        return chainIdOf(tokenId);
    }

    /// @notice Standard ERC-721 metadata. It remains available without a
    ///         centralized API, while holder edits are reflected immediately.
    // JSON rendering, not a hash/signature preimage. Holder strings are escaped
    // and separated by literal JSON field delimiters.
    // slither-disable-next-line encode-packed-collision
    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        _requireOwned(tokenId);
        Identity storage id = _identity[tokenId];
        string memory displayName = bytes(id.name).length == 0
            ? string.concat("VOID Chain #", tokenId.toString())
            : id.name;
        string memory description = bytes(id.description).length == 0
            ? "A programmable execution-space Deed in the VoidChainApp protocol."
            : id.description;
        bytes memory json = abi.encodePacked(
            '{"name":"', _escapeJson(displayName),
            '","description":"', _escapeJson(description), '"',
            bytes(id.imageURI).length == 0 ? "" : string.concat(',"image":"', _escapeJson(id.imageURI), '"'),
            bytes(id.externalURL).length == 0 ? "" : string.concat(',"external_url":"', _escapeJson(id.externalURL), '"'),
            ',"attributes":[{"trait_type":"Deed","value":"', tokenId.toString(),
            '"},{"trait_type":"Runtime ID","value":"', chainIdOf(tokenId).toString(), '"}]}'
        );
        return string.concat("data:application/json;base64,", Base64.encode(json));
    }

    /// @dev Escapes holder-controlled strings before embedding them in JSON.
    function _escapeJson(string memory value) private pure returns (string memory) {
        bytes memory input = bytes(value);
        bytes memory output = new bytes(input.length * 2);
        uint256 length;
        for (uint256 i; i < input.length; ++i) {
            bytes1 char = input[i];
            if (char == 0x22 || char == 0x5c) {
                output[length++] = 0x5c;
                output[length++] = char;
            } else if (char == 0x0a || char == 0x0d || char == 0x09) {
                output[length++] = 0x5c;
                output[length++] = char == 0x0a ? bytes1("n") : char == 0x0d ? bytes1("r") : bytes1("t");
            } else {
                if (uint8(char) < 0x20) revert InvalidIdentityCharacter();
                output[length++] = char;
            }
        }
        assembly ("memory-safe") { mstore(output, length) }
        return string(output);
    }

    /// @dev ERC-4494 requires invalidating every outstanding permit whenever
    ///      ownership changes, including the sell-and-buy-back replay case.
    function _update(address to, uint256 tokenId, address auth)
        internal
        override(ERC721Enumerable)
        returns (address from)
    {
        from = super._update(to, tokenId, auth);
        if (from != address(0)) {
            ++nonces[tokenId];
            ++ownershipEpoch[tokenId];
        }
    }

    /// @notice Only lets through names in a single, safe alphabet.
    ///
    /// @dev    THIS CLOSES HOMOGLYPH SPOOFING, found in red-team.
    ///
    ///         The anti-squatting protection compares normalized names, but only
    ///         understood ASCII. Unicode has letters from other alphabets
    ///         identical to Latin ones on screen — Cyrillic "a" and Latin "a" are
    ///         visual twins but different bytes. Without this guard, a chain
    ///         would register as "Arbitrum One" with a Cyrillic A without
    ///         colliding with the real one, and nobody could tell by looking.
    ///
    ///         The defense is to allow ONE alphabet only: a-z, A-Z, 0-9, space,
    ///         hyphen, period and underscore. With a single alphabet there is
    ///         exactly one "a", and the disguise stops being possible. As a
    ///         bonus, it blocks control characters, invisible ones (zero-width
    ///         space) and text-direction marks, which are other vectors of the
    ///         same phishing.
    ///
    ///         A leading or trailing space, and double spaces, are also refused:
    ///         "Nova  Atlantis" and "Nova Atlantis " look the same and would fool
    ///         the same comparison.
    function _requireCleanName(bytes memory b) internal pure {
        for (uint256 i; i < b.length; ++i) {
            uint8 c = uint8(b[i]);
            bool ok = (c >= 0x30 && c <= 0x39) // 0-9
                || (c >= 0x41 && c <= 0x5A) // A-Z
                || (c >= 0x61 && c <= 0x7A) // a-z
                || c == 0x20 // space
                || c == 0x2D // hyphen
                || c == 0x2E // ponto
                || c == 0x5F; // sublinhado
            if (!ok) revert NameHasInvalidChars();

            // A leading/trailing space, or two in a row: refused.
            if (c == 0x20) {
                if (i == 0 || i == b.length - 1) revert NameHasInvalidChars();
                if (uint8(b[i - 1]) == 0x20) revert NameHasInvalidChars();
            }
        }
    }

    /// @dev Case-insensitive over ASCII. Names are capped at 32 bytes, so the
    ///      loop is bounded and cheap. Only names already validated by
    ///      `_requireCleanName` reach here, so there is no non-ASCII byte to
    ///      consider.
    function _nameKey(string memory name) internal pure returns (bytes32) {
        bytes memory b = bytes(name);
        for (uint256 i; i < b.length; ++i) {
            uint8 c = uint8(b[i]);
            if (c >= 0x41 && c <= 0x5A) b[i] = bytes1(c + 32);
        }
        return keccak256(b);
    }

    function _requireDeedHolder(uint256 tokenId) internal view {
        if (_ownerOf(tokenId) != msg.sender) revert NotDeedHolder(tokenId, msg.sender);
    }

    /// @dev ERC721Enumerable and ERC2981 are the two concrete implementations
    ///      that contribute ERC-165 support. IERC4494 is reported explicitly.
    function supportsInterface(bytes4 interfaceId)
        public
        view
        override(ERC721Enumerable, ERC2981, IERC165)
        returns (bool)
    {
        return interfaceId == bytes4(0x49064906) // ERC-4906
            || interfaceId == type(IERC4494).interfaceId
            || super.supportsInterface(interfaceId);
    }
}
