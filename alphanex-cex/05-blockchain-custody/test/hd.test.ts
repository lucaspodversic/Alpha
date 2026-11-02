// EN: HD derivation must match standard wallets (viem mnemonicToAccount). / ES: La derivación HD debe coincidir con wallets estándar.
import { describe, it, expect } from 'vitest';
import { HDKey } from '@scure/bip32';
import { mnemonicToSeedSync } from '@scure/bip39';
import { mnemonicToAccount } from 'viem/accounts';
import { DepositAddressDeriver, deriveDepositAddress, parseXpub, XpubError } from '../src/hd.js';

// EN: Public, well-known TEST mnemonic (anvil/hardhat default). Never holds real funds.
// ES: Mnemónico de PRUEBA público y conocido (default de anvil/hardhat). Nunca tiene fondos reales.
// EN: Public test mnemonic: lets us cross-check our derivation against viem.
// ES: Mnemónico público de prueba: permite contrastar nuestra derivación con viem.
const TEST_MNEMONIC = 'test test test test test test test test test test test junk';

function testXpub(): { xpub: string; xprv: string } {
  // EN: m/44'/60'/0'/0 is the standard Ethereum account path; children /i are the deposit addresses.
  // ES: m/44'/60'/0'/0 es la ruta estándar de cuentas Ethereum; los hijos /i son las direcciones de depósito.
  const node = HDKey.fromMasterSeed(mnemonicToSeedSync(TEST_MNEMONIC)).derive("m/44'/60'/0'/0");
  return { xpub: node.publicExtendedKey, xprv: node.privateExtendedKey };
}

describe('hd deposit addresses / direcciones de depósito HD', () => {
  it('matches viem mnemonicToAccount for indexes 0..9 / coincide con viem para índices 0..9', () => {
    const { xpub } = testXpub();
    const d = new DepositAddressDeriver(xpub);
    for (let i = 0; i < 10; i++) expect(d.at(i)).toBe(mnemonicToAccount(TEST_MNEMONIC, { addressIndex: i }).address);
  });

  it('index 0 is the known anvil account #0 / índice 0 es la cuenta #0 conocida de anvil', () => {
    expect(deriveDepositAddress(testXpub().xpub, 0)).toBe('0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266');
  });

  it('refuses private extended keys / rechaza claves privadas extendidas', () => {
    // EN: Passing an xprv by mistake must fail: private material must never reach the API.
    // ES: Pasar un xprv por error debe fallar: el material privado nunca debe llegar a la API.
    expect(() => parseXpub(testXpub().xprv)).toThrow(XpubError);
  });

  it('rejects garbage and bad indexes / rechaza basura e índices inválidos', () => {
    expect(() => parseXpub('xpub-nope')).toThrow(XpubError);
    expect(() => deriveDepositAddress(testXpub().xpub, -1)).toThrow(XpubError);
    // EN: Indexes >= 2^31 would be hardened (impossible from an xpub).
    // ES: Índices >= 2^31 serían hardened (imposible desde un xpub).
    expect(() => deriveDepositAddress(testXpub().xpub, 2 ** 31)).toThrow(XpubError);
  });
});
