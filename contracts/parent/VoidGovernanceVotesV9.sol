// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

interface IVoidHistoricalVotesV9 {
    function getPastVotes(address account, uint256 blockNumber) external view returns (uint256);
    function getPastTotalSupply(uint256 blockNumber) external view returns (uint256);
}

/// @title VoidGovernanceVotesV9
/// @notice Immutable voting-supply adapter for every per-Deed DAO.
/// @dev Voting power remains the VOID held in a wallet. Only protocol reserves
///      that cannot participate in voting are removed from the quorum denominator.
///      The exclusion list is constructor-fixed so governance cannot lower quorum
///      immediately before a vote. DAOs can keep their familiar 10% quorum while
///      measuring 10% of eligible circulation instead of 10% of the billion-token
///      genesis supply.
contract VoidGovernanceVotesV9 {
    IVoidHistoricalVotesV9 public immutable token;
    address[] private _excluded;

    error ZeroAddress();
    error DuplicateExcluded(address account);
    error ExcludedSupplyExceedsTotal(uint256 excluded, uint256 total);

    constructor(IVoidHistoricalVotesV9 token_, address[] memory excluded_) {
        if (address(token_) == address(0)) revert ZeroAddress();
        token = token_;
        for (uint256 i; i < excluded_.length; ++i) {
            address account = excluded_[i];
            if (account == address(0)) revert ZeroAddress();
            for (uint256 j; j < i; ++j) {
                if (excluded_[j] == account) revert DuplicateExcluded(account);
            }
            _excluded.push(account);
        }
    }

    function excludedAccounts() external view returns (address[] memory) {
        return _excluded;
    }

    function getPastVotes(address account, uint256 blockNumber) external view returns (uint256) {
        return token.getPastVotes(account, blockNumber);
    }

    function getPastTotalSupply(uint256 blockNumber) external view returns (uint256 eligible) {
        eligible = token.getPastTotalSupply(blockNumber);
        uint256 excludedSupply;
        for (uint256 i; i < _excluded.length; ++i) {
            excludedSupply += token.getPastVotes(_excluded[i], blockNumber);
        }
        if (excludedSupply > eligible) revert ExcludedSupplyExceedsTotal(excludedSupply, eligible);
        eligible -= excludedSupply;
    }
}
