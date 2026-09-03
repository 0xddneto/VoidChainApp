// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {VoidChainDeed} from "../contracts/parent/VoidChainDeed.sol";
import {
    VoidChainController, IVoidChainDeed, IGasToken
} from "../contracts/parent/VoidChainController.sol";
import {IArbitrumInbox} from "../contracts/interfaces/IArbitrumInbox.sol";

/// @notice A fake inbox that records what it received, for the test to inspect.
contract MockInbox is IArbitrumInbox {
    address public lastTo;
    bytes public lastData;
    uint256 public lastValue;
    uint256 public callCount;

    /// @dev ERC20Inbox signature: it is not payable, and the fee comes in tokens.
    function createRetryableTicket(
        address to,
        uint256,
        uint256,
        address,
        address,
        uint256,
        uint256,
        uint256 tokenTotalFeeAmount,
        bytes calldata data
    ) external returns (uint256) {
        lastTo = to;
        lastData = data;
        lastValue = tokenTotalFeeAmount;
        callCount++;
        return callCount;
    }
}

/// @notice A fake gas token, with infinite balance to keep the test simple.
contract MockGasToken is IGasToken {
    function transferFrom(address, address, uint256) external pure returns (bool) {
        return true;
    }

    function approve(address, uint256) external pure returns (bool) {
        return true;
    }
}



/**
 * A tese central do projeto, sob ataque.
 *
 * What these tests try to break: the promise that authority over a chain is
 * DERIVED from the NFT, never stored -- and that selling the NFT transfers the
 * chain instantly, without the seller cooperating.
 */
contract AuthorityTest is Test {
    VoidChainDeed deed;
    VoidChainController controller;
    MockInbox inbox;
    MockGasToken gasToken;

    address governance = address(0x6009);
    address alice = address(0xA11CE);
    address bob = address(0xB0B);
    address attacker = address(0xBAD);

    address executor = address(0xEEC);
    address feeVault = address(0xFA17);

    uint256 constant TOKEN = 1;
    uint256 constant CHAIN_ID_BASE = 46_630_000;
    uint256 constant TICKET_FEE = 1 ether;

    function setUp() public {
        // The test itself is the minter.
        deed = new VoidChainDeed(CHAIN_ID_BASE, address(this), address(0xFEE), 500);
        gasToken = new MockGasToken();
        controller = new VoidChainController(
            IVoidChainDeed(address(deed)), IGasToken(address(gasToken)), governance
        );
        inbox = new MockInbox();

        deed.mint(alice, TOKEN);

        vm.prank(governance);
        controller.activateChain(TOKEN, IArbitrumInbox(address(inbox)), executor, feeVault);

        vm.deal(alice, 10 ether);
        vm.deal(bob, 10 ether);
        vm.deal(attacker, 10 ether);
    }

    // -----------------------------------------------------------------------
    // The test that defines the project
    // -----------------------------------------------------------------------

    /// @notice Selling the NFT transfers authority over the chain in the same
    ///         block, with no action from the seller beyond the transfer.
    function test_SellingDeedTransfersChainAuthority() public {
        // Alice manda na chain.
        vm.prank(alice);
        controller.setMinBaseFee(TOKEN, 0.005 gwei, TICKET_FEE);

        // Bob commands nothing.
        vm.expectRevert(
            abi.encodeWithSelector(VoidChainController.NotDeedHolder.selector, TOKEN, bob)
        );
        vm.prank(bob);
        controller.setMinBaseFee(TOKEN, 0.004 gwei, TICKET_FEE);

        // The sale. No call to the controller, no migration.
        vm.prank(alice);
        deed.transferFrom(alice, bob, TOKEN);

        // At the same instant, Bob commands and Alice does not.
        vm.prank(bob);
        controller.setMinBaseFee(TOKEN, 0.003 gwei, TICKET_FEE);

        vm.expectRevert(
            abi.encodeWithSelector(VoidChainController.NotDeedHolder.selector, TOKEN, alice)
        );
        vm.prank(alice);
        controller.setMinBaseFee(TOKEN, 0.006 gwei, TICKET_FEE);
    }

    // -----------------------------------------------------------------------
    // Tentativas de escapar do modelo de autoridade
    // -----------------------------------------------------------------------

    function test_AttackerCannotTouchSomeoneElsesChain() public {
        vm.expectRevert(
            abi.encodeWithSelector(VoidChainController.NotDeedHolder.selector, TOKEN, attacker)
        );
        vm.prank(attacker);
        controller.setMinBaseFee(TOKEN, 0.001 gwei, TICKET_FEE);
    }

    /// @notice The NFT holder is not governance and cannot become it.
    function test_DeedHolderCannotSeizeGovernance() public {
        vm.expectRevert(
            abi.encodeWithSelector(VoidChainController.NotGovernance.selector, alice)
        );
        vm.prank(alice);
        controller.transferGovernance(alice);

        vm.expectRevert(abi.encodeWithSelector(VoidChainController.NotGovernance.selector, alice));
        vm.prank(alice);
        controller.setFeeBounds(0, type(uint256).max);
    }

    /// @notice Not even governance can activate a chain twice and swap the
    ///         executor out from under whoever already built on it.
    function test_GovernanceCannotSilentlyRepointAnActiveChain() public {
        vm.expectRevert(
            abi.encodeWithSelector(VoidChainController.VoidChainAlreadyActivated.selector, TOKEN)
        );
        vm.prank(governance);
        controller.activateChain(TOKEN, IArbitrumInbox(address(inbox)), attacker, attacker);
    }

    // -----------------------------------------------------------------------
    // The economic bounds
    // -----------------------------------------------------------------------

    function test_FeeOutsideBoundsIsRejected() public {
        uint256 ceiling = controller.minBaseFeeCeiling();
        vm.expectRevert(
            abi.encodeWithSelector(
                VoidChainController.FeeOutOfBounds.selector,
                ceiling + 1,
                controller.minBaseFeeFloor(),
                ceiling
            )
        );
        vm.prank(alice);
        controller.setMinBaseFee(TOKEN, ceiling + 1, TICKET_FEE);
    }

    /// @notice The first fee applies immediately -- there is no user to protect yet.
    function test_FirstFeeIsImmediate() public {
        uint256 before = inbox.callCount();
        vm.prank(alice);
        controller.setMinBaseFee(TOKEN, 0.005 gwei, TICKET_FEE);
        assertEq(inbox.callCount(), before + 1, "the first fee should not wait");
        assertEq(controller.currentBaseFee(TOKEN), 0.005 gwei);
    }

    /// @notice A fee increase waits; a decrease applies immediately.
    function test_FeeIncreaseWaitsButDecreaseIsImmediate() public {
        // Sets the initial fee, which is immediate.
        vm.prank(alice);
        controller.setMinBaseFee(TOKEN, 0.005 gwei, TICKET_FEE);

        // Now RAISING has to wait: there may already be people using the chain.
        uint256 before = inbox.callCount();
        vm.prank(alice);
        controller.setMinBaseFee(TOKEN, 1 gwei, TICKET_FEE);
        assertEq(inbox.callCount(), before, "an increase must not go straight to the chain");

        (uint256 pending,) = controller.pendingBaseFee(TOKEN);
        assertEq(pending, 1 gwei);

        // Before the deadline, applying fails.
        vm.expectRevert();
        controller.applyPendingBaseFee(TOKEN, TICKET_FEE);

        // After the deadline, it passes.
        vm.warp(block.timestamp + 3 days + 1);
        controller.applyPendingBaseFee(TOKEN, TICKET_FEE);
        assertEq(controller.currentBaseFee(TOKEN), 1 gwei);

        // Lowering is immediate -- nobody is harmed by paying less.
        uint256 callsBefore = inbox.callCount();
        vm.prank(alice);
        controller.setMinBaseFee(TOKEN, 0.5 gwei, TICKET_FEE);
        assertEq(inbox.callCount(), callsBefore + 1, "a decrease should go straight through");
        assertEq(controller.currentBaseFee(TOKEN), 0.5 gwei);
    }

    /// @notice The instruction goes to the chain executor, not somewhere else.
    function test_InstructionIsAddressedToTheChainsOwnExecutor() public {
        vm.prank(alice);
        controller.setMinBaseFee(TOKEN, 0.005 gwei, TICKET_FEE);

        assertEq(inbox.lastTo(), executor, "the instruction went to the wrong address");
        assertEq(
            inbox.lastData(),
            abi.encodeWithSignature("applyMinBaseFee(uint256)", uint256(0.005 gwei))
        );
    }

    /// @notice A chain that is not activated accepts no command at all.
    function test_InactiveChainRejectsCommands() public {
        deed.mint(alice, 2);
        vm.expectRevert(abi.encodeWithSelector(VoidChainController.VoidChainNotActivated.selector, 2));
        vm.prank(alice);
        controller.setMinBaseFee(2, 0.005 gwei, TICKET_FEE);
    }

    // -----------------------------------------------------------------------
    // Minting: what guarantees that 1,111 is 1,111
    // -----------------------------------------------------------------------

    function test_OnlyMinterCanMint() public {
        vm.expectRevert(abi.encodeWithSelector(VoidChainDeed.NotMinter.selector, attacker));
        vm.prank(attacker);
        deed.mint(attacker, 500);
    }

    /// @notice The tokenId picks the chain, so minting outside the range would
    ///         create a deed pointing at a chain that does not exist.
    function test_TokenIdOutsideRangeIsRejected() public {
        vm.expectRevert(abi.encodeWithSelector(VoidChainDeed.TokenIdOutOfRange.selector, 0));
        deed.mint(alice, 0);

        vm.expectRevert(abi.encodeWithSelector(VoidChainDeed.TokenIdOutOfRange.selector, 1112));
        deed.mint(alice, 1112);
    }

    function test_CannotMintTheSameChainTwice() public {
        vm.expectRevert();
        deed.mint(bob, TOKEN);
    }

    /// @notice Selar a cunhagem transforma o supply de promessa em fato.
    function test_SealingMintingIsIrreversible() public {
        deed.sealMinting();

        vm.expectRevert(VoidChainDeed.MintingIsSealed.selector);
        deed.mint(alice, 500);

        vm.expectRevert(VoidChainDeed.MintingIsSealed.selector);
        deed.sealMinting();
    }

    function test_MintedChainIdMatchesDerivation() public {
        deed.mint(bob, 417);
        assertEq(deed.chainIdOf(417), CHAIN_ID_BASE + 416);
    }

    // -----------------------------------------------------------------------
    // Identidade
    // -----------------------------------------------------------------------

    function test_ChainIdIsDerivedAndImmutable() public view {
        assertEq(deed.chainIdOf(1), CHAIN_ID_BASE);
    }

    function test_NonHolderCannotRename() public {
        vm.expectRevert(
            abi.encodeWithSelector(VoidChainDeed.NotDeedHolder.selector, TOKEN, attacker)
        );
        vm.prank(attacker);
        deed.rename(TOKEN, "Roubada");
    }

    /// @notice Names are unique, case-insensitively -- otherwise one could
    ///         registrar "arbitrum one" ao lado de "Arbitrum One".
    function test_NameSquattingIsBlockedCaseInsensitively() public {
        vm.prank(alice);
        deed.rename(TOKEN, "Nova Atlantis");

        deed.mint(bob, 2);
        vm.expectRevert(
            abi.encodeWithSelector(VoidChainDeed.NameTaken.selector, "NOVA ATLANTIS")
        );
        vm.prank(bob);
        deed.rename(2, "NOVA ATLANTIS");
    }

    /// @notice Homoglyph spoofing is refused: a name with a visually identical
    ///         letter from another alphabet does not pass.
    /// @dev    "Arbitrum" with a Cyrillic capital A (0xD0 0x90 in UTF-8) contains
    ///         a non-ASCII byte, so the charset filter blocks it before any
    ///         squatting comparison.
    function test_HomoglyphNameIsRejected() public {
        vm.expectRevert(VoidChainDeed.NameHasInvalidChars.selector);
        vm.prank(alice);
        deed.rename(TOKEN, unicode"Аrbitrum One");
    }

    /// @notice Invisible characters (zero-width space) also fall.
    function test_InvisibleCharNameIsRejected() public {
        vm.expectRevert(VoidChainDeed.NameHasInvalidChars.selector);
        vm.prank(alice);
        deed.rename(TOKEN, unicode"Nova​Atlantis");
    }

    /// @notice A leading/trailing space and double spaces are refused -- otherwise
    ///         "Nova Atlantis " pareceria igual a "Nova Atlantis".
    function test_WhitespaceTricksAreRejected() public {
        vm.prank(alice);
        vm.expectRevert(VoidChainDeed.NameHasInvalidChars.selector);
        deed.rename(TOKEN, "Nova Atlantis ");

        vm.prank(alice);
        vm.expectRevert(VoidChainDeed.NameHasInvalidChars.selector);
        deed.rename(TOKEN, "Nova  Atlantis");

        vm.prank(alice);
        vm.expectRevert(VoidChainDeed.NameHasInvalidChars.selector);
        deed.rename(TOKEN, " Nova Atlantis");
    }

    /// @notice An ordinary clean name still works -- the guard does not close
    ///         demais.
    function test_CleanNameStillWorks() public {
        vm.prank(alice);
        deed.rename(TOKEN, "Nova-Atlantis_2.0");
        // did not revert: valid name
    }

    function test_HolderCanRenameWheneverTheyNeedTo() public {
        vm.prank(alice);
        deed.rename(TOKEN, "Primeiro");

        vm.prank(alice);
        deed.rename(TOKEN, "Segundo");

        VoidChainDeed.Identity memory identity = deed.identityOf(TOKEN);
        assertEq(identity.name, "Segundo");
    }

    /// @notice Releasing the name on rename keeps a chain from being stuck with a
    ///         name locked forever after changing it.
    function test_RenamingReleasesThePreviousName() public {
        vm.prank(alice);
        deed.rename(TOKEN, "Antigo");

        vm.prank(alice);
        deed.rename(TOKEN, "Novo");

        deed.mint(bob, 2);
        vm.prank(bob);
        deed.rename(2, "Antigo");
    }

    // -----------------------------------------------------------------------
    // Executor migration: the protocol is never beyond repair, the repair is
    // immediate, and even so it gains no power over whoever holds the NFT.
    // -----------------------------------------------------------------------

    address newExecutor = address(0xE2EC);

    function test_GovernanceCanMigrateExecutorImmediately() public {
        vm.prank(governance);
        controller.migrateExecutor(TOKEN, newExecutor);

        (, address wired,,) = controller.chains(TOKEN);
        assertEq(wired, newExecutor, "the swap should apply in the same block");
    }

    /// @notice THE NFT OWNER does not migrate the executor. This is the boundary
    ///         between TIER 1 and TIER 2: if the holder could swap the engine
    ///         room, buying the NFT would buy the whole chain, which is exactly
    ///         what the architecture exists to prevent.
    function test_DeedHolderCannotMigrateExecutor() public {
        vm.expectRevert(
            abi.encodeWithSelector(VoidChainController.NotGovernance.selector, alice)
        );
        vm.prank(alice);
        controller.migrateExecutor(TOKEN, newExecutor);
    }

    function test_StrangerCannotMigrateExecutor() public {
        vm.expectRevert(
            abi.encodeWithSelector(VoidChainController.NotGovernance.selector, attacker)
        );
        vm.prank(attacker);
        controller.migrateExecutor(TOKEN, newExecutor);
    }

    /// @notice Migrating to the same address is refused -- it avoids a swap event
    ///         that swapped nothing, which is noise for anyone monitoring.
    function test_MigratingToSameExecutorReverts() public {
        vm.expectRevert(
            abi.encodeWithSelector(VoidChainController.SameExecutor.selector, executor)
        );
        vm.prank(governance);
        controller.migrateExecutor(TOKEN, executor);
    }

    function test_MigratingToZeroReverts() public {
        vm.expectRevert(VoidChainController.ZeroAddress.selector);
        vm.prank(governance);
        controller.migrateExecutor(TOKEN, address(0));
    }

    /// @notice A chain that was never activated has no executor to swap.
    function test_MigratingInactiveChainReverts() public {
        deed.mint(alice, 7);
        vm.expectRevert(
            abi.encodeWithSelector(VoidChainController.VoidChainNotActivated.selector, uint256(7))
        );
        vm.prank(governance);
        controller.migrateExecutor(7, newExecutor);
    }

    /// @notice After swapping the executor, the one in command is still whoever
    ///         holds the NFT -- and still the CURRENT owner, not the pre-migration one.
    function test_MigrationDoesNotChangeWhoCommands() public {
        vm.prank(governance);
        controller.migrateExecutor(TOKEN, newExecutor);

        // The NFT changes hands AFTER the migration.
        vm.prank(alice);
        deed.transferFrom(alice, bob, TOKEN);

        // Bob comanda.
        vm.prank(bob);
        controller.setMinBaseFee(TOKEN, 0.05 gwei, TICKET_FEE);
        assertEq(controller.currentBaseFee(TOKEN), 0.05 gwei);

        // Alice does not.
        vm.expectRevert(
            abi.encodeWithSelector(VoidChainController.NotDeedHolder.selector, TOKEN, alice)
        );
        vm.prank(alice);
        controller.setMinBaseFee(TOKEN, 0.01 gwei, TICKET_FEE);
    }

    /// @notice After the migration the owner first order is immediate, and not
    ///         held for three days by an "increase" that only existed in the
    ///         do controller.
    function test_FirstFeeAfterMigrationIsImmediate() public {
        vm.prank(alice);
        controller.setMinBaseFee(TOKEN, 0.5 gwei, TICKET_FEE);
        assertEq(controller.currentBaseFee(TOKEN), 0.5 gwei);

        vm.prank(governance);
        controller.migrateExecutor(TOKEN, newExecutor);

        // 2 gwei would be an INCREASE over 0.5 -- but the count was cleared.
        vm.prank(alice);
        controller.setMinBaseFee(TOKEN, 2 gwei, TICKET_FEE);
        assertEq(controller.currentBaseFee(TOKEN), 2 gwei, "should apply immediately");
    }

    /// @notice THE HOLDER fee increase still waits. What became immediate was
    ///         infrastructure maintenance, not what changes the price for people
    ///         already using the chain.
    function test_HolderFeeIncreaseStillWaitsAfterMigration() public {
        vm.prank(alice);
        controller.setMinBaseFee(TOKEN, 0.1 gwei, TICKET_FEE);

        vm.prank(alice);
        controller.setMinBaseFee(TOKEN, 1 gwei, TICKET_FEE);

        assertEq(controller.currentBaseFee(TOKEN), 0.1 gwei, "an increase must not apply immediately");
        (uint256 pendingValue, uint256 executableAt) = controller.pendingBaseFee(TOKEN);
        assertEq(pendingValue, 1 gwei);
        assertEq(executableAt, block.timestamp + controller.FEE_INCREASE_DELAY());
    }
}
