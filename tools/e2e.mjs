/* =========================================================
 * e2e.mjs — ブラウザでの通し確認(ヘッドレスChromium + Playwright)
 * タイトル → 列車えらび → 短い区間を自動運転 → 成績票 まで進め、
 * 各画面のスクリーンショットと、コンソールエラーが無いことを確認する。
 * つづけて: 「8」を大きく行きすぎた → 「もういちど とめる(すこし もどる)」で 180m 手前から止めなおす流れ、
 * WebGLの文脈が消えた → もどる(一時停止のまま 同じ位置で 描画が再開する)、
 * 最後に 長い処理(long task, 250ms以上)の記録を出す(ソフト描画では GPU待ちも ふくむ)。
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
const bad = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(`${e.message}\n${e.stack}`));
const shot = (name) => page.screenshot({ path: join(out, name + '.png'), timeout: 120000 });
const step = (s) => console.log('・' + s);
/* 長い処理(long task)の記録。場面(phase)ごとに */
await page.addInitScript(() => {
  window.__lt = [];
  window.__ltPhase = 'boot';
  try {
    new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__lt.push([window.__ltPhase, Math.round(e.duration)]); })
      .observe({ type: 'longtask', buffered: true });
  } catch (e) { /* 古いブラウザ */ }
});
const phase = (n) => page.evaluate((x) => { window.__ltPhase = x; }, n);

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

await phase('first-start');
await page.click('#btn-start');
await page.waitForFunction(() => __test.app.mode === 'drive' && __test.app.running, null, { timeout: 120000 });
await page.waitForTimeout(1500);
await shot('3_drive');
step('運転開始');

/* 上の帯(大型HUD・路線・してん/ポーズ)が どの画面サイズでも かさならず、上のはしと高さが そろっているか */
const layoutBad = [];
for (const [w, h] of [[1280, 800], [1024, 768], [1180, 820], [768, 1024], [844, 390], [390, 844]]) {
  await page.setViewportSize({ width: w, height: h });
  await page.waitForTimeout(400);
  const r = await page.evaluate(() => {
    const R = (s) => { const e = document.querySelector(s); if (!e) return null; const b = e.getBoundingClientRect(); return { x: b.left, y: b.top, w: b.width, h: b.height, r: b.right, b: b.bottom }; };
    const els = { bighud: R('#bighud'), head: R('#drive-head'), cam: R('#btn-cam'), pause: R('#btn-pause-touch') };
    const wrap = R('#gl-wrap'), top = R('.hud-top');
    const v = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--hud-top-h'));
    return { els, wrapY: wrap.y, topB: top.b, v, vw: innerWidth };
  });
  const names = Object.keys(r.els);
  for (let i = 0; i < names.length; i++) {
    for (let j = i + 1; j < names.length; j++) {
      const a = r.els[names[i]], b = r.els[names[j]];
      const ox = Math.min(a.r, b.r) - Math.max(a.x, b.x), oy = Math.min(a.b, b.b) - Math.max(a.y, b.y);
      if (ox > 0.5 && oy > 0.5) layoutBad.push(`${w}x${h}: ${names[i]} と ${names[j]} が かさなる`);
    }
  }
  /* 1だんめ(大型HUD と ボタン)は 上と高さが おなじ。広い画面は 路線も おなじ だん */
  const row = [r.els.bighud, r.els.cam, r.els.pause];
  if (w > 860) row.push(r.els.head);
  for (const e of row) {
    if (Math.abs(e.y - row[0].y) > 1 || Math.abs(e.h - row[0].h) > 1) layoutBad.push(`${w}x${h}: 上の帯の 高さ/位置が そろわない (${JSON.stringify(row.map((x) => [Math.round(x.y), Math.round(x.h)]))})`);
  }
  for (const e of Object.values(r.els)) if (e.x < -0.5 || e.r > r.vw + 0.5) layoutBad.push(`${w}x${h}: 画面の そとに はみ出す`);
  const barH = r.topB - r.wrapY;
  if (barH > r.v + 0.5) layoutBad.push(`${w}x${h}: 帯(${Math.round(barH)}px)が --hud-top-h(${r.v}px)より 下まで ある`);
  if (h <= 540 && barH > 52) layoutBad.push(`${w}x${h}: 横スマホの 帯が 52px より 高い (${Math.round(barH)}px)`);
  console.log(`  ${w}x${h}: 帯 ${Math.round(barH)}px / --hud-top-h ${r.v}px`);
}
await page.setViewportSize({ width: W, height: H });
await page.waitForTimeout(300);
step(`上の帯の レイアウト確認: かさなり・ずれ ${layoutBad.length}件`);

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

await phase('menus');
await page.click('#btn-res-select');
await page.click('#btn-back-title');
await page.click('#btn-to-stamps');
await page.waitForTimeout(800);
await shot('5_stamps');
step('スタンプ帳');

/* ---- 「8」を 15m 行きすぎて止まった → もういちど とめる(すこし もどる) ----
 * 1駅目は ふつうに止め、2駅目で行きすぎる。やりなおしても 1駅目の点数は のこり、
 * 「とちゅうから やりなおした」あつかい(きろくに のこらない)にも ならない */
await phase('retry');
await page.evaluate(() => __test.setup({ service: 'local', start: 8, end: 10 }));
await page.waitForFunction(() => __test.app.mode === 'drive' && __test.app.running, null, { timeout: 120000 });
const ov = await page.evaluate(() => {
  const A = __test.app, sim = A.sim;
  sim.skipDwell();
  __test.advance(8);   // ドアが しまって 走りだすまで
  const first = __test.arrive();
  sim.skipDwell();
  __test.approach(120);
  const r = __test.overrun(15.2);
  return { first, overrun: r, stops: sim.score.stops.length, hasRetry: typeof sim.retryApproach === 'function', wired: typeof A._retryApproach === 'function' };
});
await page.waitForTimeout(800);
if (!ov.overrun || !ov.overrun.overrun) bad.push('いきすぎパネルが出ない');
await shot('6_overrun');
if (ov.hasRetry && ov.wired) {
  await page.click('#btn-overrun-retry');
  await page.waitForFunction(() => !__test.app._overrun, null, { timeout: 30000 }).catch(() => { /* noop */ });
  await page.waitForTimeout(1200);
  const af = await page.evaluate(() => {
    const A = __test.app, sim = A.sim, st = sim.stops[sim.stopIdx];
    return { back: Math.round(st.stopAt - sim.pos), stops: sim.score.stops.length, retried: !!A._retried, v: sim.v, door: sim.doorOpen };
  });
  step(`もういちど とめる: 「8」の ${af.back}m 手前 / いままでの駅 ${af.stops} / やりなおし扱い ${af.retried}`);
  if (Math.abs(af.back - 180) > 2) bad.push(`やりなおしの位置が 180m 手前でない (${af.back}m)`);
  if (af.stops !== ov.stops) bad.push(`やりなおしで 前の駅の点数が きえた (${ov.stops} → ${af.stops})`);
  if (af.retried) bad.push('やりなおしが「とちゅうから やりなおした」あつかいになった');
  await shot('7_retry');
  await page.evaluate(() => { __test.auto(true); __test.fast(20); });
  await page.waitForFunction(() => __test.app.mode === 'result', null, { timeout: 600000 });
  await page.waitForTimeout(1500);
  const rr = await page.evaluate(() => ({
    text: document.querySelector('#screen-result').textContent,
    stops: __test.app.sim.score.stops.map((x) => ({ name: x.name, retry: !!x.retry })),
  }));
  step(`やりなおしたあとの成績票: ${rr.stops.map((x) => x.name + (x.retry ? '(やりなおし)' : '')).join(' / ')}`);
  if (/きろくに\s*のこらない/.test(rr.text)) bad.push('成績票に「きろくに のこらない」が出た');
  if (rr.stops.length !== 2 || !rr.stops[1].retry) bad.push('やりなおした駅に retry の しるしがない');
  await shot('8_retry_result');
} else {
  step(`もういちど とめる: ${ov.hasRetry ? 'ボタンの配線(main.js の _retryApproach)がまだ' : 'エンジンに retryApproach がない'} → この確認はとばす`);
  await page.evaluate(() => { const A = __test.app; if (A._setOverrun) A._setOverrun(false); });
}

/* ---- WebGLの文脈が消えた → もどる ---- */
await phase('lose-gl');
await page.evaluate(() => { if (__test.app.mode !== 'drive') __test.go('title'); });
await page.evaluate(() => __test.setup({ service: 'local', start: 10, end: 12 }));
await page.waitForFunction(() => __test.app.mode === 'drive' && __test.app.running, null, { timeout: 120000 });
await page.waitForTimeout(800);
const guard = await page.evaluate(() => !!__test.app._glGuard);
if (guard) {
  const g0 = await page.evaluate(() => {
    const A = __test.app;
    A.sim.skipDwell(); __test.advance(20);
    const pos = A.sim.pos, d0 = A.scene.drawCount || 0;
    let ok = false;
    if (__test.loseGL) ok = __test.loseGL() !== false;
    else {
      const gl = A.scene.renderer.getContext(), ext = gl.getExtension('WEBGL_lose_context');
      if (ext) { ext.loseContext(); setTimeout(() => ext.restoreContext(), 500); ok = true; }
    }
    window.__glT0 = performance.now();
    return { pos, d0, ok, scene: A.scene.drawCount };
  });
  if (!g0.ok) bad.push('WEBGL_lose_context が使えない');
  /* 消えたことに気づいて 一時停止した ところの位置 */
  await page.waitForFunction(() => __test.app._glLost || (__test.app._glGuard && __test.app._glGuard.n > 0), null, { timeout: 30000, polling: 50 })
    .catch(() => bad.push('文脈が消えたことに気づかない'));
  g0.pos = await page.evaluate(() => __test.app.sim.pos);
  /* 新しいステージ(scene)が 準備を終えて 1コマ描いたら 立ちなおり(一時停止中なので そのあとは描かない) */
  await page.waitForFunction(() => {
    const A = __test.app;
    return !A._glLost && A.scene && !A.scene.glLost && !A.scene._warming && (A.scene.drawCount || 0) >= 1;
  }, null, { timeout: 180000, polling: 250 }).catch(() => bad.push('文脈が消えたあと 描画が もどらない'));
  const g1 = await page.evaluate(() => {
    const A = __test.app;
    const fade = document.querySelector('#fade');
    return { pos: A.sim.pos, paused: !!A.paused, ms: Math.round(performance.now() - window.__glT0), fade: fade.classList.contains('on'), lost: !!A._glLost };
  });
  step(`文脈が消えた → もどった: ${(g1.ms / 1000).toFixed(1)}秒 / 一時停止 ${g1.paused} / 位置のずれ ${Math.abs(g1.pos - g0.pos).toFixed(2)}m`);
  if (!g1.paused) bad.push('文脈が もどったあと 一時停止に なっていない');
  if (Math.abs(g1.pos - g0.pos) > 1) bad.push('文脈が もどったあと 位置が ずれた');
  await page.waitForTimeout(1200);
  await shot('9_after_lose_gl');
  await page.evaluate(() => __test.app.setPaused(false));
} else {
  step('文脈の消失: ui/glguard.js の配線(main.js)がまだ → この確認はとばす');
}

/* ---- 長い処理の記録 ---- */
const lt = await page.evaluate(() => window.__lt || []);
const by = {};
lt.forEach(([p, d]) => { (by[p] = by[p] || []).push(d); });
console.log('長い処理(long task)の記録 (ms, 大きい順。ソフト描画では GPU待ちも ふくむ):');
Object.keys(by).forEach((k) => {
  const a = by[k].sort((x, y) => y - x);
  console.log(`  ${k.padEnd(12)} ${a.length}回 最大${a[0]} / ${a.slice(0, 6).join(', ')}`);
});

await browser.close();
console.log('スクリーンショット:', out);
if (errors.length) { console.error('★ コンソールエラー:\n' + errors.join('\n')); process.exit(1); }
if (layoutBad.length) { console.error('★ 上の帯の レイアウト:\n' + layoutBad.join('\n')); process.exit(1); }
if (Number(res.stops) !== 2) { console.error('★ 停車駅数が想定外'); process.exit(1); }
if (bad.length) { console.error('★ ' + bad.join('\n★ ')); process.exit(1); }
console.log('OK');
