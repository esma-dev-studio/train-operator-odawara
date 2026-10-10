/* =========================================================
 * check-cab-layout.mjs — 運転台パネル(#cab)のレイアウト確認(Playwright)
 * 画面サイズごとに運転画面を開き、次を確かめる:
 *   ・ノッチの13段(.nt)がぜんぶマスコン(.cab-mascon)の中に見えている(1pxまで)
 *   ・EB(ひじょう)の段の高さ: 12px以上(タッチ端末は下の表のとおり)
 *   ・レバーの持ち手がマスコンの中におさまり、いまのノッチの段とそろっている
 *   ・速度計のキャンバスの解像度 = round(表示幅 × min(2, devicePixelRatio))
 *   ・#cab の子(各ブロック)が横にはみ出していない
 *   ・#touch-btns(タッチ用ボタン)がマスコンに重ならない
 * 段の高さの下限: iPad縦(768x1024) 18px / iPad横(1180x820) 14px / 横向きスマホ 7px(13段すべて見えること) / ほか 12px
 *
 * 使い方: (ローカルHTTPサーバを立ててから)
 *   npx http-server -p 8123 -c-1 .
 *   node tools/check-cab-layout.mjs [http://localhost:8123]
 * 失敗があれば内容を表示して終了コード1。
 * ========================================================= */
let chromium;
try { ({ chromium } = await import('playwright')); } catch (e) {
  ({ chromium } = await import('/opt/node-tools/node_modules/playwright/index.mjs'));
}

const BASE = process.argv[2] || process.env.BASE || 'http://localhost:8123';
const VIEWS = [
  { name: 'desktop 1280x800', w: 1280, h: 800, minRow: 12 },
  { name: 'desktop 1024x768', w: 1024, h: 768, minRow: 12 },
  { name: 'iPad横 1180x820', w: 1180, h: 820, touch: true, dpr: 2, minRow: 14 },
  { name: 'iPad縦 768x1024', w: 768, h: 1024, touch: true, dpr: 2, minRow: 18 },
  { name: 'スマホ横 844x390', w: 844, h: 390, touch: true, minRow: 7 },
];

const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const fails = [];
for (const v of VIEWS) {
  const ctx = await browser.newContext({ viewport: { width: v.w, height: v.h }, deviceScaleFactor: v.dpr || 1, hasTouch: !!v.touch });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  await page.goto(`${BASE}/index.html?debug=1&q=low&v=${Date.now()}`, { timeout: 180000 });
  await page.waitForFunction(() => window.__test && __test.app.mode === 'title', null, { timeout: 180000 });
  await page.evaluate(() => __test.setup({ start: 8 }));
  await page.waitForTimeout(1200);
  /* EBにして持ち手の位置もみる(ドアが開いていてもブレーキは入る) */
  await page.evaluate(() => __test.app.sim.setNotch(-8));
  await page.waitForFunction(() => document.querySelector('#lever-grip').textContent.trim() === 'EB', null, { timeout: 60000 })
    .catch(() => fails.push(`${v.name}: EBにしても持ち手の表示が変わらない`));
  await page.waitForTimeout(300);
  const r = await page.evaluate((minRow) => {
    const out = [];
    const box = (el) => el.getBoundingClientRect();
    const m = document.querySelector('.cab-mascon');
    if (!m) return ['.cab-mascon がない'];
    const mb = box(m);
    const rows = [...document.querySelectorAll('#notch-list .nt')];
    if (rows.length !== 13) out.push(`.nt が ${rows.length} 段`);
    rows.forEach((el) => {
      const b = box(el);
      if (b.top < mb.top - 1 || b.bottom > mb.bottom + 1 || b.left < mb.left - 1 || b.right > mb.right + 1) {
        out.push(`${el.textContent} の段がマスコンからはみ出し (${b.top.toFixed(1)}-${b.bottom.toFixed(1)} / ${mb.top.toFixed(1)}-${mb.bottom.toFixed(1)})`);
      }
    });
    const eb = document.querySelector('.nt-eb');
    const ebH = eb ? box(eb).height : 0;
    if (ebH < minRow) out.push(`EBの段の高さ ${ebH.toFixed(1)}px < ${minRow}px`);
    const g = document.querySelector('#lever-grip'), gb = box(g);
    if (gb.top < mb.top - 1 || gb.bottom > mb.bottom + 1 || gb.left < mb.left - 1 || gb.right > mb.right + 1) {
      out.push(`持ち手がマスコンからはみ出し (${gb.top.toFixed(1)}-${gb.bottom.toFixed(1)}, ${gb.left.toFixed(1)}-${gb.right.toFixed(1)})`);
    }
    if (eb) {
      const c1 = (gb.top + gb.bottom) / 2, eb1 = (box(eb).top + box(eb).bottom) / 2;
      if (Math.abs(c1 - eb1) > Math.max(2, ebH / 2)) out.push(`EBのとき持ち手(${c1.toFixed(1)})が段(${eb1.toFixed(1)})とずれている`);
    }
    const sp = document.querySelector('#speedo');
    const want = Math.round(sp.clientWidth * Math.min(2, devicePixelRatio || 1));
    if (sp.width !== want) out.push(`速度計 canvas.width ${sp.width} ≠ ${want}`);
    if (sp.width > 300) out.push(`速度計 canvas.width ${sp.width} > 300`);
    [...document.querySelector('#cab').children].forEach((el) => {
      if (getComputedStyle(el).display === 'none') return;
      if (el.scrollWidth > el.clientWidth + 1) out.push(`${el.className} が横にはみ出し (${el.scrollWidth} > ${el.clientWidth})`);
    });
    const tb = document.querySelector('#touch-btns');
    if (tb && getComputedStyle(tb).display !== 'none') {
      const t = box(tb);
      if (t.right > mb.left && t.left < mb.right && t.bottom > mb.top && t.top < mb.bottom) out.push('タッチ用ボタンがマスコンに重なる');
    }
    return { out, ebH: +ebH.toFixed(1), rowsH: +(box(rows[12]).bottom - box(rows[0]).top).toFixed(1), cabH: box(document.querySelector('#cab')).height };
  }, v.minRow);
  if (Array.isArray(r)) r.forEach((s) => fails.push(`${v.name}: ${s}`));
  else {
    r.out.forEach((s) => fails.push(`${v.name}: ${s}`));
    console.log(`${r.out.length ? '×' : '○'} ${v.name}  EBの段 ${r.ebH}px  13段 ${r.rowsH}px  パネル ${r.cabH}px`);
  }
  errs.forEach((s) => fails.push(`${v.name}: pageerror ${s}`));
  await ctx.close();
}
await browser.close();
if (fails.length) { console.error('★ 失敗:\n' + fails.join('\n')); process.exit(1); }
console.log('OK');
