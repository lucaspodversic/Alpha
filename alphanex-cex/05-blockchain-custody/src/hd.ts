/**
 * EN: HD deposit-address derivation from an EXTENDED PUBLIC KEY (xpub) only.
 *     The API process only ever sees the xpub, so a compromise of the API cannot move funds.
 *     Path convention: the xpub is the account-level node m/44'/60'/0'/0 and deposit address i
 *     is child i of it (BIP-44, same as MetaMask/viem `addressIndex`).
 * ES: Derivación HD de direcciones de depósito SOLO desde una CLAVE PÚBLICA EXTENDIDA (xpub).
 *     El proceso de la API solo ve la xpub, así que comprometer la API no permite mover fondos.
 *     Convención de ruta: la xpub es el nodo m/44'/60'/0'/0 y la dirección de depósito i es su
 *     hijo i (BIP-44, igual que MetaMask/viem `addressIndex`).
 */
import { HDKey } from '@scure/bip32';
import { secp256k1 } from '@noble/curves/secp256k1';
import { publicKeyToAddress } from 'viem/accounts';
import { bytesToHex, type Address } from 'viem';

// EN: BIP-32 non-hardened child indexes must be < 2^31. / ES: Los índices hijos no endurecidos deben ser < 2^31.
const MAX_INDEX = 0x7fffffff;

/** EN: Error for anything wrong with the xpub. / ES: Error para cualquier problema con la xpub. */
export class XpubError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'XpubError';
  }
}

/**
 * EN: Parses an xpub and REFUSES private extended keys (xprv/tprv). This is a safety guard:
 *     an operator pasting the wrong key into the API config must fail loudly.
 * ES: Parsea una xpub y RECHAZA claves privadas extendidas (xprv/tprv). Es un control de seguridad:
 *     si un operador pega la clave equivocada en la config de la API, debe fallar ruidosamente.
 */
export function parseXpub(xpub: string): HDKey {
  // EN: Fast textual check first. / ES: Primero un control textual rápido.
  if (/^[xt]prv/i.test(xpub.trim())) throw new XpubError('private extended key given; the API must only receive an xpub');
  let node: HDKey;
  try {
    node = HDKey.fromExtendedKey(xpub.trim());
  } catch (e) {
    throw new XpubError(`invalid xpub: ${(e as Error).message}`);
  }
  // EN: Defense in depth: even if the prefix was unusual, a node with a private key is rejected.
  // ES: Defensa en profundidad: aunque el prefijo sea raro, se rechaza un nodo con clave privada.
  if (node.privateKey) throw new XpubError('extended key contains a private key');
  if (!node.publicKey) throw new XpubError('xpub without public key');
  return node;
}

/**
 * EN: Derives the EVM address for deposit index `index`.
 * ES: Deriva la dirección EVM para el índice de depósito `index`.
 */
export function deriveDepositAddress(xpubOrNode: string | HDKey, index: number): Address {
  if (!Number.isInteger(index) || index < 0 || index > MAX_INDEX) throw new XpubError(`bad index ${index}`);
  const node = typeof xpubOrNode === 'string' ? parseXpub(xpubOrNode) : xpubOrNode;
  const child = node.deriveChild(index);
  if (!child.publicKey) throw new XpubError('derivation failed');
  // EN: Ethereum addresses hash the UNCOMPRESSED public key (65 bytes, 0x04 prefix).
  // ES: Las direcciones Ethereum hashean la clave pública SIN COMPRIMIR (65 bytes, prefijo 0x04).
  const uncompressed = secp256k1.ProjectivePoint.fromHex(child.publicKey).toRawBytes(false);
  return publicKeyToAddress(bytesToHex(uncompressed));
}

/**
 * EN: Convenience class caching the parsed node. / ES: Clase de conveniencia que cachea el nodo parseado.
 */
export class DepositAddressDeriver {
  private readonly node: HDKey;
  constructor(xpub: string) {
    this.node = parseXpub(xpub);
  }
  /** EN: Address for index i. / ES: Dirección para el índice i. */
  at(index: number): Address {
    return deriveDepositAddress(this.node, index);
  }
}
