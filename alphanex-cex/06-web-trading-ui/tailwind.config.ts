// EN: Tailwind config (dark exchange theme). / ES: Config de Tailwind (tema oscuro de exchange).
import type { Config } from 'tailwindcss';

const config: Config = {
  // EN: Files scanned for class names (unused CSS is purged).
  // ES: Archivos escaneados en busca de clases (el CSS no usado se elimina).
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // EN: Buy = green, sell = red. / ES: Compra = verde, venta = rojo.
        bid: '#16c784',
        ask: '#ea3943',
        // EN: Panel background and border colors.
        // ES: Colores de fondo y borde de los paneles.
        panel: '#11161f',
        edge: '#1f2733',
      },
    },
  },
  plugins: [],
};
export default config;
