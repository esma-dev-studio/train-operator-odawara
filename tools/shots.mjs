/* =========================================================
 * shots.mjs — 見た目の確認用に、決まった場面のスクリーンショットを一式撮る
 * (デザインの採点・改善前後の比較用)
 *
 * 使い方: (ローカルHTTPサーバを立ててから)
 *   npx http-server -p 8123 -c-1 .
 *   node tools/shots.mjs <出力フォルダ> [場面名の一部でしぼる...]
 * 環境変数: BASE(既定 http://localhost:8123) / Q=high|mid|low(既定mid) / GPU=1(実GPU)
 * 場面ごとの描画負荷(draw call・三角形・シェーダー数)を <出力フォルダ>/calls.json に書く。
 * 場面の項目: setup / advance / approach / notch / cam / finish / arrive(停車するまで自動運転) /
 *            overrun(「8」を m すぎて止まる) / vp(画面サイズ) / touch / dpr(画素密度) / wait
 * ========================================================= */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

let chromium;
try { ({ chromium } = await import('playwright')); } catch (e) {
  ({ chromium } = await import('/opt/node-tools/node_modules/playwright/index.mjs'));
}

const [out = 'shots', ...filters] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const BASE = process.env.BASE || 'http://localhost:8123';
const Q = process.env.Q || 'mid';

/* 各停の停車駅番号(くだり): 0新宿 2参宮橋 5東北沢 8梅ヶ丘 10経堂 12祖師ヶ谷大蔵 13成城学園前
 * 16和泉多摩川 17登戸 18向ヶ丘遊園 19生田 21百合ヶ丘 22新百合ヶ丘 */
const SCENES = [
  { name: '01_title', screen: 'title', wait: 4000 },
  { name: '02_select', screen: 'select' },
  { name: '03_cab_terminal', setup: { start: 0 }, cam: 'cab' },
  { name: '04_cab_city', setup: { start: 2 }, advance: 45, cam: 'cab' },
  { name: '05_cab_brakeguide', setup: { start: 9 }, approach: 170, notch: -3, cam: 'cab' },
  { name: '06_cab_station_stop', setup: { start: 12 }, cam: 'cab' },
  { name: '07_chase_suburb', setup: { start: 18 }, advance: 70, cam: 'chase' },
  { name: '08_side_suburb', setup: { start: 18 }, advance: 70, cam: 'side' },
  { name: '09_front_city', setup: { start: 2 }, advance: 50, cam: 'front', wait: 3500 },
  { name: '10_drone_city', setup: { start: 1 }, advance: 35, cam: 'drone' },
  { name: '11_river_side', setup: { start: 16 }, advance: 32, cam: 'side' },
  { name: '12_tunnel_cab', setup: { start: 5 }, advance: 22, cam: 'cab' },
  { name: '13_evening_cab', setup: { start: 10, daytime: 'evening' }, advance: 45, cam: 'cab' },
  { name: '14_evening_chase', setup: { start: 10, daytime: 'evening' }, advance: 45, cam: 'chase' },
  { name: '15_night_cab', setup: { start: 3, daytime: 'night' }, advance: 45, cam: 'cab' },
  { name: '16_night_station', setup: { start: 13, daytime: 'night' }, cam: 'cab' },
  { name: '17_rain_cab', setup: { start: 8, weather: 'rain' }, advance: 40, cam: 'cab' },
  { name: '18_snow_cab', setup: { start: 19, weather: 'snow' }, advance: 45, cam: 'cab' },
  { name: '19_snow_side', setup: { start: 19, weather: 'snow' }, advance: 45, cam: 'side' },
  { name: '20_up_terminal_arrival', setup: { start: 21, dir: 'up' }, approach: 140, cam: 'cab' },
  { name: '21_result', setup: { start: 9, end: 10 }, finish: true, wait: 3500 },
  { name: '22_stamps', screen: 'stamps', after: '21_result' },
  { name: '23_ipad_portrait', setup: { start: 8 }, advance: 40, cam: 'cab', vp: [768, 1024], touch: true, dpr: 2 },
  { name: '24_phone_landscape', setup: { start: 8 }, advance: 40, cam: 'cab', vp: [844, 390], touch: true },
  { name: '25_ipad_landscape', setup: { start: 8 }, advance: 40, cam: 'cab', vp: [1180, 820], touch: true, dpr: 2 },
  { name: '26_stop_card', setup: { start: 9, end: 11 }, approach: 120, arrive: true, cam: 'cab', wait: 900 },
  { name: '27_tunnel_portal', setup: { start: 4 }, advance: 26, cam: 'cab' },
  { name: '28_drone_tunnel', setup: { start: 4 }, advance: 30, cam: 'drone' },
  { name: '29_night_chase_suburb', setup: { start: 18, daytime: 'night' }, advance: 70, cam: 'chase' },
  /* 「8」を 15m すぎて 止まった: いきすぎパネル(暗い幕・やりなおす/このまま つぎの駅へ) */
  { name: '30_overrun', setup: { start: 9, end: 11 }, approach: 120, overrun: 15.2, cam: 'cab', wait: 1500 },
  /* iPadの たて: 列車えらび(じかん・天気・出発が 下のパネルに 見えているか) */
  { name: '31_select_portrait', screen: 'select', vp: [768, 1024], touch: true, dpr: 2 },
];

const pick = filters.length ? SCENES.filter((s) => filters.some((f) => s.name.includes(f))) : SCENES;
const args = process.env.GPU ? ['--enable-gpu', '--ignore-gpu-blocklist'] : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'];
const browser = await chromium.launch({ args: [...args, '--autoplay-policy=no-user-gesture-required'] });
const pages = new Map();
const errors = [];
const perf = {};

async function pageFor(vp = [1280, 800], touch = false, dpr = 1) {
  const key = vp.join('x') + (touch ? 't' : '') + (dpr !== 1 ? `@${dpr}x` : '');
  if (pages.has(key)) return pages.get(key);
  /* 別サイズのページを開く前に、前のページを閉じる(裏で描画し続けてCPUを取り合うため) */
  for (const [k, p] of pages) { await p.context().close(); pages.delete(k); }
  const ctx = await browser.newContext({ viewport: { width: vp[0], height: vp[1] }, deviceScaleFactor: dpr, hasTouch: touch });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${key}: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`${key}: ${m.text()}`); });
  await page.goto(`${BASE}/index.html?debug=1&q=${Q}&v=${Date.now()}`, { timeout: 180000 });
  await page.waitForFunction(() => window.__test && __test.app.mode === 'title', null, { timeout: 180000 });
  pages.set(key, page);
  return page;
}

for (const sc of pick) {
  const t0 = Date.now();
  const page = await pageFor(sc.vp, sc.touch, sc.dpr || 1);
  if (sc.screen === 'title') {
    await page.evaluate(() => { const a = __test.app; if (a.mode !== 'title') a.go('title'); });
  } else if (sc.screen === 'select') {
    await page.evaluate(() => { __test.app.renderSvcCards(); __test.app.renderRoute(); __test.app.go('select'); });
  } else if (sc.screen === 'stamps') {
    await page.evaluate(() => __test.app.go('stamps'));
  } else if (sc.setup) {
    const cfg = { service: 'local', weather: 'clear', daytime: 'day', dir: 'down', ...sc.setup };
    await page.evaluate((c) => __test.setup(c), cfg);
    await page.waitForTimeout(800);
    if (sc.advance) await page.evaluate((s) => __test.advance(s), sc.advance);
    if (sc.approach) await page.evaluate((m) => __test.approach(m), sc.approach);
    if (sc.notch != null) await page.evaluate((n) => __test.app.sim.setNotch(n), sc.notch);
    if (sc.cam) await page.evaluate((m) => __test.cam(m), sc.cam);
    if (sc.overrun) {
      const r = await page.evaluate((m) => (__test.overrun ? __test.overrun(m) : null), sc.overrun);
      if (!r || !r.overrun) errors.push(`${sc.name}: いきすぎパネルが出なかった`);
      /* パネルの登場アニメが おわるまで待つ(ソフト描画では CSSアニメの時計が おくれる) */
      await page.waitForFunction(() => {
        const el = document.querySelector('.ov-card');
        return !el || !el.getAnimations || el.getAnimations().every((x) => x.playState === 'finished');
      }, null, { timeout: 60000, polling: 250 }).catch(() => errors.push(`${sc.name}: いきすぎパネルの表示待ちが時間切れ`));
    }
    if (sc.arrive) {
      /* 自動運転で「8」に止めて、停止位置の判定カードを出す。
       * ソフト描画では1コマが遅く、実時間の自動運転では なかなか止まらないので、描画を待たずに進める */
      const r = await page.evaluate(() => (__test.arrive ? __test.arrive() : null));
      if (!r) {
        await page.evaluate(() => { __test.fast(3); __test.auto(true); });
        await page.waitForFunction(() => __test.app.sim.doorOpen, null, { timeout: 180000 }).catch(() => errors.push(`${sc.name}: 停車しなかった`));
        await page.evaluate(() => { __test.fast(1); __test.auto(false); });
      }
      /* ソフト描画では 1コマが数秒かかり、CSSアニメの時計が進まない(タイマーだけ進む)。
       * 判定カードとスタンプの登場アニメが おわるまで待ち、撮るまで スタンプ・くんしょうを出しっぱなし/止めておく */
      await page.waitForFunction(() => {
        const a = __test.app, pop = document.querySelector('#stamp-pop');
        const showing = !!pop && pop.classList.contains('go') && !pop.classList.contains('hidden');
        if (showing) { clearTimeout(a._stampT); clearTimeout(a._popT); }
        const fin = (el) => !el || !el.getAnimations || el.getAnimations().every((x) => x.playState === 'finished');
        if (!fin(document.querySelector('#stop-card'))) return false;
        if (!showing && a._popBusy) return false;   // スタンプの順番待ち
        return !showing || fin(document.querySelector('#stamp-pop-cv'));
      }, null, { timeout: 90000, polling: 250 }).catch(() => errors.push(`${sc.name}: 判定カードの表示待ちが時間切れ`));
    }
    if (sc.finish) {
      await page.evaluate(() => __test.advance(900));
      await page.waitForFunction(() => __test.app.mode === 'result', null, { timeout: 120000 }).catch(() => errors.push('result not reached'));
      /* 成績票の じゅんばんに出る演出(ランクのはんこ・棒グラフ)が おわるまで待つ(ソフト描画ではCSSアニメが遅れる) */
      await page.waitForFunction(() => {
        const rk = document.querySelector('#res-rank'), bar = document.querySelector('.rb-bar i');
        if (!rk || !rk.classList.contains('pop') || (bar && !bar.style.transform)) return false;
        return [...document.querySelectorAll('#screen-result *')]
          .every((el) => !el.getAnimations || el.getAnimations().every((a) => a.playState === 'finished'));
      }, null, { timeout: 90000, polling: 250 }).catch(() => errors.push(`${sc.name}: 成績票の演出待ちが時間切れ`));
    }
  }
  await page.waitForTimeout(sc.wait || 2500);
  /* 運転開始の暗転(#fade)が ソフト描画では なかなか明けないので、明けきるまで待つ */
  await page.waitForFunction(() => {
    const f = document.querySelector('#fade');
    return !f || parseFloat(getComputedStyle(f).opacity) < 0.01;
  }, null, { timeout: 30000, polling: 200 }).catch(() => errors.push(`${sc.name}: 暗転が明けない`));
  await page.screenshot({ path: join(out, sc.name + '.png'), timeout: 180000 });
  /* 描画負荷: 1コマぶん(影・本描画・ポストエフェクトの合計)を数える */
  const info = await page.evaluate(() => new Promise((resolve) => {
    const r = __test.app.scene && __test.app.scene.renderer;
    if (!r) { resolve(null); return; }
    requestAnimationFrame(() => {
      r.info.autoReset = false; r.info.reset();
      requestAnimationFrame(() => {
        const o = { calls: r.info.render.calls, triangles: r.info.render.triangles, programs: r.info.programs ? r.info.programs.length : null };
        r.info.autoReset = true;
        resolve(o);
      });
    });
  })).catch(() => null);
  if (info) perf[sc.name] = info;
  writeFileSync(join(out, 'calls.json'), JSON.stringify(perf, null, 1));
  console.log(`${sc.name}  ${((Date.now() - t0) / 1000).toFixed(1)}s${info ? `  calls=${info.calls} tris=${info.triangles} prog=${info.programs}` : ''}`);
}
await browser.close();
if (errors.length) { console.error('★ エラー:\n' + [...new Set(errors)].join('\n')); process.exit(1); }
console.log('OK →', out);
