/**
 * EN: Reconciliation: on-chain balances we control vs. what the ledger says we custody.
 *     Invariant: onchain(asset) == ledger custody(asset) (+ in-flight withdrawals not yet mined).
 *     - deficit (onchain < ledger): money missing ⇒ CRITICAL, freeze withdrawals.
 *     - surplus (onchain > ledger): unattributed deposit, dust or gas top-up ⇒ WARN, investigate.
 * ES: Conciliación: saldos on-chain que controlamos vs. lo que el ledger dice que custodiamos.
 *     Invariante: onchain(activo) == custodia del ledger(activo) (+ retiros en vuelo aún no minados).
 *     - déficit (onchain < ledger): falta dinero ⇒ CRÍTICO, congelar retiros.
 *     - excedente (onchain > ledger): depósito sin atribuir, polvo o recarga de gas ⇒ AVISO, investigar.
 */
import type { Address } from 'viem';
import type { ChainReader, WatchedAsset } from './chain.js';

export type ReconStatus = 'ok' | 'surplus' | 'deficit';

/** EN: One row per asset. / ES: Una fila por activo. */
export interface ReconLine {
  asset: string;
  onchain: bigint;
  ledger: bigint;
  inFlight: bigint;
  diff: bigint;
  status: ReconStatus;
}

export interface ReconReport {
  at: string;
  ok: boolean;
  lines: ReconLine[];
}

/**
 * EN: Sums balances of all our addresses per asset. / ES: Suma saldos de todas nuestras direcciones por activo.
 */
export async function onchainTotals(chain: ChainReader, addresses: readonly Address[], assets: readonly WatchedAsset[]): Promise<Record<string, bigint>> {
  const out: Record<string, bigint> = {};
  for (const a of assets) {
    let sum = 0n;
    for (const addr of addresses) sum += await chain.getBalance(addr, a);
    out[a.code] = sum;
  }
  return out;
}

/**
 * EN: Pure comparison. `tolerance` absorbs dust (e.g. gas rounding on native).
 *     diff = onchain + inFlight - ledger, where inFlight = withdrawals already broadcast (funds have
 *     left the chain) but not yet marked complete in the ledger (which still counts them).
 * ES: Comparación pura. `tolerance` absorbe polvo (p. ej. redondeo de gas en nativo).
 *     diff = onchain + enVuelo - ledger, donde enVuelo = retiros ya difundidos (los fondos salieron
 *     de la cadena) pero aún no completados en el ledger (que todavía los cuenta).
 */
export function reconcile(
  onchain: Record<string, bigint>,
  ledgerCustody: Record<string, bigint>,
  opts: { inFlight?: Record<string, bigint>; tolerance?: Record<string, bigint>; now?: Date } = {},
): ReconReport {
  const assets = [...new Set([...Object.keys(onchain), ...Object.keys(ledgerCustody)])].sort();
  const lines: ReconLine[] = assets.map((asset) => {
    const oc = onchain[asset] ?? 0n;
    const lg = ledgerCustody[asset] ?? 0n;
    const fl = opts.inFlight?.[asset] ?? 0n;
    const tol = opts.tolerance?.[asset] ?? 0n;
    const diff = oc + fl - lg;
    const status: ReconStatus = diff < -tol ? 'deficit' : diff > tol ? 'surplus' : 'ok';
    return { asset, onchain: oc, ledger: lg, inFlight: fl, diff, status };
  });
  return { at: (opts.now ?? new Date()).toISOString(), ok: lines.every((l) => l.status !== 'deficit'), lines };
}
