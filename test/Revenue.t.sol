// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {VoidChainFeeVault} from "../contracts/child/VoidChainFeeVault.sol";
import {
    VoidChainRevenueRouter,
    IVoidChainTreasury,
    IERC20 as IRouterERC20
} from "../contracts/parent/VoidChainRevenueRouter.sol";
import {VoidChainTreasury, IVoidChainDeed, IERC20} from "../contracts/parent/VoidChainTreasury.sol";

contract FakeDeed is IVoidChainDeed {
    mapping(uint256 => address) public owners;

    function setOwner(uint256 tokenId, address owner) external {
        owners[tokenId] = owner;
    }

    function ownerOf(uint256 tokenId) external view returns (address) {
        return owners[tokenId];
    }
}

contract MockVoidToken is IERC20 {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) allowance[from][msg.sender] = allowed - amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

/// @notice A fake ArbSys, planted at 0x64 with `vm.etch`.
/// @dev    Records where and how much was withdrawn, because that is exactly
///         what has to be verified: a vault that withdrew somewhere else would
///         hand the chain revenue to someone who should not have it.
contract MockArbSys {
    address public lastDestination;
    uint256 public lastAmount;
    uint256 public callCount;

    function withdrawEth(address destination) external payable returns (uint256) {
        lastDestination = destination;
        lastAmount = msg.value;
        callCount++;
        return callCount;
    }
}

/**
 * O caminho do dinheiro, de ponta a ponta.
 *
 * A VOID Chain revenue is born as gas paid inside the chain itself and has to
 * reach whoever holds the NFT, who lives on the parent chain. There are four
 * hops, and each one is a chance for the money to be lost or change hands:
 *
 *   gas fee -> VoidChainFeeVault (child) -> bridge -> VoidChainRevenueRouter
 *   (parent) → VoidChainTreasury → saque do detentor
 *
 * What these tests try to break: diverting the money at any of the hops, and
 * crediting one chain's revenue to another's account.
 */
contract RevenueTest is Test {
    VoidChainFeeVault vault;
    VoidChainRevenueRouter router;
    VoidChainTreasury treasury;
    FakeDeed deed;
    MockVoidToken voidToken;
    MockArbSys arbSys;

    address governance = address(0x6009);
    address protocolTreasury = address(0x9001);
    address alice = address(0xA11CE);
    address bob = address(0xB0B);
    address randomPerson = address(0x5A1D);

    uint256 constant TOKEN = 1;
    address constant ARB_SYS_ADDRESS = 0x0000000000000000000000000000000000000064;

    function setUp() public {
        deed = new FakeDeed();
        voidToken = new MockVoidToken();
        treasury = new VoidChainTreasury(
            IVoidChainDeed(address(deed)), IERC20(address(voidToken)), protocolTreasury, governance
        );
        router = new VoidChainRevenueRouter(
            TOKEN, IVoidChainTreasury(address(treasury)), IRouterERC20(address(voidToken))
        );

        // Nitro precompile does not exist on a plain EVM; we plant one there.
        arbSys = new MockArbSys();
        vm.etch(ARB_SYS_ADDRESS, address(arbSys).code);

        vault = new VoidChainFeeVault(address(router));
        deed.setOwner(TOKEN, alice);

        // The router is what settles into the treasury -- it has to be authorized.
        vm.prank(governance);
        treasury.setAuthorizedSettler(address(router), true);
    }

    /// @dev Simulates Nitro crediting gas fees into the child chain vault.
    function _earnGasFees(uint256 amount) internal {
        vm.deal(address(vault), address(vault).balance + amount);
    }

    // -----------------------------------------------------------------------
    // Hop 1: from the chain to the bridge
    // -----------------------------------------------------------------------

    function test_SweepSendsEverythingToTheRouter() public {
        _earnGasFees(5 ether);

        vault.sweep();

        assertEq(MockArbSys(ARB_SYS_ADDRESS).lastDestination(), address(router),
            "the revenue has to leave for this chain router");
        assertEq(MockArbSys(ARB_SYS_ADDRESS).lastAmount(), 5 ether);
        assertEq(address(vault).balance, 0, "the chain vault should end up empty");
        assertEq(vault.lifetimeSwept(), 5 ether);
    }

    /// @notice Anyone can push the settlement, and nobody chooses the destination.
    /// @dev    It is what guarantees the income does not lock up if the operator vanishes.
    function test_AnyoneCanSweepAndNobodyChoosesWhere() public {
        _earnGasFees(3 ether);

        vm.prank(randomPerson);
        vault.sweep();

        assertEq(MockArbSys(ARB_SYS_ADDRESS).lastDestination(), address(router));
        assertEq(address(vault).balance, 0);
    }

    /// @notice The destination is immutable -- there is no function to redirect it.
    /// @dev    This test is about what the contract does NOT have. If a
    ///         `setDestination` ever appears, this is where the intent is recorded.
    function test_DestinationIsFixedForever() public view {
        assertEq(vault.destination(), address(router));
    }

    function test_SweepingNothingReverts() public {
        vm.expectRevert(VoidChainFeeVault.NothingToSweep.selector);
        vault.sweep();
    }

    function test_VaultWithoutDestinationCannotExist() public {
        vm.expectRevert(VoidChainFeeVault.ZeroAddress.selector);
        new VoidChainFeeVault(address(0));
    }

    // -----------------------------------------------------------------------
    // Hop 2: from the bridge to the treasury
    // -----------------------------------------------------------------------

    /// @notice What arrives at the router becomes credit for the right chain.
    function test_FlushCreditsTheRightChain() public {
        voidToken.mint(address(router), 10_000);

        router.flush();

        uint256 fee = treasury.claimable(protocolTreasury);
        uint256 holder = treasury.claimable(alice);

        assertEq(fee, 200, "2% de protocolo");
        assertEq(holder, 9_800, "o resto e do detentor");
        assertEq(treasury.lifetimeRevenue(TOKEN), 10_000);
        assertEq(voidToken.balanceOf(address(router)), 0, "the router keeps nothing");
    }

    /// @notice The router only knows how to credit ITS OWN chain.
    /// @dev    This is the attack the design exists to prevent: pointing one
    ///         chain's revenue at another's owner. There is no argument to pass
    ///         -- the `tokenId` is immutable and is born with the contract.
    function test_RouterCannotCreditAnotherChain() public {
        deed.setOwner(2, bob);
        voidToken.mint(address(router), 1_000);

        router.flush();

        assertGt(treasury.claimable(alice), 0, "the owner of chain 1 should receive");
        assertEq(treasury.claimable(bob), 0, "the owner of chain 2 must not receive from here");
        assertEq(treasury.lifetimeRevenue(2), 0);
    }

    function test_AnyoneCanFlush() public {
        voidToken.mint(address(router), 500);

        vm.prank(randomPerson);
        router.flush();

        assertGt(treasury.claimable(alice), 0);
        assertEq(voidToken.balanceOf(randomPerson), 0, "whoever pushes takes nothing");
    }

    function test_FlushingNothingReverts() public {
        vm.expectRevert(VoidChainRevenueRouter.NothingToRoute.selector);
        router.flush();
    }

    // -----------------------------------------------------------------------
    // O caminho inteiro
    // -----------------------------------------------------------------------

    /// @notice From the gas fee to the holder withdrawal, without losing a wei.
    function test_FullPathFromGasFeeToHolderWallet() public {
        _earnGasFees(1_000_000);
        vault.sweep();

        // The bridge delivers: what left the chain shows up at the router.
        voidToken.mint(address(router), MockArbSys(ARB_SYS_ADDRESS).lastAmount());
        router.flush();

        vm.prank(alice);
        treasury.claim();
        vm.prank(protocolTreasury);
        treasury.claim();

        assertEq(
            voidToken.balanceOf(alice) + voidToken.balanceOf(protocolTreasury),
            1_000_000,
            "everything the chain took in has to arrive on the other side"
        );
        assertEq(voidToken.balanceOf(alice), 980_000, "98% to whoever holds the NFT");
        assertEq(voidToken.balanceOf(protocolTreasury), 20_000, "2% to the protocol");
    }

    /// @notice Selling the NFT between settlement and withdrawal does not remove
    ///         what was already credited, and passes the future to the buyer.
    function test_SellingBetweenSweepAndClaim() public {
        voidToken.mint(address(router), 10_000);
        router.flush();
        uint256 aliceEarned = treasury.claimable(alice);

        deed.setOwner(TOKEN, bob);

        voidToken.mint(address(router), 10_000);
        router.flush();

        assertEq(treasury.claimable(alice), aliceEarned, "o passado continua de Alice");
        assertGt(treasury.claimable(bob), 0, "o futuro e de Bob");
    }

    /// @notice Successive settlements add up, and nothing gets stuck along the way.
    function testFuzz_NothingIsLostAcrossManySweeps(uint96 a, uint96 b, uint96 c) public {
        vm.assume(a > 0 && b > 0 && c > 0);
        uint256 total = uint256(a) + b + c;

        for (uint256 i; i < 3; ++i) {
            uint256 amount = i == 0 ? a : (i == 1 ? b : c);
            voidToken.mint(address(router), amount);
            router.flush();
        }

        assertEq(treasury.lifetimeRevenue(TOKEN), total);
        assertEq(
            treasury.claimable(alice) + treasury.claimable(protocolTreasury),
            total,
            "the parts have to add up to everything that passed through"
        );
        assertEq(voidToken.balanceOf(address(router)), 0);
    }
}
