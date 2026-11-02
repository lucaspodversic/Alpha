// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {SimpleERC20} from "./SimpleERC20.sol";

/// EN: Mock USDT with 6 decimals like the real one. Faucet-style mint restricted to the deployer.
///     Exists so deposit/withdraw/reconciliation can be tested on a local chain without real funds.
/// ES: USDT simulado con 6 decimales como el real. Emisión tipo faucet restringida al deployer.
///     Existe para probar depósitos/retiros/conciliación en una cadena local sin fondos reales.
contract MockUSDT is SimpleERC20 {
    address public immutable minter;

    error NotMinter();

    constructor() SimpleERC20("Mock Tether USD", "USDT", 6) {
        minter = msg.sender;
    }

    /// EN: Mints test USDT. / ES: Emite USDT de prueba.
    function mint(address to, uint256 value) external {
        if (msg.sender != minter) revert NotMinter();
        _mint(to, value);
    }
}
