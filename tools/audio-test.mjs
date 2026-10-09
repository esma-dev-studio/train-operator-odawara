/* =========================================================
 * tools/audio-test.mjs — 音響テストベンチのヘッドレス自動検証（Playwright）
 *
 * 使い方（リポジトリ直下をローカルHTTPで配信してから）:
 *   npx http-server -p 8124 -c-1 .
 *   node tools/audio-test.mjs [--url http://localhost:8124/tools/audio-test.html]
 *                             [--old 旧audio.jsのパス]   # 旧エンジンと音量比較
 *                             [--shot スクショ保存先.png]
 * 検証内容:
 *   ・console error / pageerror が0件
 *   ・AudioWorklet が読み込まれる（info.worklet === 'ready'）
 *   ・全ボタン/スライダー/チェックを操作、運転サイクル(倍速)を完走
 *   ・OfflineAudioContext で VVVF 単体スイープと運転サイクルを描画し、
 *     非同期域でピーク周波数が上昇・無音でない・クリップしない 等を判定
 * ========================================================= */
import fs from 'node:fs';

let chromium;
try { ({ chromium } = await import('playwright')); }
catch (e) { ({ chromium } = await import('/opt/node-tools/node_modules/playwright/index.mjs')); }

const arg = (name, def) => {
  const i = process.argv.indexOf('--' + name);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
};
const URL_ = arg('url', 'http://localhost:8124/tools/audio-test.html');
const OLD = arg('old', null);
const SHOT = arg('shot', null);

const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 1100 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));

await page.goto(URL_, { waitUntil: 'load' });
await page.waitForFunction(() => !!window.__bench);

/* 旧エンジン（比較用）を window.OldCabAudio として差し込む */
if (OLD) {
  const src = fs.readFileSync(OLD, 'utf8').replace(/export\s+class\s+CabAudio/, 'window.OldCabAudio = class CabAudio');
  await page.addScriptTag({ content: src });
}

const step = (t) => page.waitForTimeout(t);
const results = {};

/* 1) 起動とワークレット */
await page.click('#b-start');
results.worklet = await page.evaluate(async () => { await window.__bench.audio.ready; return window.__bench.audio.info.worklet; });
results.ctxState = await page.evaluate(() => window.__bench.audio.ctx.state);

/* 2) 全操作 */
const clicks = await page.$$eval('#ev-btns button', (bs) => bs.map((b) => b.dataset.ev));
for (const ev of clicks) { await page.click(`[data-ev="${ev}"]`); await step(120); }
for (const id of ['#b-melody', '#b-horn', '#b-announce', '#b-crossing', '#b-pass']) { await page.click(id); await step(150); }
const setRange = (sel, v) => page.$eval(sel, (el, v) => { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); }, v);
await setRange('#s-power', 4); await step(1500);
await setRange('#s-speed', 30); await step(600);
await setRange('#s-curve', 250); await step(800);
await page.check('#c-tunnel'); await step(600);
await page.check('#c-ext'); await step(400);
await page.check('#c-cross'); await setRange('#s-cross', 40); await step(600);
await page.selectOption('#sel-weather', 'rain'); await step(500);
await page.selectOption('#sel-weather', 'snow'); await step(300);
await page.check('#c-slip'); await setRange('#s-power', 0); await setRange('#s-brake', 7); await step(800);
await setRange('#s-brake', 8); await step(600);
await page.check('#c-pause'); await step(300); await page.uncheck('#c-pause');
await page.check('#c-mute'); await setRange('#s-vol', 0.5); await page.uncheck('#c-mute');
await page.click('#b-stop'); await step(300);
await page.click('#b-rebind'); await step(300);
for (const id of ['#c-tunnel', '#c-ext', '#c-cross', '#c-slip']) await page.uncheck(id);
await setRange('#s-brake', 0); await setRange('#s-curve', 1000); await page.selectOption('#sel-weather', 'clear');
await page.click('#b-melody'); await step(200);

/* 3) 運転サイクル（6倍速） */
const t0 = Date.now();
await page.evaluate(() => window.__bench.runDrive(6));
results.driveCycleSec = (Date.now() - t0) / 1000;
results.voicesAfter = await page.evaluate(() => window.__bench.audio.info.voices);

/* 4) オフライン解析 */
const rep = await page.evaluate(async () => {
  const r = await window.__bench.offlineAnalysis();
  return { checks: r.checks, sweep: r.sweep.rows, sweepPeak: r.sweep.peakAbs, nu: r.nu, fb: r.fb, old: r.old, levels: r.levels, oldLevels: r.oldLevels, life: r.life };
});
results.offline = rep;
await step(300);
if (SHOT) await page.screenshot({ path: SHOT, fullPage: true });
await browser.close();

results.errors = errors;
console.log(JSON.stringify(results, null, 1));
const failed = Object.entries(rep.checks).filter(([k, v]) => v === false).map(([k]) => k);
if (results.worklet !== 'ready') failed.push('worklet');
if (errors.length) failed.push('errors');
console.log(failed.length ? 'FAIL: ' + failed.join(', ') : 'PASS');
process.exit(failed.length ? 1 : 0);
