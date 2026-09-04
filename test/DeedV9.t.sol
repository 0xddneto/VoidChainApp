// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {VoidChainDeed} from "../contracts/parent/VoidChainDeed.sol";

contract DeedV9Test is Test {
    uint256 private constant OWNER_KEY = 0xA11CE;
    address private owner;
    VoidChainDeed private deed;

    function setUp() public {
        owner = vm.addr(OWNER_KEY);
        deed = new VoidChainDeed(46_630_000, address(this), address(this), 500);
        deed.mint(owner, 1);
    }

    function test_ERC4494InterfaceAndDomainArePublic() public view {
        assertTrue(deed.supportsInterface(0x5604e225));
        assertTrue(deed.DOMAIN_SEPARATOR() != bytes32(0));
    }

    function test_PermitUsesBytesSignature() public {
        address spender = address(0xBEEF);
        uint256 deadline = block.timestamp + 1 days;
        bytes memory signature = _signPermit(spender, 1, deed.nonces(1), deadline);
        deed.permit(spender, 1, deadline, signature);
        assertEq(deed.getApproved(1), spender);
        assertEq(deed.nonces(1), 1);
    }

    function test_TransferInvalidatesOldPermitEvenAfterTokenReturns() public {
        address spender = address(0xBEEF);
        address temporaryOwner = address(0xCAFE);
        uint256 deadline = block.timestamp + 1 days;
        bytes memory oldSignature = _signPermit(spender, 1, deed.nonces(1), deadline);

        vm.prank(owner);
        deed.transferFrom(owner, temporaryOwner, 1);
        vm.prank(temporaryOwner);
        deed.transferFrom(temporaryOwner, owner, 1);

        assertEq(deed.nonces(1), 2);
        vm.expectRevert();
        deed.permit(spender, 1, deadline, oldSignature);
    }

    function test_MetadataLivesOnTheDeed() public {
        string[] memory socials = new string[](2);
        socials[0] = "https://x.com/void";
        socials[1] = "https://discord.gg/void";
        vm.prank(owner);
        deed.rename(1, "VOID Alpha");
        vm.prank(owner);
        deed.setIdentity(1, "A chainapp", "ipfs://image", "https://void.example", socials);
        string memory uri = deed.tokenURI(1);
        assertTrue(bytes(uri).length > 100);
    }

    function _signPermit(address spender, uint256 tokenId, uint256 nonce, uint256 deadline)
        private
        view
        returns (bytes memory)
    {
        bytes32 structHash = keccak256(
            abi.encode(deed.PERMIT_TYPEHASH(), spender, tokenId, nonce, deadline)
        );
        bytes32 digest = keccak256(
            abi.encodePacked("\x19\x01", deed.DOMAIN_SEPARATOR(), structHash)
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(OWNER_KEY, digest);
        return abi.encodePacked(r, s, v);
    }
}
