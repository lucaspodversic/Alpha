/**
 * EN: Pure geometry for the candle chart (tested). Floats are OK here: display only.
 * ES: Geometría pura del gráfico de velas (testeada). Los floats están bien aquí: solo visual.
 */
import type { Candle } from './api';

// EN: One candle in pixel coordinates (SVG y grows downwards).
// ES: Una vela en coordenadas de píxeles (en SVG la y crece hacia abajo).
export interface CandleBox {
  time: number;
  x: number;
  w: number;
  yOpen: number;
  yClose: number;
  yHigh: number;
  yLow: number;
  up: boolean;
}

export function candleGeometry(candles: Candle[], width: number, height: number, pad = 8): CandleBox[] {
  if (!candles.length) return [];
  const hi = Math.max(...candles.map((c) => Number(c.high)));
  const lo = Math.min(...candles.map((c) => Number(c.low)));
  // EN: Flat range → center line. / ES: Rango plano → línea centrada.
  const range = hi - lo || 1;
  // EN: Map price → y: high prices near the top, keeping `pad` pixels of margin.
  // ES: Mapear precio → y: precios altos arriba, dejando `pad` píxeles de margen.
  const y = (v: string) => pad + (1 - (Number(v) - lo) / range) * (height - 2 * pad);
  // EN: Equal-width slots; the body takes 60% of the slot (min 1 px).
  // ES: Ranuras de igual ancho; el cuerpo ocupa el 60% de la ranura (mínimo 1 px).
  const step = width / candles.length;
  return candles.map((c, i) => ({
    time: c.time,
    x: step * i + step / 2,
    w: Math.max(1, step * 0.6),
    yOpen: y(c.open),
    yClose: y(c.close),
    yHigh: y(c.high),
    yLow: y(c.low),
    up: Number(c.close) >= Number(c.open),
  }));
}
