/**
 * EN: End-to-end custody flow against a LOCAL anvil node (spawned on 127.0.0.1, random port):
 *     deploy mock USDT → deposit to HD addresses → watcher credits after confirmations →
 *     real reorg via evm_snapshot/evm_revert orphans a pending deposit → signer signs a
 *     withdrawal → broadcast → reconciliation. Skipped automatically if anvil/forge are missing.
 * ES: Flujo de custodia de punta a punta contra un nodo anvil LOCAL (lanzado en 127.0.0.1, puerto
 *     aleatorio): desplegar USDT mock → depositar a direcciones HD → el watcher acredita tras
 *     confirmaciones → reorg real con evm_snapshot/evm_revert deja huérfano un depósito pendiente →
 *     el firmante firma un retiro → difusión → conciliación. Se omite si faltan anvil/forge.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, createTestClient, createWalletClient, http, parseEther, bytesToHex, type Address, type Hex } from 'viem';
import { mnemonicToAccount } from 'viem/accounts';
import { foundry } from 'viem/chains';
import { HDKey } from '@scure/bip32';
import { mnemonicToSeedSync } from '@scure/bip39';
import { DepositAddressDeriver } from '../src/hd.js';
import { ViemChainReader, type WatchedAsset } from '../src/chain.js';
import { DepositWatcher, InMemoryWatcherStore, type DepositRecord } from '../src/watcher.js';
import { EnvKeyProvider, WithdrawalSigner } from '../src/signer.js';
import { signPayload } from '../src/hmac.js';
import { onchainTotals, reconcile } from '../src/reconcile.js';

// EN: Public anvil TEST mnemonic; the chain is ephemeral and local. / ES: Mnemónico de PRUEBA público de anvil; cadena efímera y local.
// EN: Anvil's PUBLIC well-known test mnemonic: its keys hold value only on a local dev chain.
// ES: Mnemónico de prueba PÚBLICO y conocido de Anvil: sus claves solo tienen valor en una cadena local.
const TEST_MNEMONIC = 'test test test test test test test test test test test junk';
const here = dirname(fileURLToPath(import.meta.url));
const contractsDir = join(here, '..', 'contracts');

/** EN: Finds a foundry binary on PATH or ~/.foundry/bin. / ES: Busca un binario de foundry en PATH o ~/.foundry/bin. */
// EN: Look for Foundry binaries on PATH or in ~/.foundry/bin; if missing, the suite is skipped (not failed).
// ES: Buscar los binarios de Foundry en el PATH o en ~/.foundry/bin; si faltan, la suite se omite (no falla).
function findBin(name: string): string | null {
  const r = spawnSync('which', [name], { encoding: 'utf8' });
  if (r.status === 0 && r.stdout.trim()) return r.stdout.trim();
  const p = join(homedir(), '.foundry', 'bin', name);
  return existsSync(p) ? p : null;
}
const ANVIL = findBin('anvil');
const FORGE = findBin('forge');
const suite = ANVIL && FORGE ? describe : describe.skip;

suite('anvil integration (local only) / integración con anvil (solo local)', () => {
  // EN: Random local port so parallel runs do not collide; always 127.0.0.1.
  // ES: Puerto local aleatorio para que corridas paralelas no choquen; siempre 127.0.0.1.
  const port = 20000 + Math.floor(Math.random() * 20000);
  const rpc = `http://127.0.0.1:${port}`;
  let anvil: ChildProcess;
  const chain = { ...foundry, rpcUrls: { default: { http: [rpc] } } };
  const pub = createPublicClient({ chain, transport: http(rpc), pollingInterval: 50 });
  const test = createTestClient({ chain, mode: 'anvil', transport: http(rpc) });
  const funder = mnemonicToAccount(TEST_MNEMONIC, { addressIndex: 0 });
  const hot = mnemonicToAccount(TEST_MNEMONIC, { addressIndex: 1 });
  const wallet = createWalletClient({ chain, transport: http(rpc), account: funder, pollingInterval: 50 });
  let usdt: Address;

  beforeAll(async () => {
    // EN: Compile contracts (offline; solc must already be cached). / ES: Compilar contratos (offline; solc ya en caché).
    // EN: Compile contracts offline (forge-std is vendored), then start a throwaway Anvil node.
    // ES: Compilar contratos offline (forge-std está incluido), luego levantar un nodo Anvil descartable.
    const b = spawnSync(FORGE!, ['build', '--offline'], { cwd: contractsDir, encoding: 'utf8' });
    if (b.status !== 0) throw new Error(`forge build failed: ${b.stderr}`);
    anvil = spawn(ANVIL!, ['--host', '127.0.0.1', '--port', String(port), '--silent'], { stdio: 'ignore' });
    // EN: Wait until RPC answers. / ES: Esperar a que el RPC responda.
    for (let i = 0; i < 100; i++) {
      try {
        await pub.getBlockNumber();
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    const art = JSON.parse(readFileSync(join(contractsDir, 'out', 'MockUSDT.sol', 'MockUSDT.json'), 'utf8'));
    // EN: Deploy MockUSDT and mint to the funder so we can test ERC-20 deposits too.
    // ES: Desplegar MockUSDT y emitir al financiador para probar también depósitos ERC-20.
    const hash = await wallet.deployContract({ abi: art.abi, bytecode: art.bytecode.object as Hex });
    usdt = (await pub.waitForTransactionReceipt({ hash })).contractAddress!;
    const mint = await wallet.writeContract({ address: usdt, abi: art.abi, functionName: 'mint', args: [funder.address, 1_000_000_000n] });
    await pub.waitForTransactionReceipt({ hash: mint });
  }, 60_000);

  afterAll(() => {
    anvil?.kill('SIGTERM');
  });

  it('deposits → confirmations → reorg → withdrawal → reconciliation', async () => {
    const xpub = HDKey.fromMasterSeed(mnemonicToSeedSync(TEST_MNEMONIC)).derive("m/44'/60'/0'/0").publicExtendedKey;
    // EN: Deposit addresses are derived from the xpub only (as in production).
    // ES: Las direcciones de depósito se derivan solo del xpub (como en producción).
    const d = new DepositAddressDeriver(xpub);
    const alice = d.at(10);
    const bob = d.at(11);
    const assets: (WatchedAsset & { confirmations: number })[] = [
      { code: 'ETH', kind: 'native', confirmations: 3 },
      { code: 'USDT', kind: 'erc20', contract: usdt, confirmations: 3 },
    ];
    const credited: DepositRecord[] = [];
    const orphaned: DepositRecord[] = [];
    const sink = {
      addressBook: async () => new Map([[alice.toLowerCase(), 'alice'], [bob.toLowerCase(), 'bob']]),
      onConfirmed: async (r: DepositRecord) => void credited.push(r),
      onOrphaned: async (r: DepositRecord) => void orphaned.push(r),
      onCriticalReorg: async () => {
        throw new Error('unexpected critical reorg');
      },
    };
    // EN: Real JSON-RPC reader against Anvil: same code path the API watcher uses.
    // ES: Lector JSON-RPC real contra Anvil: el mismo camino de código que usa el watcher de la API.
    const start = (await pub.getBlockNumber()) + 1n;
    const watcher = new DepositWatcher({ chain: new ViemChainReader(rpc), sink, store: new InMemoryWatcherStore(), assets, startBlock: start });

    // EN: Two deposits. / ES: Dos depósitos.
    await pub.waitForTransactionReceipt({ hash: await wallet.sendTransaction({ to: alice, value: parseEther('1') }) });
    const art = JSON.parse(readFileSync(join(contractsDir, 'out', 'MockUSDT.sol', 'MockUSDT.json'), 'utf8'));
    await pub.waitForTransactionReceipt({ hash: await wallet.writeContract({ address: usdt, abi: art.abi, functionName: 'transfer', args: [bob, 250_000_000n] }) });
    let r = await watcher.poll();
    // EN: Step 1: an ETH and a USDT deposit are seen but wait for confirmations.
    // ES: Paso 1: se ven un depósito ETH y uno USDT pero esperan confirmaciones.
    expect(r.seen).toBe(2);
    expect(credited.length).toBe(0); // EN: not enough confirmations yet / ES: aún faltan confirmaciones
    await test.mine({ blocks: 3 });
    r = await watcher.poll();
    expect(credited.map((c) => `${c.userId}:${c.asset}:${c.amount}`).sort()).toEqual(['alice:ETH:1000000000000000000', 'bob:USDT:250000000']);

    // EN: Real reorg: snapshot, deposit, observe as pending, revert, mine a different branch.
    // ES: Reorg real: snapshot, depositar, verlo pendiente, revertir, minar otra rama.
    // EN: Step 2: snapshot → send 5 ETH → revert to the snapshot = a real reorg on Anvil.
    // ES: Paso 2: snapshot → enviar 5 ETH → volver al snapshot = un reorg real en Anvil.
    const snap = await test.snapshot();
    await pub.waitForTransactionReceipt({ hash: await wallet.sendTransaction({ to: alice, value: parseEther('5') }) });
    r = await watcher.poll();
    expect(r.seen).toBe(1);
    await test.revert({ id: snap });
    await test.mine({ blocks: 2 });
    r = await watcher.poll();
    expect(r.reorgDepth).toBeGreaterThanOrEqual(1);
    expect(orphaned.length).toBe(1);
    await test.mine({ blocks: 5 });
    await watcher.poll();
    expect(credited.length).toBe(2); // EN: the 5 ETH never got credited / ES: los 5 ETH nunca se acreditaron

    // EN: Withdrawal: fund hot wallet with USDT, signer signs, we broadcast. / ES: Retiro: fondear hot wallet, firmar y difundir.
    await pub.waitForTransactionReceipt({ hash: await wallet.writeContract({ address: usdt, abi: art.abi, functionName: 'transfer', args: [hot.address, 100_000_000n] }) });
    // EN: Step 3: withdrawal signed by the policy signer (random HMAC secret, hot key = test account #1).
    // ES: Paso 3: retiro firmado por el firmante con política (secreto HMAC aleatorio, clave hot = cuenta de prueba #1).
    const secret = bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
    const hotPk = bytesToHex(hot.getHdKey().privateKey!);
    const signer = new WithdrawalSigner(new EnvKeyProvider({ HOT_WALLET_PRIVATE_KEY: hotPk }), {
      hmacSecret: secret,
      allowedChainIds: [31337],
      minApprovals: 2,
      maxSkewMs: 60_000,
      assets: { USDT: { kind: 'erc20', contract: usdt, perTxMax: 50_000_000n, dailyMax: 100_000_000n } },
    });
    const dest = mnemonicToAccount(TEST_MNEMONIC, { addressIndex: 5 }).address;
    const fees = await pub.estimateFeesPerGas();
    const req = {
      withdrawalId: 'wd-1',
      asset: 'USDT',
      to: dest,
      amount: '40000000',
      chainId: 31337,
      nonce: await pub.getTransactionCount({ address: hot.address }),
      gas: '80000',
      maxFeePerGas: fees.maxFeePerGas!.toString(),
      maxPriorityFeePerGas: fees.maxPriorityFeePerGas!.toString(),
      requestedBy: 'alice',
      approvals: ['admin-1', 'admin-2'],
      timestamp: Date.now(),
    };
    const signed = await signer.sign(req, signPayload(secret, req));
    const txHash = await pub.sendRawTransaction({ serializedTransaction: signed.rawTx });
    // EN: The node computes the same hash the signer predicted: what we audited is what got sent.
    // ES: El nodo calcula el mismo hash que predijo el firmante: lo auditado es lo que se envió.
    expect(txHash).toBe(signed.txHash);
    const rec = await pub.waitForTransactionReceipt({ hash: txHash });
    expect(rec.status).toBe('success');
    const reader = new ViemChainReader(rpc);
    expect(await reader.getBalance(dest, assets[1]!)).toBe(40_000_000n);

    // EN: Reconcile deposit addresses vs. what the "ledger" credited. / ES: Conciliar direcciones de depósito vs. lo que el "ledger" acreditó.
    // EN: Step 4: reconciliation of on-chain balances vs. the expected ledger custody totals.
    // ES: Paso 4: conciliación de saldos on-chain contra los totales de custodia esperados del ledger.
    const totals = await onchainTotals(reader, [alice, bob], assets);
    const rep = reconcile(totals, { ETH: parseEther('1'), USDT: 250_000_000n });
    expect(rep.ok).toBe(true);
    expect(rep.lines.every((l) => l.status === 'ok')).toBe(true);
  }, 60_000);
});
