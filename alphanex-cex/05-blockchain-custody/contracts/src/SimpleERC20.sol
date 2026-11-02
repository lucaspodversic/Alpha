// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// EN: Minimal, dependency-free ERC-20 used for LOCAL TEST tokens only (ANX, mock USDT).
///     Not audited; never deploy to mainnet.
/// ES: ERC-20 mínimo y sin dependencias, usado SOLO para tokens de PRUEBA locales (ANX, USDT mock).
///     No auditado; nunca desplegar en mainnet.
abstract contract SimpleERC20 {
    // EN: Standard ERC-20 metadata. / ES: Metadatos estándar ERC-20.
    string public name;
    string public symbol;
    uint8 public immutable decimals;
    uint256 public totalSupply;

    // EN: Balances and allowances. / ES: Saldos y autorizaciones.
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    // EN: Standard events (the deposit watcher listens to Transfer).
    // ES: Eventos estándar (el watcher de depósitos escucha Transfer).
    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    // EN: Custom errors are cheaper than revert strings. / ES: Los errores custom son más baratos que strings.
    error InsufficientBalance();
    error InsufficientAllowance();
    error ZeroAddress();

    constructor(string memory name_, string memory symbol_, uint8 decimals_) {
        name = name_;
        symbol = symbol_;
        decimals = decimals_;
    }

    /// EN: Moves `value` from caller to `to`. / ES: Mueve `value` del llamador a `to`.
    function transfer(address to, uint256 value) external returns (bool) {
        _transfer(msg.sender, to, value);
        return true;
    }

    /// EN: Sets allowance for `spender`. / ES: Fija la autorización para `spender`.
    function approve(address spender, uint256 value) external returns (bool) {
        allowance[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
        return true;
    }

    /// EN: Spends allowance (infinite allowance is not decremented).
    /// ES: Consume autorización (la autorización infinita no se descuenta).
    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) {
            if (allowed < value) revert InsufficientAllowance();
            allowance[from][msg.sender] = allowed - value;
        }
        _transfer(from, to, value);
        return true;
    }

    /// EN: Internal transfer with checks. / ES: Transferencia interna con controles.
    function _transfer(address from, address to, uint256 value) internal {
        if (to == address(0)) revert ZeroAddress();
        uint256 bal = balanceOf[from];
        if (bal < value) revert InsufficientBalance();
        unchecked {
            balanceOf[from] = bal - value;
        }
        balanceOf[to] += value;
        emit Transfer(from, to, value);
    }

    /// EN: Internal mint. / ES: Emisión interna.
    function _mint(address to, uint256 value) internal {
        if (to == address(0)) revert ZeroAddress();
        totalSupply += value;
        balanceOf[to] += value;
        emit Transfer(address(0), to, value);
    }
}
