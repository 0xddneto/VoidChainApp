// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {VoidChainExecutor} from "../contracts/child/VoidChainExecutor.sol";

/// @notice A fake ArbOwner, planted at the precompile's address by the test.
contract MockArbOwner {
    uint256 public lastMinBaseFee;
    address public networkFeeAccount;
    address public infraFeeAccount;
    uint256 public addChainOwnerCalls;

    function setMinimumL2BaseFee(uint256 priceInWei) external {
        lastMinBaseFee = priceInWei;
    }

    function setNetworkFeeAccount(address a) external {
        networkFeeAccount = a;
    }

    function setInfraFeeAccount(address a) external {
        infraFeeAccount = a;
    }

    function addChainOwner(address) external {
        addChainOwnerCalls++;
    }

    function removeChainOwner(address) external {}
}

/**
 * The contract that keeps the sale of the NFT from becoming a rug.
 *
 * The Executor is the chain's only registered chain owner. If anyone can make it
 * run an instruction without going through the Controller, the entire
 * three-tier authority model falls with it.
 */
contract ExecutorTest is Test {
    VoidChainExecutor executor;
    MockArbOwner arbOwner;

    address constant ARB_OWNER_PRECOMPILE = 0x0000000000000000000000000000000000000070;
    uint160 constant ALIAS_OFFSET = uint160(0x1111000000000000000000000000000000001111);

    address controller = address(0xC047501);
    address feeCollector = address(0xFA17);
    address attacker = address(0xBAD);

    function setUp() public {
        arbOwner = new MockArbOwner();
        // The precompile lives at a fixed address; we plant the mock there.
        vm.etch(ARB_OWNER_PRECOMPILE, address(arbOwner).code);

        executor = new VoidChainExecutor(controller, feeCollector);
    }

    function _aliased(address a) internal pure returns (address) {
        return address(uint160(a) + ALIAS_OFFSET);
    }

    // -----------------------------------------------------------------------
    // Authentication by aliasing
    // -----------------------------------------------------------------------

    /// @notice Only the controller's ALIASED address is accepted.
    function test_OnlyAliasedControllerIsAccepted() public {
        vm.prank(_aliased(controller));
        executor.applyMinBaseFee(0.005 gwei);

        (bool ok, bytes memory data) = ARB_OWNER_PRECOMPILE.staticcall(
            abi.encodeWithSignature("lastMinBaseFee()")
        );
        assertTrue(ok);
        assertEq(abi.decode(data, (uint256)), 0.005 gwei);
    }

    /// @notice The controller calling WITHOUT an alias is refused.
    ///
    ///         This is the point: a contract occupying the controller's address
    ///         on this chain arrives un-aliased, and therefore does not pass. It
    ///         is what stops anyone from forging instructions locally.
    function test_UnaliasedControllerIsRejected() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                VoidChainExecutor.NotAliasedController.selector,
                controller,
                _aliased(controller)
            )
        );
        vm.prank(controller);
        executor.applyMinBaseFee(1 gwei);
    }

    function test_AttackerCannotDriveTheChain() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                VoidChainExecutor.NotAliasedController.selector,
                attacker,
                _aliased(controller)
            )
        );
        vm.prank(attacker);
        executor.applyMinBaseFee(1 gwei);
    }

    /// @notice Not even the ATTACKER's alias works — the alias has to be the
    ///         correct controller's, not just any alias.
    function test_AliasOfWrongAddressIsRejected() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                VoidChainExecutor.NotAliasedController.selector,
                _aliased(attacker),
                _aliased(controller)
            )
        );
        vm.prank(_aliased(attacker));
        executor.applyMinBaseFee(1 gwei);
    }

    // -----------------------------------------------------------------------
    // What the Executor deliberately does NOT do
    // -----------------------------------------------------------------------

    /// @notice The Executor exposes no way to add another chain owner.
    ///
    ///         That is the door that would collapse the whole model: whoever
    ///         adds a chain owner bypasses the Controller, the timelock and the
    ///         value bounds. The absence is the defense.
    function test_ExecutorExposesNoWayToAddAChainOwner() public {
        (bool found,) = address(executor).call(
            abi.encodeWithSignature("addChainOwner(address)", attacker)
        );
        assertFalse(found, "o Executor nao pode ter addChainOwner");

        (bool forwarder,) = address(executor).call(
            abi.encodeWithSignature("execute(address,bytes)", ARB_OWNER_PRECOMPILE, "")
        );
        assertFalse(forwarder, "o Executor nao pode ter forwarder generico");
    }

    /// @notice The fee vault is immutable, so no instruction redirects the
    ///         chain's revenue anywhere else.
    function test_FeeCollectorIsImmutable() public view {
        assertEq(executor.feeCollector(), feeCollector);
    }

    function test_BindFeeAccountsPointsToTheImmutableCollector() public {
        vm.prank(_aliased(controller));
        executor.bindFeeAccounts();

        (, bytes memory net) =
            ARB_OWNER_PRECOMPILE.staticcall(abi.encodeWithSignature("networkFeeAccount()"));
        (, bytes memory infra) =
            ARB_OWNER_PRECOMPILE.staticcall(abi.encodeWithSignature("infraFeeAccount()"));

        assertEq(abi.decode(net, (address)), feeCollector);
        assertEq(abi.decode(infra, (address)), feeCollector);
    }

    function test_AttackerCannotRebindFeeAccounts() public {
        vm.expectRevert();
        vm.prank(attacker);
        executor.bindFeeAccounts();
    }

    function test_ConstructorRejectsZeroAddresses() public {
        vm.expectRevert(VoidChainExecutor.ZeroAddress.selector);
        new VoidChainExecutor(address(0), feeCollector);

        vm.expectRevert(VoidChainExecutor.ZeroAddress.selector);
        new VoidChainExecutor(controller, address(0));
    }

    /// @notice Any sender that is not the exact alias is refused.
    function testFuzz_OnlyOneSenderEverPasses(address sender) public {
        vm.assume(sender != _aliased(controller));
        vm.expectRevert();
        vm.prank(sender);
        executor.applyMinBaseFee(1 gwei);
    }
}
