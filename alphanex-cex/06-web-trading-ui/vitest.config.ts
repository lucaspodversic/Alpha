// EN: Unit tests for pure helpers (no browser needed). / ES: Tests unitarios de helpers puros (sin navegador).
import { defineConfig } from 'vitest/config';
// EN: Node environment: the tested helpers (decimal, chart) never touch the DOM.
// ES: Entorno Node: los helpers testeados (decimal, chart) nunca tocan el DOM.
export default defineConfig({ test: { include: ['test/**/*.test.ts'], environment: 'node' } });
