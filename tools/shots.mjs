/* =========================================================
 * shots.mjs — 見た目の確認用に、決まった場面のスクリーンショットを一式撮る
 * (デザインの採点・改善前後の比較用)
 *
 * 使い方: (ローカルHTTPサーバを立ててから)
 *   npx http-server -p 8123 -c-1 .
 *   node tools/shots.mjs <出力フォルダ> [場面名の一部でしぼる...]
 * 環境変数: BASE(既定 http://localhost:8123) / Q=high|mid|low(既定mid) / GPU=1(実GPU)
 * 場面ごとの描画負荷(draw call・三角形・シェーダー数・影の地図のぶんの draw call)を <出力フォルダ>/calls.json に書く。
 * 場面の項目: setup / advance / approach / notch / cam / finish / arrive(停車するまで自動運転) /
 *            overrun(「8」を m すぎて止まる) / toCrossing(つぎの踏切の m 手前まで自動運転) /
 *            vp(画面サイズ) / touch / dpr(画素密度) / wait /
 *            loading(よみこみ画面: data/line.json を おくらせて、とちゅうで撮る) / fadeCard(しゅっぱつの暗転カード)
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
  /* デザイン第3回で ふやした場面 */
  { name: '32_evening_cab_up', setup: { start: 9, dir: 'up', daytime: 'evening' }, advance: 45, cam: 'cab' },
  { name: '33_night_rain_cab', setup: { start: 3, daytime: 'night', weather: 'rain' }, advance: 45, cam: 'cab' },
  /* 終点の手前(ゴールの演出で使う そらからの視点) */
  { name: '34_drone_goal', setup: { start: 21, end: 22 }, approach: 157, cam: 'drone' },
  { name: '35_drone_setagaya', setup: { start: 11 }, advance: 60, cam: 'drone' },
  /* 踏切の 60m 手前(遮断機・警報灯・待っている車) */
  { name: '36_crossing_cab', setup: { start: 18 }, toCrossing: 60, cam: 'cab' },
  { name: '37_up_cab_suburb', setup: { start: 2, dir: 'up' }, advance: 45, cam: 'cab' },
  /* iPadの 画面分割(Split View 678x1024) */
  { name: '38_ipad_split', setup: { start: 8 }, advance: 40, cam: 'cab', vp: [678, 1024], touch: true, dpr: 2 },
  /* よみこみ画面(線路データを4秒おくらせて、2秒のところで撮る) */
  { name: '39_loading', loading: { delay: 4000, at: 2000 } },
  /* しゅっぱつの暗転カード(__test.fadeCard) */
  { name: '40_fade_card', setup: { start: 9 }, fadeCard: true },
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

/* よみこみ画面だけは 新しいページで(線路データを おくらせる) */
async function shootLoading(sc) {
  for (const [k, p] of pages) { await p.context().close(); pages.delete(k); }
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`loading: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`loading: ${m.text()}`); });
  await page.route('**/data/line.json*', async (route) => {
    await new Promise((r) => setTimeout(r, sc.loading.delay));
    await route.continue();
  });
  await page.goto(`${BASE}/index.html?debug=1&q=${Q}&v=${Date.now()}`, { timeout: 180000 });
  await page.waitForTimeout(sc.loading.at);
  await page.screenshot({ path: join(out, sc.name + '.png'), timeout: 180000 });
  await ctx.close();
}

for (const sc of pick) {
  const t0 = Date.now();
  if (sc.loading) {
    await shootLoading(sc);
    console.log(`${sc.name}  ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    continue;
  }
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
    if (sc.toCrossing) {
      /* つぎの踏切(scene.crossSpots)の m 手前まで、1秒ずつ自動運転で進める */
      const r = await page.evaluate((m) => {
        const A = __test.app, S = A.scene, sim = A.sim;
        const next = (S.crossSpots || []).filter((c) => c - m > sim.pos + 5).sort((a, b) => a - b)[0];
        if (next == null) return null;
        for (let i = 0; i < 3000 && !sim.ended && sim.pos < next - m; i++) __test.advance(0.5);
        S._camPos = null;
        /* 一気に近づいたので、遮断機・警報灯を いまの位置の状態まで すすめておく(下りきった腕) */
        if (typeof S._updateCrossings === 'function') { for (let k = 0; k < 4; k++) S._updateCrossings(2); }
        return { crossing: Math.round(next), pos: Math.round(sim.pos) };
      }, sc.toCrossing);
      if (!r) errors.push(`${sc.name}: この先に踏切がない`);
    }
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
        /* スタンプがカードの中に押されるとき(#sc-stamp)は、その演出が おわるまで */
        const scs = document.querySelector('#sc-stamp');
        if (scs && !fin(scs)) return false;
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
  /* 撮る場面に置いたら、運転(sim)の時計を止める(待っているあいだに列車が進んで 場面が ずれないように。
   * 描画・計器・コーチは そのまま動く)。つぎの場面の setup で新しい運転になる */
  if (sc.setup) {
    await page.evaluate(() => {
      const sim = __test.app.sim;
      if (sim && !sim.__frozen) { sim.__frozen = true; sim.tick = function () { /* 撮影中は止める */ }; }
    });
  }
  await page.waitForTimeout(sc.wait || 2500);
  /* シェーダの準備(prewarmAsync)が まだ続いていれば 終わるまで(ソフト描画では 出発の10秒の待ちを こえることがある) */
  await page.waitForFunction(() => { const S = __test.app.scene; return !S || !S._warming; }, null, { timeout: 180000, polling: 250 })
    .catch(() => errors.push(`${sc.name}: シェーダの準備が終わらない`));
  /* 運転開始の暗転(#fade)が ソフト描画では なかなか明けないので、明けきるまで待つ */
  await page.waitForFunction(() => {
    const f = document.querySelector('#fade');
    return !f || parseFloat(getComputedStyle(f).opacity) < 0.01;
  }, null, { timeout: 30000, polling: 200 }).catch(() => errors.push(`${sc.name}: 暗転が明けない`));
  /* 画面の部品の登場アニメ・切りかえ(ブレーキめやす・「8」の目印など)が おわるまで(くりかえしのアニメは のぞく)。
   * ソフト描画では CSS の時計が おくれるので */
  await page.waitForFunction(() => document.getAnimations().every((a) => {
    const t = a.effect && a.effect.getComputedTiming ? a.effect.getComputedTiming() : null;
    return !t || t.iterations === Infinity || a.playState !== 'running';
  }), null, { timeout: 30000, polling: 250 }).catch(() => { /* 撮るだけ */ });
  if (sc.fadeCard) {
    /* しゅっぱつの暗転カードを出して撮る(撮ったら もどす) */
    const ok = await page.evaluate(() => { if (!__test.fadeCard) return false; __test.fadeCard(true); return true; });
    if (!ok) errors.push(`${sc.name}: __test.fadeCard がない`);
    await page.waitForFunction(() => {
      const f = document.querySelector('#fade');
      return !f || parseFloat(getComputedStyle(f).opacity) > 0.99;
    }, null, { timeout: 30000, polling: 200 }).catch(() => { /* noop */ });
    await page.waitForTimeout(600);
  }
  await page.screenshot({ path: join(out, sc.name + '.png'), timeout: 180000 });
  if (sc.fadeCard) await page.evaluate(() => { if (__test.fadeCard) __test.fadeCard(false); });
  /* 描画負荷: 1コマぶん(影・本描画・ポストエフェクトの合計)を数える。
   * メニューの うしろは 3フレームに1回しか描かないので、3Dを描いた回数(__test.renders)で わる */
  const info = await page.evaluate(() => new Promise((resolve) => {
    const S = __test.app.scene;
    const r = S && S.renderer;
    if (!r) { resolve(null); return; }
    /* 数えるのは実際に描いたコマ(GPUの おくれで描かなかったコマ・間引いた画面のコマは数えない) */
    const cnt = () => (typeof S.drawCount === 'number' ? S.drawCount : __test.renders ? __test.renders() : 0);
    /* 間引いて描く画面(成績票・スタンプ帳など)も1回は描かせる */
    if (__test.redraw) __test.redraw();
    const sm = r.shadowMap, smRender = sm.render;
    let shadowCalls = 0;
    requestAnimationFrame(() => {
      r.info.autoReset = false; r.info.reset();
      sm.render = function (...a) {
        const c0 = r.info.render.calls;
        const o = smRender.apply(this, a);
        shadowCalls += r.info.render.calls - c0;
        return o;
      };
      const r0 = cnt(), t0 = performance.now();
      let k = 0;
      const wait = () => {
        const n = cnt() - r0;
        /* ソフト描画ではGPUが追いつくまで描かないコマがある(scene の _paceSkip)。描くまで最大20秒待つ */
        if (n < 1 && performance.now() - t0 < 20000) { if (__test.redraw && ++k % 10 === 0) __test.redraw(); requestAnimationFrame(wait); return; }
        const d = Math.max(1, n);
        const o = { calls: Math.round(r.info.render.calls / d), triangles: Math.round(r.info.render.triangles / d),
          programs: r.info.programs ? r.info.programs.length : null, shadow: Math.round(shadowCalls / d) };
        sm.render = smRender;
        r.info.autoReset = true;
        resolve(o);
      };
      requestAnimationFrame(wait);
    });
  })).catch(() => null);
  if (info) perf[sc.name] = info;
  writeFileSync(join(out, 'calls.json'), JSON.stringify(perf, null, 1));
  console.log(`${sc.name}  ${((Date.now() - t0) / 1000).toFixed(1)}s${info ? `  calls=${info.calls} (shadow ${info.shadow}) tris=${info.triangles} prog=${info.programs}` : ''}`);
}
await browser.close();
if (errors.length) { console.error('★ エラー:\n' + [...new Set(errors)].join('\n')); process.exit(1); }
console.log('OK →', out);
