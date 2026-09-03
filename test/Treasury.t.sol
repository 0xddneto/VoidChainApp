// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
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

/**
 * VOID on the parent chain, with two pieces of malice built in on purpose.
 *
 * `blocked` models a token with a blocklist -- USDC has one, and VOID may come
 * to have one. It is the honest stand-in for the "holder who refuses payment"
 * of the old model: with a plain ERC-20 the recipient has no way to refuse
 * anything, so the transfer failure has to come from the token.
 *
 * `reentrantOn` gives the token a reentrancy hook, like an ERC-777. A plain
 * ERC-20 does not call the recipient and therefore allows no reentrancy --
 * testing only against the well-behaved token would prove the guard against
 * existe.
 */
contract MockVoidToken is IERC20 {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    mapping(address => bool) public blocked;

    address public reentrantOn;
    address public reentrantTarget;
    bool public reentryAttempted;
    bool public reentryReverted;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function setBlocked(address who, bool value) external {
        blocked[who] = value;
    }

    function armReentrancy(address who, address treasury) external {
        reentrantOn = who;
        reentrantTarget = treasury;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        if (blocked[to]) return false;
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;

        if (to == reentrantOn && !reentryAttempted) {
            reentryAttempted = true;
            try VoidChainTreasury(reentrantTarget).claim() {
                // Passou: o cofre foi drenado e o teste vai acusar.
            } catch {
                reentryReverted = true;
            }
        }
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        if (blocked[to]) return false;
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) allowance[from][msg.sender] = allowed - amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

/// @notice A holder that is a contract and merely keeps what it receives.
contract PassiveHolder {
    function claimFrom(VoidChainTreasury treasury) external {
        treasury.claim();
    }
}

/**
 * O cofre sob ataque.
 *
 * What these tests try to break: the integrity of the money. Reentrancy, who
 * gets paid when the NFT is sold, and whether a hostile holder can lock the
 * system up for everyone else.
 *
 * Everything here is denominated in VOID. The previous version of these tests
 * sent ETH, and that is why it let through the fact that the whole contract was
 * in the wrong currency: gas on these chains is paid in VOID, and ETH is the
 * nunca vai receber.
 */
contract TreasuryTest is Test {
    VoidChainTreasury treasury;
    FakeDeed deed;
    MockVoidToken voidToken;

    address governance = address(0x6009);
    address protocolTreasury = address(0x9001);
    address alice = address(0xA11CE);
    address bob = address(0xB0B);

    uint256 constant TOKEN = 1;

    function setUp() public {
        deed = new FakeDeed();
        voidToken = new MockVoidToken();
        treasury = new VoidChainTreasury(
            IVoidChainDeed(address(deed)), IERC20(address(voidToken)), protocolTreasury, governance
        );
        deed.setOwner(TOKEN, alice);

        // The test settles revenue directly, so it is the settler -- governance
        // authorizes it. In production, the settler is the runtime/router.
        vm.prank(governance);
        treasury.setAuthorizedSettler(address(this), true);

        voidToken.mint(address(this), 1_000_000 ether);
        voidToken.approve(address(treasury), type(uint256).max);
    }

    /// @dev Settles `amount` of VOID as revenue of chain `tokenId`.
    function _settle(uint256 tokenId, uint256 amount) internal {
        treasury.settle(tokenId, amount);
    }

    // -----------------------------------------------------------------------
    // Reentrancy
    // -----------------------------------------------------------------------

    /// @notice The balance is cleared BEFORE the transfer, so the second call
    ///         has nothing to withdraw even if the guard failed.
    function test_ReentrancyCannotDrainTheVault() public {
        deed.setOwner(TOKEN, bob);
        _settle(TOKEN, 10 ether);

        // Another chain leaves funds in the contract -- that is what a drain would steal.
        deed.setOwner(2, alice);
        _settle(2, 50 ether);

        voidToken.armReentrancy(bob, address(treasury));

        uint256 vaultBefore = voidToken.balanceOf(address(treasury));
        uint256 owed = treasury.claimable(bob);

        vm.prank(bob);
        treasury.claim();

        assertTrue(voidToken.reentryAttempted(), "o teste precisa ter tentado reentrar");
        assertTrue(voidToken.reentryReverted(), "the second call should have failed");
        assertEq(voidToken.balanceOf(bob), owed, "the attacker took more than they were owed");
        assertEq(
            voidToken.balanceOf(address(treasury)),
            vaultBefore - owed,
            "the treasury lost more than it owed"
        );
        assertEq(treasury.claimable(bob), 0);
    }

    // -----------------------------------------------------------------------
    // Who gets paid
    // -----------------------------------------------------------------------

    /// @notice `ownerOf` is read at settlement time, so selling the NFT
    ///         transfers the future income with no reconciliation at all.
    function test_RevenueFollowsTheDeedAtSettlementTime() public {
        _settle(TOKEN, 10 ether);
        uint256 aliceAfterFirst = treasury.claimable(alice);
        assertGt(aliceAfterFirst, 0);

        deed.setOwner(TOKEN, bob);
        _settle(TOKEN, 10 ether);

        assertEq(treasury.claimable(alice), aliceAfterFirst, "Alice must not earn after selling");
        assertGt(treasury.claimable(bob), 0, "Bob should receive after the purchase");
    }

    /// @notice What was already credited stays with the seller. Selling the
    ///         chain does not confiscate what it has already earned.
    function test_SellingDoesNotConfiscatePastEarnings() public {
        _settle(TOKEN, 10 ether);
        uint256 earned = treasury.claimable(alice);

        deed.setOwner(TOKEN, bob);

        vm.prank(alice);
        treasury.claim();
        assertEq(voidToken.balanceOf(alice), earned);
    }

    // -----------------------------------------------------------------------
    // A conta
    // -----------------------------------------------------------------------

    function test_SplitIsExactAndResidualGoesToHolder() public {
        uint256 gross = 10_000;
        _settle(TOKEN, gross);

        uint256 fee = treasury.claimable(protocolTreasury);
        uint256 holder = treasury.claimable(alice);

        assertEq(fee, 200, "2% de 10000");
        assertEq(fee + holder, gross, "the parts have to add up to the whole");
    }

    /// @notice An amount so small that the fee rounds to zero: the owner takes
    ///         everything, and nothing gets stuck in the contract.
    /// @notice Nothing disappears in the dust, and the protocol charges the 1-wei floor.
    /// @dev    Before, the 2% rounded to zero below 50 wei; the floor closes
    ///         that hole (found in red-team). For 1 wei: protocol 1, owner 0 --
    ///         the parts still add up to the whole, nothing is lost.
    function test_DustAmountLosesNothing() public {
        _settle(TOKEN, 1);
        assertEq(treasury.claimable(protocolTreasury), 1, "piso de 1 wei");
        assertEq(treasury.claimable(alice), 0);

        _settle(TOKEN, 100);
        // 2% of 100 = 2, owner 98 -- a normal value, no floor.
        assertEq(treasury.claimable(protocolTreasury), 1 + 2);
        assertEq(treasury.claimable(alice), 98);
    }

    function test_SettlingNothingIsRejected() public {
        vm.expectRevert(VoidChainTreasury.NothingToSettle.selector);
        _settle(TOKEN, 0);
    }

    /// @notice The VOID really enters the treasury, and not just the ledger.
    /// @dev    If `settle` credited without pulling the token, the contract
    ///         would promise withdrawals it could not pay -- and the discovery
    ///         would come from the first holder left unpaid.
    function test_SettlementActuallyMovesTheToken() public {
        uint256 before = voidToken.balanceOf(address(treasury));
        _settle(TOKEN, 7 ether);
        assertEq(voidToken.balanceOf(address(treasury)) - before, 7 ether);
        assertEq(
            treasury.claimable(alice) + treasury.claimable(protocolTreasury),
            7 ether,
            "what was credited has to match what was received"
        );
    }

    /// @notice The runtime's already-separated protocol share goes straight to
    /// the configured public wallet. No treasury key is required to claim it.
    function test_ProtocolCreditIsSentDirectlyToItsPublicWallet() public {
        uint256 amount = 7 ether;
        uint256 before = voidToken.balanceOf(protocolTreasury);

        treasury.creditTo(protocolTreasury, amount);

        assertEq(voidToken.balanceOf(protocolTreasury), before + amount);
        assertEq(treasury.claimable(protocolTreasury), 0, "protocol revenue must not wait for a claim");
        assertEq(voidToken.balanceOf(address(treasury)), 0, "the protocol share must not stay in the treasury");
    }

    // -----------------------------------------------------------------------
    // Isolamento de falha
    // -----------------------------------------------------------------------

    /// @notice A holder who cannot receive does not lock up the others -- that
    ///         is exactly why payment is by pull, not by push.
    function test_HostileHolderCannotBlockOthers() public {
        PassiveHolder hostile = new PassiveHolder();
        deed.setOwner(TOKEN, address(hostile));
        deed.setOwner(2, bob);

        _settle(TOKEN, 10 ether);
        _settle(2, 10 ether);

        // The token refuses to deliver to this address.
        voidToken.setBlocked(address(hostile), true);

        vm.expectRevert(VoidChainTreasury.TransferFailed.selector);
        hostile.claimFrom(treasury);

        // E Bob recebe normalmente.
        uint256 owed = treasury.claimable(bob);
        vm.prank(bob);
        treasury.claim();
        assertEq(voidToken.balanceOf(bob), owed);
    }

    /// @notice If the transfer fails, the holder balance stays standing.
    /// @dev    A withdrawal that clears the credit and then fails silently would
    ///         erase somebody money. The revert has to undo everything.
    function test_FailedClaimDoesNotDestroyTheBalance() public {
        deed.setOwner(TOKEN, bob);
        _settle(TOKEN, 10 ether);
        uint256 owed = treasury.claimable(bob);

        voidToken.setBlocked(bob, true);
        vm.expectRevert(VoidChainTreasury.TransferFailed.selector);
        vm.prank(bob);
        treasury.claim();

        assertEq(treasury.claimable(bob), owed, "the credit must not vanish on a failure");

        voidToken.setBlocked(bob, false);
        vm.prank(bob);
        treasury.claim();
        assertEq(voidToken.balanceOf(bob), owed);
    }

    // -----------------------------------------------------------------------
    // Governance
    // -----------------------------------------------------------------------

    function test_OnlyGovernanceMovesTheProtocolFee() public {
        vm.expectRevert(abi.encodeWithSelector(VoidChainTreasury.NotGovernance.selector, alice));
        vm.prank(alice);
        treasury.setProtocolTreasury(alice);

        vm.prank(governance);
        treasury.setProtocolTreasury(address(0x7777));
        assertEq(treasury.protocolTreasury(), address(0x7777));
    }

    /// @notice Changing the fee destination does not touch what was already
    ///         credited to the old address.
    function test_ChangingFeeRecipientDoesNotTouchAccruedBalance() public {
        _settle(TOKEN, 10 ether);
        uint256 accrued = treasury.claimable(protocolTreasury);
        assertGt(accrued, 0);

        vm.prank(governance);
        treasury.setProtocolTreasury(address(0x7777));

        assertEq(treasury.claimable(protocolTreasury), accrued, "the old one lost what it already had");
        assertEq(treasury.claimable(address(0x7777)), 0);
    }

    function test_GovernanceCannotBeSetToZero() public {
        vm.expectRevert(VoidChainTreasury.ZeroAddress.selector);
        vm.prank(governance);
        treasury.transferGovernance(address(0));
    }

    function test_ClaimingNothingReverts() public {
        vm.expectRevert(VoidChainTreasury.NothingToClaim.selector);
        vm.prank(alice);
        treasury.claim();
    }

    /// @notice A treasury without the token cannot be constructed.
    function test_ZeroTokenIsRejected() public {
        vm.expectRevert(VoidChainTreasury.ZeroAddress.selector);
        new VoidChainTreasury(
            IVoidChainDeed(address(deed)), IERC20(address(0)), protocolTreasury, governance
        );
    }

    // -----------------------------------------------------------------------
    // Propriedade sob qualquer entrada
    // -----------------------------------------------------------------------

    /// @notice For any value, the parts add up to exactly the total and nothing
    ///         fica preso no contrato.
    function testFuzz_SplitNeverLosesWei(uint96 amount) public {
        vm.assume(amount > 0);
        voidToken.mint(address(this), amount);

        _settle(TOKEN, amount);

        uint256 fee = treasury.claimable(protocolTreasury);
        uint256 holder = treasury.claimable(alice);
        assertEq(fee + holder, amount, "as partes precisam somar o todo");
    }

    // -----------------------------------------------------------------------
    // Settler scope: a router bound to its chain cannot reach another
    // -----------------------------------------------------------------------

    /// @notice A settler scoped to chain N does not settle chain M.
    /// @dev    It reduces the trust: even among legitimate settlers, a buggy or
    ///         compromised L3 router stays stuck on its own chain.
    function test_ChainSettlerCannotSettleAnotherChain() public {
        address routerOf5 = address(0x5555);
        vm.prank(governance);
        treasury.setChainSettler(routerOf5, 5, true);

        voidToken.mint(routerOf5, 100 ether);
        vm.startPrank(routerOf5);
        voidToken.approve(address(treasury), type(uint256).max);

        // Escritura a chain 5: passa.
        treasury.settle(5, 10 ether);
        assertEq(treasury.lifetimeRevenue(5), 10 ether);

        // Tenta escriturar a chain 9: recusado.
        vm.expectRevert(
            abi.encodeWithSelector(VoidChainTreasury.SettlerWrongChain.selector, routerOf5, uint256(9))
        );
        treasury.settle(9, 10 ether);
        vm.stopPrank();

        assertEq(treasury.lifetimeRevenue(9), 0, "a chain 9 ficou intacta");
    }

    /// @notice O curinga (o runtime) escritura qualquer chain.
    function test_WildcardSettlerReachesAnyChain() public {
        // address(this) was authorized as a wildcard in setUp.
        _settle(5, 1 ether);
        _settle(9, 1 ether);
        assertEq(treasury.lifetimeRevenue(5), 1 ether);
        assertEq(treasury.lifetimeRevenue(9), 1 ether);
    }

    /// @notice An invalid chain scope (0 or the wildcard) is refused.
    function test_BadChainScopeIsRejected() public {
        vm.prank(governance);
        vm.expectRevert(VoidChainTreasury.BadScope.selector);
        treasury.setChainSettler(address(0xABCD), 0, true);

        vm.prank(governance);
        vm.expectRevert(VoidChainTreasury.BadScope.selector);
        treasury.setChainSettler(address(0xABCD), type(uint256).max, true);
    }
}
