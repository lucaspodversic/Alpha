// EN: Signer policy tests. / ES: Tests de la política del firmante.
import { describe, it, expect } from 'vitest';
import { parseTransaction, recoverTransactionAddress, decodeFunctionData, erc20Abi, getAddress, type Address } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { EnvKeyProvider, KmsKeyProvider, PolicyError, WithdrawalSigner, policyFromEnv, type SignRequest, type SignerPolicy } from '../src/signer.js';
import { signPayload, canonicalJson, verifyPayload } from '../src/hmac.js';

// EN: Random per-run test key and secret: nothing hardcoded. / ES: Clave y secreto aleatorios por corrida: nada hardcodeado.
// EN: Fresh random key and HMAC secret per run: nothing secret is committed.
// ES: Clave y secreto HMAC aleatorios por corrida: nada secreto queda en el repo.
const PK = generatePrivateKey();
const SECRET = 'x'.repeat(16) + Math.random().toString(36).padEnd(20, '0');
const USDT = '0x5FbDB2315678afecb367f032d93F642f64180aa3' as Address;
const DEST = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';

// EN: Test policy: local chain ids only, 2 approvals, per-tx and daily caps.
// ES: Política de prueba: solo chain ids locales, 2 aprobaciones, topes por tx y diarios.
const policy: SignerPolicy = {
  hmacSecret: SECRET,
  allowedChainIds: [31337],
  minApprovals: 2,
  maxSkewMs: 60_000,
  assets: {
    ETH: { kind: 'native', perTxMax: 10n ** 18n, dailyMax: 2n * 10n ** 18n },
    USDT: { kind: 'erc20', contract: USDT, perTxMax: 1_000_000_000n, dailyMax: 1_500_000_000n },
  },
};

let n = 0;
function req(over: Partial<SignRequest> = {}): SignRequest {
  return {
    withdrawalId: `w${n++}`,
    asset: 'ETH',
    to: DEST,
    amount: '1000',
    chainId: 31337,
    nonce: 0,
    gas: '21000',
    maxFeePerGas: '2000000000',
    maxPriorityFeePerGas: '1000000000',
    requestedBy: 'u1',
    approvals: ['admin1', 'admin2'],
    timestamp: Date.now(),
    ...over,
  };
}
const mk = () => new WithdrawalSigner(new EnvKeyProvider({ HOT_WALLET_PRIVATE_KEY: PK }), policy);
// EN: Maps a sign() result to 'ok' or the refusal code, to assert policy decisions compactly.
// ES: Convierte el resultado de sign() en 'ok' o el código de rechazo, para verificar la política de forma compacta.
const code = async (p: Promise<unknown>) => {
  try {
    await p;
    return 'ok';
  } catch (e) {
    return e instanceof PolicyError ? e.code : (e as Error).message;
  }
};

describe('hmac', () => {
  it('canonical JSON is key-order independent / el JSON canónico no depende del orden', () => {
    expect(canonicalJson({ b: 1, a: [2, { d: 1, c: 2 }] })).toBe(canonicalJson({ a: [2, { c: 2, d: 1 }], b: 1 }));
    // EN: bigint is refused: amounts must travel as decimal strings to be canonical.
    // ES: bigint se rechaza: los montos deben viajar como strings decimales para ser canónicos.
    expect(() => canonicalJson({ a: 1n })).toThrow();
  });
  it('verify rejects tampering / verify rechaza alteraciones', () => {
    const s = signPayload(SECRET, { a: 1 });
    expect(verifyPayload(SECRET, { a: 1 }, s)).toBe(true);
    expect(verifyPayload(SECRET, { a: 2 }, s)).toBe(false);
    expect(verifyPayload(SECRET, { a: 1 }, 'zz')).toBe(false);
  });
});

describe('WithdrawalSigner', () => {
  it('signs a valid native withdrawal recoverable to the hot key / firma un retiro nativo válido', async () => {
    const r = req();
    const out = await mk().sign(r, signPayload(SECRET, r));
    const tx = parseTransaction(out.rawTx);
    expect(getAddress(tx.to!)).toBe(DEST);
    expect(tx.value).toBe(1000n);
    // EN: The signature recovers to the hot wallet address derived from the env key.
    // ES: La firma recupera la dirección de la hot wallet derivada de la clave del env.
    expect(await recoverTransactionAddress({ serializedTransaction: out.rawTx as `0x02${string}` })).toBe(privateKeyToAccount(PK).address);
  });

  it('encodes ERC-20 transfer calldata / codifica calldata de transfer ERC-20', async () => {
    const r = req({ asset: 'USDT', amount: '5000000', gas: '65000' });
    const out = await mk().sign(r, signPayload(SECRET, r));
    const tx = parseTransaction(out.rawTx);
    expect(getAddress(tx.to!)).toBe(USDT);
    // EN: For ERC-20 the tx goes to the TOKEN contract and the recipient/amount live in calldata.
    // ES: Para ERC-20 la tx va al contrato del TOKEN y destinatario/monto viajan en el calldata.
    const dec = decodeFunctionData({ abi: erc20Abi, data: tx.data! });
    expect(dec.functionName).toBe('transfer');
    expect(dec.args[1]).toBe(5_000_000n);
  });

  it('enforces every policy rule / aplica cada regla de política', async () => {
    const s = mk();
    const t = (r: SignRequest, sig = signPayload(SECRET, r)) => code(s.sign(r, sig));
    // EN: One assertion per rule: HMAC, freshness, chain id, asset, destination, approvals, amount, caps.
    // ES: Una aserción por regla: HMAC, frescura, chain id, activo, destino, aprobaciones, monto, topes.
    expect(await t(req(), 'f'.repeat(64))).toBe('bad_hmac');
    expect(await t(req({ timestamp: Date.now() - 120_000 }))).toBe('stale');
    expect(await t(req({ chainId: 1 }))).toBe('chain');
    expect(await t(req({ asset: 'DOGE' }))).toBe('asset');
    expect(await t(req({ to: '0x0000000000000000000000000000000000000000' }))).toBe('to');
    expect(await t(req({ approvals: ['admin1'] }))).toBe('approvals');
    // EN: Duplicates and the requester's own approval do not count.
    // ES: Duplicados y la aprobación del propio solicitante no cuentan.
    expect(await t(req({ approvals: ['admin1', 'admin1'] }))).toBe('approvals');
    expect(await t(req({ approvals: ['u1', 'admin1'] }))).toBe('approvals');
    expect(await t(req({ amount: '-5' }))).toBe('amount');
    expect(await t(req({ amount: String(2n * 10n ** 18n) }))).toBe('per_tx_cap');
  });

  it('blocks replays and daily cap overflow / bloquea replays y exceso de tope diario', async () => {
    const s = mk();
    const r1 = req({ amount: String(10n ** 18n) });
    expect(await code(s.sign(r1, signPayload(SECRET, r1)))).toBe('ok');
    // EN: Same withdrawal id again → replay (the signer remembers what it signed).
    // ES: Mismo id de retiro otra vez → replay (el firmante recuerda lo que firmó).
    expect(await code(s.sign(r1, signPayload(SECRET, r1)))).toBe('replay');
    const r2 = req({ amount: String(10n ** 18n), nonce: 1 });
    expect(await code(s.sign(r2, signPayload(SECRET, r2)))).toBe('ok');
    const r3 = req({ amount: '1', nonce: 2 });
    // EN: 1 + 1 ETH already signed today; even 1 wei more exceeds the 2 ETH daily cap.
    // ES: Ya se firmaron 1 + 1 ETH hoy; incluso 1 wei más supera el tope diario de 2 ETH.
    expect(await code(s.sign(r3, signPayload(SECRET, r3)))).toBe('daily_cap');
  });

  it('key providers fail safely / los proveedores de clave fallan de forma segura', async () => {
    await expect(new EnvKeyProvider({}).getAccount()).rejects.toThrow(/missing or malformed/);
    // EN: The KMS provider is a stub that fails closed until a real KMS/HSM is wired.
    // ES: El proveedor KMS es un stub que falla cerrado hasta conectar un KMS/HSM real.
    await expect(new KmsKeyProvider('k1').getAccount()).rejects.toThrow(/not configured/);
    expect(() => new WithdrawalSigner(new EnvKeyProvider({}), { ...policy, minApprovals: 1 })).toThrow(/two-person/);
  });

  it('policyFromEnv parses assets and refuses mainnet / policyFromEnv parsea activos y rechaza mainnet', () => {
    const p = policyFromEnv({ SIGNER_HMAC_SECRET: SECRET, SIGNER_ASSETS: `ETH:native::100:200,USDT:erc20:${USDT}:1:2` });
    expect(p.assets.USDT!.contract).toBe(USDT);
    expect(p.allowedChainIds).toEqual([31337, 11155111]);
    // EN: Mainnet (chain id 1) is refused by configuration.
    // ES: Mainnet (chain id 1) se rechaza desde la configuración.
    expect(() => policyFromEnv({ SIGNER_ALLOWED_CHAIN_IDS: '1' })).toThrow(/refused/);
  });
});
