// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// EN: Legacy AlphaNex P2P escrow (ETH, single verifier), recreated from the job description
///     to document its migration. In the CEX, custody moves to exchange wallets + ledger, so this
///     contract gains a one-way `retire()` switch: no NEW escrows, but every open escrow can still
///     be released or refunded (users never get stuck).
/// ES: Escrow P2P heredado de AlphaNex (ETH, un solo verificador), recreado desde el aviso para
///     documentar su migración. En el CEX la custodia pasa a wallets del exchange + ledger, así que
///     este contrato suma un interruptor `retire()` sin vuelta: no hay escrows NUEVOS, pero todo
///     escrow abierto se puede liberar o reembolsar (los usuarios nunca quedan trabados).
contract P2PEscrow {
    // EN: Escrow lifecycle. / ES: Ciclo de vida del escrow.
    enum Status {
        None,
        Funded,
        Released,
        Refunded
    }

    struct Escrow {
        address seller; // EN: crypto seller who locks ETH / ES: vendedor que bloquea ETH
        address buyer; // EN: fiat payer who receives ETH / ES: pagador fiat que recibe ETH
        uint256 amount; // EN: wei locked / ES: wei bloqueados
        uint64 deadline; // EN: after this the seller may refund / ES: pasado esto el vendedor puede reembolsar
        Status status;
    }

    // EN: Off-chain verifier that confirms fiat payment (single point of trust in the MVP).
    // ES: Verificador off-chain que confirma el pago fiat (único punto de confianza del MVP).
    address public immutable verifier;
    bool public retired;
    uint256 public nextId = 1;
    mapping(uint256 => Escrow) public escrows;

    event Funded(uint256 indexed id, address indexed seller, address indexed buyer, uint256 amount, uint64 deadline);
    event Released(uint256 indexed id);
    event Refunded(uint256 indexed id);
    event Retired();

    error NotVerifier();
    error Retired_();
    error BadState();
    error TooEarly();
    error BadParams();
    error TransferFailed();

    constructor(address verifier_) {
        if (verifier_ == address(0)) revert BadParams();
        verifier = verifier_;
    }

    /// EN: Seller locks ETH for `buyer` until `deadline`. Disabled after retirement.
    /// ES: El vendedor bloquea ETH para `buyer` hasta `deadline`. Deshabilitado tras el retiro.
    function fund(address buyer, uint64 deadline) external payable returns (uint256 id) {
        if (retired) revert Retired_();
        if (buyer == address(0) || msg.value == 0 || deadline <= block.timestamp) revert BadParams();
        id = nextId++;
        escrows[id] = Escrow(msg.sender, buyer, msg.value, deadline, Status.Funded);
        emit Funded(id, msg.sender, buyer, msg.value, deadline);
    }

    /// EN: Verifier confirms fiat was paid ⇒ ETH goes to the buyer. Checks-effects-interactions.
    /// ES: El verificador confirma el pago fiat ⇒ el ETH va al comprador. Checks-effects-interactions.
    function release(uint256 id) external {
        if (msg.sender != verifier) revert NotVerifier();
        Escrow storage e = escrows[id];
        if (e.status != Status.Funded) revert BadState();
        e.status = Status.Released;
        emit Released(id);
        _send(e.buyer, e.amount);
    }

    /// EN: After the deadline the seller (or the verifier at any time) can refund to the seller.
    /// ES: Pasado el plazo el vendedor (o el verificador en cualquier momento) puede reembolsar al vendedor.
    function refund(uint256 id) external {
        Escrow storage e = escrows[id];
        if (e.status != Status.Funded) revert BadState();
        if (msg.sender != verifier) {
            if (msg.sender != e.seller) revert NotVerifier();
            if (block.timestamp < e.deadline) revert TooEarly();
        }
        e.status = Status.Refunded;
        emit Refunded(id);
        _send(e.seller, e.amount);
    }

    /// EN: One-way switch used during the CEX migration. / ES: Interruptor sin vuelta usado en la migración al CEX.
    function retire() external {
        if (msg.sender != verifier) revert NotVerifier();
        retired = true;
        emit Retired();
    }

    /// EN: ETH transfer that bubbles failure. / ES: Transferencia de ETH que propaga el fallo.
    function _send(address to, uint256 amount) private {
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert TransferFailed();
    }
}
