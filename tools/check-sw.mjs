/* =========================================================
 * check-sw.mjs — sw.js の CORE(オフライン用に保存するファイル)に漏れがないか確認
 * main.js から import をたどり、読み込まれる全モジュールと data/assets を CORE と突き合わせる。
 * 使い方: node tools/check-sw.mjs  (漏れがあれば一覧を出して終了コード1)
 * ========================================================= */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, relative, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const sw = readFileSync(join(root, 'sw.js'), 'utf8');
const core = new Set([...sw.matchAll(/'\.\/([^']+)'/g)].map((m) => normalize(m[1])));

const seen = new Set();
const walk = (rel) => {
  rel = normalize(rel);
  if (seen.has(rel)) return;
  seen.add(rel);
  const src = readFileSync(join(root, rel), 'utf8');
  const deps = [
    ...[...src.matchAll(/(?:import|export)[^'"]*?from\s*['"](\.[^'"]+)['"]/g)].map((m) => m[1]),
    ...[...src.matchAll(/import\(\s*['"](\.[^'"]+)['"]\s*\)/g)].map((m) => m[1]),
    ...[...src.matchAll(/new URL\(\s*['"](\.[^'"]+)['"]\s*,\s*import\.meta\.url\)/g)].map((m) => m[1]),
  ];
  deps.forEach((d) => { const p = relative(root, join(root, dirname(rel), d)); if (p.endsWith('.js')) walk(p); });
};
walk('main.js');
/* JSから参照される静的ファイル(./data/・./assets/) */
const assets = new Set();
seen.forEach((f) => {
  const src = readFileSync(join(root, f), 'utf8');
  [...src.matchAll(/['"`]\.\/((?:data|assets)\/[^'"`]+)['"`]/g)].forEach((m) => assets.add(normalize(m[1])));
});
['index.html', 'styles.css', 'manifest.webmanifest'].forEach((f) => assets.add(f));

const missing = [...seen, ...assets].filter((f) => !core.has(f));
const stale = [...core].filter((f) => f !== '.' && !existsSync(join(root, f)));
console.log(`モジュール ${seen.size} / 静的ファイル ${assets.size} / CORE ${core.size}`);
if (stale.length) console.log('CORE にあるが存在しない:', stale.join(', '));
if (missing.length) { console.error('★ CORE に足りない:', missing.join(', ')); process.exit(1); }
console.log('OK');
