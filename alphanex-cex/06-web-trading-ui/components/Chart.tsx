'use client';
/**
 * EN: Minimal SVG candlestick chart (no third-party chart lib → smaller bundle, no CSP issues).
 * ES: Gráfico de velas mínimo en SVG (sin librería externa → bundle chico, sin problemas de CSP).
 */
import type { Candle } from '@/lib/api';
import { candleGeometry } from '@/lib/chart';

// EN: Fixed viewBox; the SVG scales to the container width via CSS.
// ES: viewBox fijo; el SVG escala al ancho del contenedor por CSS.
export function Chart({ candles }: { candles: Candle[] }) {
  // EN: Logical drawing size in SVG units.
  // ES: Tamaño lógico de dibujo en unidades SVG.
  const W = 640;
  const H = 220;
  // EN: All math lives in lib/chart.ts so it can be unit-tested without a DOM.
  // ES: Toda la matemática vive en lib/chart.ts para testearla sin DOM.
  const g = candleGeometry(candles, W, H);
  return (
    <div className="panel">
      <h3 className="font-semibold mb-2">Chart / Gráfico (1m)</h3>
      {/* EN: Each candle = a wick (line high→low) plus a body (rect open↔close); green up, red down. */}
      {/* ES: Cada vela = una mecha (línea máx→mín) más un cuerpo (rect apertura↔cierre); verde sube, rojo baja. */}
      {g.length ? (
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-56">
          {g.map((c) => (
            <g key={c.time}>
              <line x1={c.x} x2={c.x} y1={c.yHigh} y2={c.yLow} stroke={c.up ? '#16c784' : '#ea3943'} />
              <rect x={c.x - c.w / 2} width={c.w} y={Math.min(c.yOpen, c.yClose)} height={Math.max(1, Math.abs(c.yOpen - c.yClose))} fill={c.up ? '#16c784' : '#ea3943'} />
            </g>
          ))}
        </svg>
      ) : (
        <p className="text-slate-500 h-56 grid place-items-center">No candles yet / Sin velas aún</p>
      )}
    </div>
  );
}
