// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {SimpleERC20} from "./SimpleERC20.sol";

/// EN: ANX test token (18 decimals) with a hard cap and owner-only minting. Local/testnet only.
/// ES: Token de prueba ANX (18 decimales) con tope máximo y emisión solo del owner. Solo local/testnet.
contract AnxToken is SimpleERC20 {
    // EN: Maximum supply: 1 billion ANX. / ES: Suministro máximo: mil millones de ANX.
    uint256 public constant MAX_SUPPLY = 1_000_000_000 ether;
    address public immutable owner;

    error NotOwner();
    error CapExceeded();

    constructor() SimpleERC20("AlphaNex Token", "ANX", 18) {
        owner = msg.sender;
    }

    /// EN: Mints new tokens up to MAX_SUPPLY. / ES: Emite tokens nuevos hasta MAX_SUPPLY.
    function mint(address to, uint256 value) external {
        if (msg.sender != owner) revert NotOwner();
        if (totalSupply + value > MAX_SUPPLY) revert CapExceeded();
        _mint(to, value);
    }
}
