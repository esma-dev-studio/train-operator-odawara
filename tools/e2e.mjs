/* =========================================================
 * e2e.mjs — ブラウザでの通し確認(ヘッドレスChromium + Playwright)
 * タイトル → 列車えらび → 短い区間を自動運転 → 成績票 まで進め、
 * 各画面のスクリーンショットと、コンソールエラーが無いことを確認する。
 *
 * 使い方: (ローカルHTTPサーバを立ててから)
 *   npx http-server -p 8123 -c-1 .
 *   node tools/e2e.mjs [http://localhost:8123] [出力フォルダ]
 * 環境変数: Q=high|mid|low(画質・既定low) / GPU=1(実GPUで描画) / W,H(画面サイズ)
 * ========================================================= */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let chromium;
try { ({ chromium } = await import('playwright')); } catch (e) {
  ({ chromium } = await import('/opt/node-tools/node_modules/playwright/index.mjs'));
}

const base = process.argv[2] || 'http://localhost:8123';
const out = process.argv[3] || join(tmpdir(), 'trainop-e2e');
mkdirSync(out, { recursive: true });
const W = Number(process.env.W || 1280), H = Number(process.env.H || 800);
const args = process.env.GPU ? ['--enable-gpu', '--ignore-gpu-blocklist'] : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'];
const browser = await chromium.launch({ args: [...args, '--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(`${e.message}\n${e.stack}`));
const shot = (name) => page.screenshot({ path: join(out, name + '.png'), timeout: 120000 });
const step = (s) => console.log('・' + s);

await page.goto(`${base}/index.html?debug=1&q=${process.env.Q || 'low'}`);
await page.waitForFunction(() => window.__test && window.__test.app.mode === 'title', null, { timeout: 120000 });
step('タイトル表示');
await page.waitForTimeout(2500);
await shot('1_title');

await page.click('#btn-to-select');
await page.waitForTimeout(500);
/* 各駅停車・くだり: 梅ヶ丘(8) → 経堂(10) の2駅 */
const row = (i) => page.locator('#route-list .rt').nth(i);
await row(8).click();
await row(10).click();
await page.waitForTimeout(300);
await shot('2_select');
step('列車えらび(区間指定)');

await page.click('#btn-start');
await page.waitForFunction(() => __test.app.mode === 'drive' && __test.app.running, null, { timeout: 60000 });
await page.waitForTimeout(1500);
await shot('3_drive');
step('運転開始');

await page.evaluate(() => { __test.app.sim.skipDwell(); __test.auto(true); __test.fast(40); });
await page.waitForFunction(() => __test.app.mode === 'result', null, { timeout: 600000 });
await page.waitForTimeout(2000);
await shot('4_result');
const res = await page.evaluate(() => ({
  total: document.querySelector('#res-total').textContent,
  rank: document.querySelector('#res-rank').textContent,
  stops: document.querySelectorAll('#res-stops tr').length - 1,
}));
step(`成績票: ${res.total}点 ランク${res.rank} 停車${res.stops}駅`);

await page.click('#btn-res-select');
await page.click('#btn-back-title');
await page.click('#btn-to-stamps');
await page.waitForTimeout(800);
await shot('5_stamps');
step('スタンプ帳');

await browser.close();
console.log('スクリーンショット:', out);
if (errors.length) { console.error('★ コンソールエラー:\n' + errors.join('\n')); process.exit(1); }
if (Number(res.stops) !== 2) { console.error('★ 停車駅数が想定外'); process.exit(1); }
console.log('OK');
