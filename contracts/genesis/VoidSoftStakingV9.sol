// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {ChainAppBase, IVoidChainAppRuntime} from "../apps/ChainAppBase.sol";

interface IVoidBurnableV9 {
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
    function burn(uint256 amount) external;
}

interface IVoidStakeDeedV9 {
    function ownerOf(uint256 tokenId) external view returns (address);
    function ownershipEpoch(uint256 tokenId) external view returns (uint256);
}

/// @title VOID Deed Soft Staking
/// @notice Anvil-style soft staking: the Deed never leaves its wallet. A tier
///         burns 95% of its activation cost and sends 5% to protocol treasury.
///         NFT-AMM fees are streamed to active positions over 30 days.
contract VoidSoftStakingV9 is ChainAppBase, ReentrancyGuard {
    uint256 public constant VOID_PER_DEED = 500_000 ether;
    uint256 public constant BPS = 10_000;
    uint256 public constant REWARD_DURATION = 30 days;
    uint256 private constant ACC = 1e27;

    struct Position {
        address owner;
        uint64 ownershipEpoch;
        uint32 weightBps;
        uint256 rewardPerWeightPaid;
        uint256 rewards;
    }

    IVoidBurnableV9 public immutable voidToken;
    IVoidStakeDeedV9 public immutable deed;
    address public immutable protocolTreasury;

    uint256 public totalWeight;
    uint256 public rewardRate;
    uint256 public periodFinish;
    uint256 public lastUpdateTime;
    uint256 public rewardPerWeightStored;
    uint256 public queuedRewards;
    uint256 public lifetimeRewardsReceived;
    uint256 public lifetimeRewardsPaid;
    mapping(uint256 deedId => Position) public positions;

    event Activated(uint256 indexed deedId, address indexed owner, uint8 tier, uint256 cost, uint256 burned);
    event Invalidated(uint256 indexed deedId, address indexed formerOwner);
    event RewardAdded(uint256 amount, uint256 periodFinish);
    event RewardPaid(uint256 indexed deedId, address indexed owner, uint256 amount);

    error InvalidTier(uint8 tier);
    error NotDeedOwner(uint256 deedId, address caller);
    error AlreadyActive(uint256 deedId);
    error PositionStillValid(uint256 deedId);
    error TokenTransferFailed();

    constructor(
        IVoidChainAppRuntime runtime_,
        uint256 chainId_,
        IVoidBurnableV9 voidToken_,
        IVoidStakeDeedV9 deed_,
        address protocolTreasury_
    ) ChainAppBase(runtime_, chainId_) {
        if (
            address(voidToken_) == address(0) || address(deed_) == address(0)
                || protocolTreasury_ == address(0)
        ) {
            revert ZeroAddress();
        }
        voidToken = voidToken_;
        deed = deed_;
        protocolTreasury = protocolTreasury_;
    }

    function activate(uint256 deedId, uint8 tier) external onlyFromMyChain nonReentrant {
        if (deed.ownerOf(deedId) != caller()) revert NotDeedOwner(deedId, caller());
        if (positions[deedId].owner != address(0)) revert AlreadyActive(deedId);
        (uint256 costBps, uint256 weightBps) = tierTerms(tier);
        _updateGlobal();
        uint256 cost = (VOID_PER_DEED * costBps) / BPS;
        spend(address(voidToken), address(this), cost);
        uint256 protocolCut = (cost * 500) / BPS;
        uint256 burned = cost - protocolCut;
        voidToken.burn(burned);
        if (!voidToken.transfer(protocolTreasury, protocolCut)) revert TokenTransferFailed();
        totalWeight += weightBps;
        positions[deedId] = Position({
            owner: caller(),
            ownershipEpoch: uint64(deed.ownershipEpoch(deedId)),
            weightBps: uint32(weightBps),
            rewardPerWeightPaid: rewardPerWeightStored,
            rewards: 0
        });
        if (queuedRewards != 0 && rewardRate == 0) _startStream(queuedRewards);
        emit Activated(deedId, caller(), tier, cost, burned);
    }

    /// @notice Anyone can invalidate a transferred Deed. Unclaimed rewards are
    ///         returned to the next 30-day stream instead of following the NFT.
    function invalidate(uint256 deedId) external onlyFromMyChain nonReentrant {
        Position storage position = positions[deedId];
        if (position.owner == address(0)) revert PositionStillValid(deedId);
        if (
            deed.ownerOf(deedId) == position.owner
                && deed.ownershipEpoch(deedId) == position.ownershipEpoch
        ) revert PositionStillValid(deedId);
        _updatePosition(deedId);
        address formerOwner = position.owner;
        uint256 forfeited = position.rewards;
        totalWeight -= position.weightBps;
        delete positions[deedId];
        queuedRewards += forfeited;
        emit Invalidated(deedId, formerOwner);
    }

    function claim(uint256 deedId) external onlyFromMyChain nonReentrant returns (uint256 reward) {
        Position storage position = positions[deedId];
        if (
            position.owner != caller() || deed.ownerOf(deedId) != caller()
                || deed.ownershipEpoch(deedId) != position.ownershipEpoch
        ) revert NotDeedOwner(deedId, caller());
        _updatePosition(deedId);
        reward = position.rewards;
        position.rewards = 0;
        lifetimeRewardsPaid += reward;
        if (reward != 0 && !voidToken.transfer(caller(), reward)) revert TokenTransferFailed();
        emit RewardPaid(deedId, caller(), reward);
    }

    /// @notice Starts a stream for every new VOID received by this gateway.
    /// @dev Permissionless inside the ChainApp. Donation cannot steal or redirect
    ///      rewards, and no cross-app callback is needed during an AMM trade.
    function syncRewards() external onlyFromMyChain nonReentrant returns (uint256 amount) {
        uint256 received = voidToken.balanceOf(address(this)) + lifetimeRewardsPaid;
        amount = received - lifetimeRewardsReceived;
        lifetimeRewardsReceived = received;
        _updateGlobal();
        uint256 remaining = block.timestamp < periodFinish
            ? (periodFinish - block.timestamp) * rewardRate
            : 0;
        uint256 distributable = amount + remaining + queuedRewards;
        queuedRewards = 0;
        if (totalWeight == 0) {
            queuedRewards = distributable;
            rewardRate = 0;
            periodFinish = block.timestamp;
        } else {
            _startStream(distributable);
        }
        emit RewardAdded(amount, periodFinish);
    }

    function earned(uint256 deedId) external view returns (uint256) {
        Position storage position = positions[deedId];
        return position.rewards
            + (uint256(position.weightBps) * (_rewardPerWeight() - position.rewardPerWeightPaid)) / ACC;
    }

    function tierTerms(uint8 tier) public pure returns (uint256 costBps, uint256 weightBps) {
        if (tier == 1) return (1_000, 10_000);
        if (tier == 2) return (2_200, 12_500);
        if (tier == 3) return (4_500, 16_000);
        if (tier == 4) return (9_000, 20_000);
        if (tier == 5) return (24_000, 33_300);
        revert InvalidTier(tier);
    }

    function _updatePosition(uint256 deedId) private {
        _updateGlobal();
        Position storage position = positions[deedId];
        position.rewards +=
            (uint256(position.weightBps) * (rewardPerWeightStored - position.rewardPerWeightPaid)) / ACC;
        position.rewardPerWeightPaid = rewardPerWeightStored;
    }

    function _updateGlobal() private {
        rewardPerWeightStored = _rewardPerWeight();
        lastUpdateTime = _lastApplicableTime();
    }

    function _rewardPerWeight() private view returns (uint256) {
        if (totalWeight == 0) return rewardPerWeightStored;
        return rewardPerWeightStored
            + ((_lastApplicableTime() - lastUpdateTime) * rewardRate * ACC) / totalWeight;
    }

    function _lastApplicableTime() private view returns (uint256) {
        return block.timestamp < periodFinish ? block.timestamp : periodFinish;
    }

    function _startStream(uint256 amount) private {
        queuedRewards = amount % REWARD_DURATION;
        rewardRate = amount / REWARD_DURATION;
        lastUpdateTime = block.timestamp;
        periodFinish = block.timestamp + REWARD_DURATION;
    }
}
