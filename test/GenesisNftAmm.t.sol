// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {VoidGenesisNftAmmV6, IVoidGenesisEscrowV6, IVoidGenesisTokenV6, IVoidGenesisDeedV6} from "../contracts/genesis/VoidGenesisNftAmmV6.sol";
import {VoidGenesisEscrowV6, IVoidEscrowToken} from "../contracts/genesis/VoidGenesisEscrowV6.sol";
import {VoidTokenV6} from "../contracts/genesis/VoidTokenV6.sol";
import {VoidChainAppGateway} from "../contracts/parent/VoidChainAppFactoryV3.sol";
import {IVoidChainAppRuntime} from "../contracts/apps/ChainAppBase.sol";

// These fixtures isolate inventory/accounting. Permit cryptography and real
// Paymaster budgets require their separate integration tests.
contract AmmTestDeed is ERC721 {
    constructor() ERC721("Test Deed", "DEED") {}
    function mint(address to, uint256 id) external { _mint(to, id); }
    function permit(address spender, uint256 id, uint256, uint8, bytes32, bytes32) external {
        _approve(spender, id, address(0));
    }
}

contract AmmTestRuntime is IVoidChainAppRuntime {
    uint256 public executingChain;
    address public executingCaller;
    address private target;
    function execute(address app, bytes calldata data) external {
        executingChain = 1;
        executingCaller = msg.sender;
        target = app;
        (bool ok, bytes memory reason) = app.call(data);
        if (!ok) assembly { revert(add(reason, 32), mload(reason)) }
        executingChain = 0;
        executingCaller = address(0);
        target = address(0);
    }
    function spendFrom(address token, address to, uint256 amount) external {
        require(msg.sender == target, "wrong app");
        VoidTokenV6(token).transferFrom(executingCaller, to, amount);
    }
    function spendNftFrom(address collection, address to, uint256 id) external {
        require(msg.sender == target, "wrong app");
        AmmTestDeed(collection).transferFrom(executingCaller, to, id);
    }
}

contract GenesisNftAmmTest is Test {
    address private constant USER = address(0xA11CE);
    address private constant TREASURY = address(0xBEEF);
    address private constant BUILDER = address(0xB017);
    address private constant RESERVE = address(0xCAFE);
    VoidGenesisEscrowV6 private escrow;
    VoidTokenV6 private token;
    AmmTestDeed private deed;
    AmmTestRuntime private runtime;
    VoidChainAppGateway private gateway;
    VoidGenesisNftAmmV6 private implementation;

    function setUp() public {
        escrow = new VoidGenesisEscrowV6(address(this));
        token = new VoidTokenV6(address(escrow));
        deed = new AmmTestDeed();
        runtime = new AmmTestRuntime();
        implementation = new VoidGenesisNftAmmV6(
            runtime, 1, IVoidGenesisTokenV6(address(token)), IVoidGenesisDeedV6(address(deed)),
            IVoidGenesisEscrowV6(address(escrow)), TREASURY
        );
        gateway = new VoidChainAppGateway(address(runtime), 1, address(implementation), "");
        escrow.configureOnce(IVoidEscrowToken(address(token)), address(this), address(this), BUILDER, RESERVE);
        escrow.setNftAmmOnce(address(gateway));
        deed.mint(USER, 1);
        // Existing genesis allocation funds fees; no new token mint occurs.
        vm.prank(BUILDER); token.transfer(USER, 2_000_000 ether);
        vm.prank(USER); token.approve(address(runtime), type(uint256).max);
    }

    function sell() private {
        vm.prank(USER);
        runtime.execute(address(gateway), abi.encodeCall(implementation.sellWithPermit, (1, block.timestamp + 600, 27, bytes32(0), bytes32(0))));
    }
    function buy(bool specific) private {
        bytes memory data = specific
            ? abi.encodeCall(implementation.buySpecific, (1, implementation.specificBuyQuote()))
            : abi.encodeCall(implementation.buyRandom, (implementation.randomBuyQuote()));
        vm.prank(USER); runtime.execute(address(gateway), data);
    }
    function inventory() private view returns (uint256) {
        return abi.decode(gateway.query(abi.encodeCall(implementation.inventoryCount, ())), (uint256));
    }
    function assertConservation() private view {
        uint256 accounted = token.balanceOf(address(escrow)) + token.balanceOf(USER)
            + token.balanceOf(address(gateway)) + token.balanceOf(TREASURY)
            + token.balanceOf(BUILDER) + token.balanceOf(RESERVE);
        assertEq(accounted, token.totalSupply());
        assertEq(token.totalSupply(), 1_000_000_000 ether);
    }

    function test_repeatedSellBuySellReusesPoolLiquidity() public {
        sell();
        assertEq(escrow.nftAmmReleased(), 500_000 ether);
        for (uint256 i; i < 20; ++i) {
            buy(i % 2 == 0);
            assertEq(deed.ownerOf(1), USER);
            assertEq(inventory(), 0);
            sell();
            assertEq(deed.ownerOf(1), address(gateway));
            assertEq(inventory(), 1);
            assertEq(escrow.nftAmmReleased(), 500_000 ether);
            assertConservation();
        }
        assertEq(token.balanceOf(TREASURY), 41 * 2_500 ether);
    }

    function test_buyAboveLimitPreservesInventory() public {
        sell();
        vm.expectRevert();
        vm.prank(USER);
        runtime.execute(address(gateway), abi.encodeCall(implementation.buySpecific, (1, 1)));
        assertEq(inventory(), 1);
        assertEq(deed.ownerOf(1), address(gateway));
        assertConservation();
    }

    function test_directWalletCannotSellThroughGateway() public {
        vm.expectRevert(abi.encodeWithSelector(VoidChainAppGateway.NotRuntime.selector, USER));
        vm.prank(USER);
        VoidGenesisNftAmmV6(address(gateway)).sellWithPermit(1, block.timestamp + 600, 27, bytes32(0), bytes32(0));
        assertFalse(escrow.deedReleased(1));
    }

    function test_nonOwnerCannotReleaseBacking() public {
        vm.expectRevert();
        runtime.execute(address(gateway), abi.encodeCall(implementation.sellWithPermit, (1, block.timestamp + 600, 27, bytes32(0), bytes32(0))));
        assertFalse(escrow.deedReleased(1));
        assertConservation();
    }
}
