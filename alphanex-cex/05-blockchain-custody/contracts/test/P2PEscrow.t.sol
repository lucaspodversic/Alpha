// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {P2PEscrow} from "../src/P2PEscrow.sol";

/// EN: Tests for the legacy escrow, including the retirement path used by the CEX migration.
/// ES: Tests del escrow heredado, incluido el camino de retiro usado en la migración al CEX.
contract P2PEscrowTest is Test {
    P2PEscrow esc;
    address verifier = address(0x7E);
    address seller = address(0x5E);
    address buyer = address(0xB1);

    function setUp() public {
        esc = new P2PEscrow(verifier);
        vm.deal(seller, 10 ether);
    }

    // EN: Helper: seller locks 1 ETH for the buyer with a 1-day deadline.
    // ES: Helper: el vendedor bloquea 1 ETH para el comprador con un plazo de 1 día.
    function _fund() internal returns (uint256 id) {
        vm.prank(seller);
        id = esc.fund{value: 1 ether}(buyer, uint64(block.timestamp + 1 days));
    }

    // EN: Verifier releases to the buyer; a second release must revert (no double spend).
    // ES: El verificador libera al comprador; una segunda liberación debe revertir (sin doble gasto).
    function testRelease() public {
        uint256 id = _fund();
        vm.prank(verifier);
        esc.release(id);
        assertEq(buyer.balance, 1 ether);
        vm.prank(verifier);
        vm.expectRevert(P2PEscrow.BadState.selector);
        esc.release(id);
    }

    // EN: Nobody but the verifier can release.
    // ES: Nadie más que el verificador puede liberar.
    function testOnlyVerifierReleases() public {
        uint256 id = _fund();
        vm.prank(buyer);
        vm.expectRevert(P2PEscrow.NotVerifier.selector);
        esc.release(id);
    }

    // EN: Seller refund only after the deadline (vm.warp moves time forward).
    // ES: Reintegro al vendedor solo después del plazo (vm.warp adelanta el tiempo).
    function testSellerRefundAfterDeadline() public {
        uint256 id = _fund();
        vm.prank(seller);
        vm.expectRevert(P2PEscrow.TooEarly.selector);
        esc.refund(id);
        vm.warp(block.timestamp + 1 days);
        vm.prank(seller);
        esc.refund(id);
        assertEq(seller.balance, 10 ether);
    }

    // EN: After retire(): no new escrows, but existing ones can still be released / refunded (migration to CEX).
    // ES: Tras retire(): no hay escrows nuevos, pero los existentes pueden liberarse / reintegrarse (migración al CEX).
    function testRetireKeepsExitsOpen() public {
        uint256 id = _fund();
        vm.prank(verifier);
        esc.retire();
        vm.prank(seller);
        vm.expectRevert(P2PEscrow.Retired_.selector);
        esc.fund{value: 1 ether}(buyer, uint64(block.timestamp + 1 days));
        vm.prank(verifier);
        esc.release(id);
        assertEq(buyer.balance, 1 ether);
        assertEq(address(esc).balance, 0);
    }

    /// EN: Bad params rejected. / ES: Parámetros inválidos rechazados.
    function testBadParams() public {
        vm.prank(seller);
        vm.expectRevert(P2PEscrow.BadParams.selector);
        esc.fund{value: 0}(buyer, uint64(block.timestamp + 1));
        vm.expectRevert(P2PEscrow.BadParams.selector);
        new P2PEscrow(address(0));
    }

    // EN: Fuzz: the contract balance always equals the sum of open escrows.
    // ES: Fuzz: el saldo del contrato siempre es igual a la suma de escrows abiertos.
    function testFuzzBalance(uint64 a, uint64 b) public {
        vm.assume(a > 0 && b > 0);
        vm.deal(seller, uint256(a) + uint256(b));
        vm.startPrank(seller);
        esc.fund{value: a}(buyer, uint64(block.timestamp + 1));
        esc.fund{value: b}(buyer, uint64(block.timestamp + 1));
        vm.stopPrank();
        assertEq(address(esc).balance, uint256(a) + uint256(b));
    }
}
