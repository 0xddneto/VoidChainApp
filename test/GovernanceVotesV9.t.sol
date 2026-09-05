// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {VoidTestToken} from "../contracts/testnet/VoidTestToken.sol";
import {VoidGovernanceVotesV9, IVoidHistoricalVotesV9} from "../contracts/parent/VoidGovernanceVotesV9.sol";

contract GovernanceVotesV9Test is Test {
    function test_QuorumSupplyExcludesOnlyConstructorFixedReserves() public {
        VoidTestToken token = new VoidTestToken();
        address escrow = address(0xE5C);
        address pool = address(0xB001);
        address alice = address(0xA11CE);
        token.mintTo(escrow, 775_500_000 ether);
        token.mintTo(pool, 222_200_000 ether);
        token.mintTo(alice, 2_300_000 ether);
        vm.roll(block.number + 1);

        address[] memory excluded = new address[](2);
        excluded[0] = escrow;
        excluded[1] = pool;
        VoidGovernanceVotesV9 votes = new VoidGovernanceVotesV9(
            IVoidHistoricalVotesV9(address(token)), excluded
        );

        assertEq(votes.getPastTotalSupply(block.number - 1), 2_300_000 ether);
        assertEq(votes.getPastVotes(alice, block.number - 1), 2_300_000 ether);
        assertEq(votes.getPastVotes(escrow, block.number - 1), 0);
        assertEq(votes.getPastVotes(pool, block.number - 1), 0);
    }

    function test_ExclusionListCannotContainDuplicates() public {
        VoidTestToken token = new VoidTestToken();
        address[] memory excluded = new address[](2);
        excluded[0] = address(1);
        excluded[1] = address(1);
        vm.expectRevert(
            abi.encodeWithSelector(VoidGovernanceVotesV9.DuplicateExcluded.selector, address(1))
        );
        new VoidGovernanceVotesV9(IVoidHistoricalVotesV9(address(token)), excluded);
    }
}
