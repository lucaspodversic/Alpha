/**
 * EN: Chart of accounts. Account codes are structured strings so every balance is
 *     self-describing and grep-able in SQL:
 *       user:<userId>:<ASSET>:available   — spendable user funds              (liability, credit-normal)
 *       user:<userId>:<ASSET>:locked      — held for open orders               (liability, credit-normal)
 *       user:<userId>:<ASSET>:withdrawing — reserved for pending withdrawals   (liability, credit-normal)
 *       fees:<ASSET>                      — trading/withdrawal fee revenue     (revenue,   credit-normal)
 *       custody:<wallet>:<ASSET>          — on-chain funds (hot/cold/deposits) (asset,     debit-normal)
 *       expense:gas:<ASSET>               — network fees paid by the venue     (expense,   debit-normal)
 *       equity:<name>:<ASSET>             — manual adjustments / seed capital  (equity,    credit-normal, may go negative)
 * ES: Plan de cuentas. Los códigos son strings estructurados para que cada saldo se describa solo
 *     y se pueda buscar en SQL:
 *       user:<userId>:<ACTIVO>:available   — fondos disponibles del usuario     (pasivo, saldo acreedor)
 *       user:<userId>:<ACTIVO>:locked      — retenidos por órdenes abiertas     (pasivo, saldo acreedor)
 *       user:<userId>:<ACTIVO>:withdrawing — reservados para retiros pendientes (pasivo, saldo acreedor)
 *       fees:<ACTIVO>                      — ingresos por comisiones            (ingreso, saldo acreedor)
 *       custody:<wallet>:<ACTIVO>          — fondos on-chain (hot/cold/depósito)(activo, saldo deudor)
 *       expense:gas:<ACTIVO>               — fees de red pagados por el exchange (gasto, saldo deudor)
 *       equity:<nombre>:<ACTIVO>           — ajustes manuales / capital semilla (patrimonio, acreedor, puede ser negativo)
 */

export type NormalSide = 'debit' | 'credit';
export type UserBucket = 'available' | 'locked' | 'withdrawing';

/**
 * EN: Properties derived from an account code.
 * ES: Propiedades derivadas de un código de cuenta.
 */
export interface AccountSpec {
  code: string;
  asset: string;
  ownerType: 'user' | 'fees' | 'custody' | 'expense' | 'equity';
  ownerId: string | null;
  normalSide: NormalSide;
  allowNegative: boolean;
}

// EN: Asset codes and ids are restricted to safe characters (no ':' injection into codes).
// ES: Códigos de activos e ids se restringen a caracteres seguros (sin inyectar ':' en los códigos).
const SAFE = /^[A-Za-z0-9_.-]+$/;
function safe(part: string, what: string): string {
  if (!SAFE.test(part)) throw new Error(`invalid ${what}: "${part}"`);
  return part;
}

// EN: Builders keep code formatting in one place. / ES: Los builders centralizan el formato de los códigos.
export const userAccount = (userId: string, asset: string, bucket: UserBucket) =>
  `user:${safe(userId, 'userId')}:${safe(asset, 'asset')}:${bucket}`;
export const feeAccount = (asset: string) => `fees:${safe(asset, 'asset')}`;
export const custodyAccount = (wallet: string, asset: string) => `custody:${safe(wallet, 'wallet')}:${safe(asset, 'asset')}`;
export const gasExpenseAccount = (asset: string) => `expense:gas:${safe(asset, 'asset')}`;
export const equityAccount = (name: string, asset: string) => `equity:${safe(name, 'name')}:${safe(asset, 'asset')}`;

/**
 * EN: Parses an account code into its spec. Unknown shapes are rejected (fail closed).
 * ES: Parsea un código de cuenta a su spec. Formas desconocidas se rechazan (falla cerrado).
 */
export function parseAccount(code: string): AccountSpec {
  const p = code.split(':');
  switch (p[0]) {
    case 'user':
      if (p.length === 4 && ['available', 'locked', 'withdrawing'].includes(p[3]!)) {
        return { code, asset: p[2]!, ownerType: 'user', ownerId: p[1]!, normalSide: 'credit', allowNegative: false };
      }
      break;
    case 'fees':
      if (p.length === 2) return { code, asset: p[1]!, ownerType: 'fees', ownerId: null, normalSide: 'credit', allowNegative: false };
      break;
    case 'custody':
      if (p.length === 3) return { code, asset: p[2]!, ownerType: 'custody', ownerId: p[1]!, normalSide: 'debit', allowNegative: false };
      break;
    case 'expense':
      if (p.length === 3) return { code, asset: p[2]!, ownerType: 'expense', ownerId: p[1]!, normalSide: 'debit', allowNegative: false };
      break;
    case 'equity':
      if (p.length === 3) return { code, asset: p[2]!, ownerType: 'equity', ownerId: p[1]!, normalSide: 'credit', allowNegative: true };
      break;
  }
  throw new Error(`unknown account code: ${code}`);
}
