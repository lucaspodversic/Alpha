/**
 * EN: Seed market definitions for the MVP: ANX/USDT and ETH/USDT.
 *     Values are chosen so tickSize * lotSize is divisible by 10^baseDecimals (exact quote math).
 * ES: Definición de mercados semilla del MVP: ANX/USDT y ETH/USDT.
 *     Los valores se eligen para que tickSize * lotSize sea divisible por 10^baseDecimals (matemática exacta).
 */
import type { MarketSpec } from './types.js';

/**
 * EN: Asset metadata shared by every package (decimals are the on-chain decimals).
 * ES: Metadatos de activos compartidos por todos los paquetes (decimales = los de la cadena).
 */
export interface AssetSpec {
  code: string;
  decimals: number;
  // EN: 'native' for ETH, 'erc20' for tokens. / ES: 'native' para ETH, 'erc20' para tokens.
  kind: 'native' | 'erc20';
  // EN: Confirmations required before crediting a deposit. / ES: Confirmaciones requeridas antes de acreditar un depósito.
  confirmations: number;
}

export const SEED_ASSETS: AssetSpec[] = [
  // EN: Test-only assets; ANX and USDT are local mock ERC-20s in 05-blockchain-custody.
  // ES: Activos solo de prueba; ANX y USDT son ERC-20 mock locales en 05-blockchain-custody.
  { code: 'USDT', decimals: 6, kind: 'erc20', confirmations: 12 },
  { code: 'ETH', decimals: 18, kind: 'native', confirmations: 12 },
  { code: 'ANX', decimals: 18, kind: 'erc20', confirmations: 12 },
];

export const SEED_MARKETS: MarketSpec[] = [
  {
    id: 'ETH-USDT',
    base: 'ETH',
    quote: 'USDT',
    baseDecimals: 18,
    quoteDecimals: 6,
    // EN: 0.01 USDT tick (1e4 units) × 0.0001 ETH lot (1e14 wei) = 1e18 ⇒ exact.
    // ES: tick de 0,01 USDT (1e4 unidades) × lote de 0,0001 ETH (1e14 wei) = 1e18 ⇒ exacto.
    tickSize: 10_000n,
    lotSize: 100_000_000_000_000n,
    minQty: 100_000_000_000_000n,
    makerFeeBps: 10n,
    takerFeeBps: 20n,
  },
  {
    id: 'ANX-USDT',
    base: 'ANX',
    quote: 'USDT',
    baseDecimals: 18,
    quoteDecimals: 6,
    // EN: 0.0001 USDT tick (1e2 units) × 0.01 ANX lot (1e16) = 1e18 ⇒ exact.
    // ES: tick de 0,0001 USDT (1e2 unidades) × lote de 0,01 ANX (1e16) = 1e18 ⇒ exacto.
    tickSize: 100n,
    lotSize: 10_000_000_000_000_000n,
    minQty: 1_000_000_000_000_000_000n,
    makerFeeBps: 10n,
    takerFeeBps: 20n,
  },
];
