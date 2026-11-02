// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {AnxToken} from "../src/AnxToken.sol";
import {MockUSDT} from "../src/MockUSDT.sol";
import {SimpleERC20} from "../src/SimpleERC20.sol";

/// EN: Tests for the local test tokens. / ES: Tests de los tokens de prueba locales.
contract TokensTest is Test {
    AnxToken anx;
    MockUSDT usdt;
    address alice = address(0xA11CE);
    address bob = address(0xB0B);

    function setUp() public {
        anx = new AnxToken();
        usdt = new MockUSDT();
    }

    // EN: Decimals match the real assets they mimic (USDT has 6).
    // ES: Los decimales coinciden con los activos reales que imitan (USDT tiene 6).
    function testMetadata() public view {
        assertEq(anx.decimals(), 18);
        assertEq(usdt.decimals(), 6);
        assertEq(anx.symbol(), "ANX");
        assertEq(usdt.symbol(), "USDT");
    }

    // EN: Only the owner/minter can mint, and ANX cannot exceed MAX_SUPPLY.
    // ES: Solo el owner/minter puede emitir, y ANX no puede superar MAX_SUPPLY.
    function testMintRules() public {
        anx.mint(alice, 10 ether);
        assertEq(anx.balanceOf(alice), 10 ether);
        vm.prank(alice);
        vm.expectRevert(AnxToken.NotOwner.selector);
        anx.mint(alice, 1);
        uint256 cap = anx.MAX_SUPPLY(); // EN: read before expectRevert / ES: leer antes de expectRevert
        vm.expectRevert(AnxToken.CapExceeded.selector);
        anx.mint(alice, cap);
        vm.prank(bob);
        vm.expectRevert(MockUSDT.NotMinter.selector);
        usdt.mint(bob, 1);
    }

    // EN: Transfer events are what the deposit watcher reads, so they must be exact.
    // ES: Los eventos Transfer son lo que lee el watcher de depósitos, así que deben ser exactos.
    function testTransferEmits() public {
        usdt.mint(alice, 100e6);
        vm.expectEmit(true, true, false, true);
        emit SimpleERC20.Transfer(alice, bob, 40e6);
        vm.prank(alice);
        usdt.transfer(bob, 40e6);
        assertEq(usdt.balanceOf(bob), 40e6);
    }

    /// EN: Allowance flow and errors. / ES: Flujo de autorizaciones y errores.
    function testAllowance() public {
        usdt.mint(alice, 100);
        vm.prank(alice);
        usdt.approve(bob, 60);
        vm.startPrank(bob);
        usdt.transferFrom(alice, bob, 60);
        vm.expectRevert(SimpleERC20.InsufficientAllowance.selector);
        usdt.transferFrom(alice, bob, 1);
        vm.stopPrank();
    }

    // EN: Fuzz: transfers never create or destroy tokens.
    // ES: Fuzz: las transferencias nunca crean ni destruyen tokens.
    function testFuzzConservation(uint96 minted, uint96 sent) public {
        vm.assume(sent <= minted);
        usdt.mint(alice, minted);
        vm.prank(alice);
        usdt.transfer(bob, sent);
        assertEq(usdt.balanceOf(alice) + usdt.balanceOf(bob), usdt.totalSupply());
    }

    /// EN: Cannot overspend or send to zero. / ES: No se puede gastar de más ni enviar a cero.
    function testRejects() public {
        vm.expectRevert(SimpleERC20.InsufficientBalance.selector);
        vm.prank(alice);
        usdt.transfer(bob, 1);
        usdt.mint(alice, 1);
        vm.expectRevert(SimpleERC20.ZeroAddress.selector);
        vm.prank(alice);
        usdt.transfer(address(0), 1);
    }
}
