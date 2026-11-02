#!/usr/bin/env node
/**
 * EN: Comment-density gate. For each package it counts NON-BLANK source lines and lines that are
 *     comments (full-line comments; trailing comments are reported separately and NOT counted toward
 *     the gate, to stay conservative). Fails (exit 1) if any package is below --min percent.
 *     Vendored code (forge-std), build output and node_modules are excluded.
 *     Usage: node 07-ops/scripts/comment-density.mjs [--min 25]
 * ES: Control de densidad de comentarios. Por paquete cuenta líneas de código NO vacías y líneas que
 *     son comentarios (comentarios de línea completa; los comentarios al final de línea se informan
 *     aparte y NO cuentan para el control, para ser conservadores). Falla (exit 1) si algún paquete
 *     queda por debajo de --min por ciento. Se excluye código vendorizado (forge-std), salidas de build y node_modules.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, extname, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

// EN: Repo root = two levels above this script. / ES: Raíz del repo = dos niveles arriba de este script.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const argMin = process.argv.indexOf('--min');
const MIN = argMin > 0 ? Number(process.argv[argMin + 1]) : 25;

// EN: Packages = top-level numbered folders. / ES: Paquetes = carpetas numeradas de primer nivel.
const PACKAGES = readdirSync(ROOT).filter((d) => /^0[2-7]-/.test(d));
const EXT = new Set(['.ts', '.tsx', '.mjs', '.sol', '.sql']);
const SKIP = new Set(['node_modules', '.next', 'out', 'cache', 'dist', 'artifacts', 'broadcast', '.git']);

/** EN: Recursively yields source files. / ES: Recorre recursivamente archivos fuente. */
function* walk(dir) {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    // EN: Skip vendored Solidity deps (contracts/lib = forge-std) but NOT app code in other lib/ folders.
    // ES: Omitir dependencias Solidity incluidas (contracts/lib = forge-std) pero NO código propio en otras carpetas lib/.
    if (name === 'lib' && basename(dir) === 'contracts') continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) yield* walk(p);
    else if (EXT.has(extname(name)) && !name.endsWith('.d.ts')) yield p;
  }
}

/**
 * EN: Classifies lines. Tracks /* ... *\/ blocks; "--" comments only for SQL.
 * ES: Clasifica líneas. Sigue bloques /* ... *\/; comentarios "--" solo en SQL.
 */
function count(file) {
  const sql = file.endsWith('.sql');
  let inBlock = false;
  let code = 0;
  let comment = 0;
  let trailing = 0;
  for (const raw of readFileSync(file, 'utf8').split('\n')) {
    const l = raw.trim();
    if (!l) continue;
    code++;
    if (inBlock) {
      comment++;
      if (l.includes('*/')) inBlock = false;
      continue;
    }
    if (l.startsWith('//') || (sql && l.startsWith('--')) || l.startsWith('{/*')) {
      comment++;
      continue;
    }
    if (l.startsWith('/*')) {
      comment++;
      if (!l.includes('*/')) inBlock = true;
      continue;
    }
    // EN: Trailing `code // note` comments are reported but not counted as comment lines.
    // ES: Los comentarios al final (`código // nota`) se informan pero no cuentan como líneas de comentario.
    if (/\s\/\/\s/.test(l) || (sql && /\s--\s/.test(l))) trailing++;
  }
  return { code, comment, trailing };
}

let failed = false;
const rows = [];
for (const pkg of PACKAGES) {
  const t = { files: 0, code: 0, comment: 0, trailing: 0 };
  for (const f of walk(join(ROOT, pkg))) {
    const c = count(f);
    t.files++;
    t.code += c.code;
    t.comment += c.comment;
    t.trailing += c.trailing;
  }
  if (!t.files) continue;
  const pct = (100 * t.comment) / t.code;
  // EN: Any package below the threshold makes CI fail (exit code 1).
  // ES: Cualquier paquete bajo el umbral hace fallar el CI (código de salida 1).
  if (pct < MIN) failed = true;
  rows.push({ package: pkg, files: t.files, lines: t.code, commentLines: t.comment, trailingComments: t.trailing, pct: pct.toFixed(1) + '%', ok: pct >= MIN });
}
console.table(rows);
console.log(failed ? `FAIL: some package < ${MIN}% / algún paquete < ${MIN}%` : `OK: all packages ≥ ${MIN}% / todos ≥ ${MIN}%`);
// EN: Report the root too (relative path for clarity). / ES: Informar la raíz también.
console.log('root:', relative(process.cwd(), ROOT) || '.');
process.exit(failed ? 1 : 0);
