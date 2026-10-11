/* =========================================================
 * check-cab-layout.mjs — 運転台パネル(#cab)のレイアウト確認(Playwright)
 * 画面サイズごとに運転画面を開き、次を確かめる:
 *   ・ノッチの13段(.nt)がぜんぶマスコン(.cab-mascon)の中に見えている(1pxまで)
 *   ・EB(ひじょう)の段の高さ: 12px以上(タッチ端末は下の表のとおり)
 *   ・レバーの持ち手がマスコンの中におさまり、いまのノッチの段とそろっている
 *   ・速度計のキャンバスの解像度 = round(表示幅 × min(2, devicePixelRatio))、304px以下
 *   ・#cab の子(各ブロック)が横にはみ出していない
 *   ・#touch-btns(タッチ用ボタン)がマスコンに重ならない
 *   ・cab.setTarget(-4) で B4 の段だけが点滅し、null で消える
 *   ・トラックパッドつきiPad用に (any-pointer: coarse) and (min-width: 861px) の指定がある
 *   ・#cab の中の ふりがな(rt)は 9.5px 以上、見出しの名札(.bc-cap .lim-cap .lamps-cap .nt-cap .tims-cap)は 12.5px 以上
 *   ・表示灯は1枚の表示盤(.lamps-grid の中に4つ)。ドアの灯は「ドア しまった」
 *   ・横向きスマホ: 目盛りは横一列の13段(1段 44px 以上・文字 11px 以上・左=ひじょう 右=P4)。レバーの列は出さない
 *   ・タッチ: 段のさかいで ±3px ゆれながら動かしても 段は1回しか変わらない / いまの段の1つ上をタップすると1段だけ
 * 段の高さの下限: iPad縦(768x1024・678x1024) 18px / iPad横(1180x820) 14px / ほか 12px(横向きスマホは横一列なので幅で見る)
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
  { name: 'iPad縦 となりにアプリ 678x1024', w: 678, h: 1024, touch: true, dpr: 2, minRow: 18 },
  { name: 'スマホ横 844x390', w: 844, h: 390, touch: true, minRow: 7, strip: true },
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
  /* 持ち手は 90ms でカチッと動く(CSSの transition)。ソフト描画ではコマが遅いので、動きおわるまで待つ */
  await page.waitForFunction(() => {
    const g = document.querySelector('#lever-grip');
    return !g.getAnimations || g.getAnimations().every((a) => a.playState === 'finished');
  }, null, { timeout: 30000, polling: 100 }).catch(() => fails.push(`${v.name}: 持ち手の動きがおわらない`));
  const r = await page.evaluate(([minRow, strip]) => {
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
    if (strip) {
      /* 横一列: 左から ひじょう … P4、1段 44px 以上、文字 11px 以上、レバーの列は出さない */
      const xs = rows.map((el) => box(el));
      const order = xs.map((b, i) => [b.left, i]).sort((a, b) => a[0] - b[0]).map((x) => x[1]);
      if (order.join(',') !== '12,11,10,9,8,7,6,5,4,3,2,1,0') out.push(`横一列の順番がちがう (${order.join(',')})`);
      xs.forEach((b, i) => { if (b.width < 44) out.push(`${rows[i].textContent} の段の幅 ${b.width.toFixed(1)}px < 44px`); });
      rows.forEach((el) => { const fs = parseFloat(getComputedStyle(el).fontSize); if (fs < 11) out.push(`${el.textContent} の文字 ${fs}px < 11px`); });
      if (getComputedStyle(document.querySelector('#lever')).display !== 'none') out.push('横一列なのにレバーの列が出ている');
    } else {
      if (ebH < minRow) out.push(`EBの段の高さ ${ebH.toFixed(1)}px < ${minRow}px`);
      const g = document.querySelector('#lever-grip'), gb = box(g);
      if (gb.top < mb.top - 1 || gb.bottom > mb.bottom + 1 || gb.left < mb.left - 1 || gb.right > mb.right + 1) {
        out.push(`持ち手がマスコンからはみ出し (${gb.top.toFixed(1)}-${gb.bottom.toFixed(1)}, ${gb.left.toFixed(1)}-${gb.right.toFixed(1)})`);
      }
      if (eb) {
        const c1 = (gb.top + gb.bottom) / 2, eb1 = (box(eb).top + box(eb).bottom) / 2;
        if (Math.abs(c1 - eb1) > Math.max(2, ebH / 2)) out.push(`EBのとき持ち手(${c1.toFixed(1)})が段(${eb1.toFixed(1)})とずれている`);
      }
    }
    /* 文字の大きさの下限: ふりがな 9.5px / 見出しの名札 12.5px(見えているものだけ) */
    const shown = (el) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
    document.querySelectorAll('#cab rt').forEach((el) => {
      if (!shown(el)) return;
      const fs = parseFloat(getComputedStyle(el).fontSize);
      if (fs < 9.5 - 0.01) out.push(`ふりがな「${el.textContent}」 ${fs}px < 9.5px`);
    });
    document.querySelectorAll('#cab .bc-cap, #cab .lim-cap, #cab .lamps-cap, #cab .nt-cap, #cab .tims-cap').forEach((el) => {
      if (!shown(el)) return;
      const fs = parseFloat(getComputedStyle(el).fontSize);
      if (fs < 12.5 - 0.01) out.push(`見出し「${el.textContent}」 ${fs}px < 12.5px`);
    });
    /* 表示灯の文字: 12.5px 以上で、灯の はばに おさまる(見えているときだけ) */
    document.querySelectorAll('#cab .lamp').forEach((el) => {
      if (!shown(el)) return;
      const fs = parseFloat(getComputedStyle(el).fontSize), t = el.querySelector('.lamp-t') || el;
      if (fs < 12.5 - 0.01) out.push(`表示灯「${el.textContent}」の文字 ${fs}px < 12.5px`);
      if (t.getBoundingClientRect().width > box(el).width + 0.5) out.push(`表示灯「${el.textContent}」の文字が はみ出す`);
    });
    /* 表示灯: 1枚の表示盤に4つ。ドアの灯は「ドア しまった」 */
    const lg = document.querySelector('#cab .lamps-grid');
    if (!lg || lg.querySelectorAll('.lamp').length !== 4) out.push('表示灯が1枚の表示盤(.lamps-grid に4つ)になっていない');
    const ld = document.querySelector('#lamp-door');
    if (!ld || !/しまった/.test(ld.textContent)) out.push('ドアの灯の文字が「ドア しまった」でない');
    const sp = document.querySelector('#speedo');
    const want = Math.round(sp.clientWidth * Math.min(2, devicePixelRatio || 1));
    if (sp.width !== want) out.push(`速度計 canvas.width ${sp.width} ≠ ${want}`);
    if (sp.width > 304) out.push(`速度計 canvas.width ${sp.width} > 304`);
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
  }, [v.minRow, !!v.strip]);
  /* つぎにねらう段の点滅(cab.setTarget)と、トラックパッドつきiPad用の (any-pointer: coarse) の指定 */
  const r2 = await page.evaluate(() => {
    const out = [], cab = __test.app.cab;
    if (cab && typeof cab.setTarget === 'function') {
      cab.setTarget(-4);
      const t = [...document.querySelectorAll('#notch-list .nt.tgt')];
      if (t.length !== 1 || t[0].textContent.trim() !== 'B4') out.push(`setTarget(-4) で B4 だけが点滅しない (${t.map((e) => e.textContent).join(',')})`);
      cab.setTarget(null);
      if (document.querySelectorAll('#notch-list .nt.tgt').length) out.push('setTarget(null) で点滅が消えない');
    }
    let anyPtr = false;
    for (const ss of document.styleSheets) {
      let rules = [];
      try { rules = [...ss.cssRules]; } catch (e) { /* 別オリジン */ }
      rules.forEach((ru) => { if (ru.media && /any-pointer:\s*coarse/.test(ru.media.mediaText) && /min-width:\s*861px/.test(ru.media.mediaText)) anyPtr = true; });
    }
    if (!anyPtr) out.push('(any-pointer: coarse) and (min-width: 861px) の指定がない');
    return out;
  });
  r2.forEach((s) => fails.push(`${v.name}: ${s}`));
  /* iPad横: 目盛りの上(天板)の 見えない さわれる所(56px)が 本当に目盛りに とどく(台で切られていない)。
   * 横向きスマホ: 横一列の目盛りの上(モニタ)は 目盛りにならない */
  if (v.touch && (v.strip || v.w >= 861)) {
    const r4 = await page.evaluate((strip) => {
      const list = document.querySelector('#notch-list'), b = list.getBoundingClientRect();
      const el = document.elementFromPoint(b.left + b.width / 2, b.top - 24);
      const hit = !!el && (el === list || list.contains(el));
      if (strip) return hit ? ['横一列の目盛りの上(モニタ)を さわると目盛りになる'] : [];
      return hit ? [] : [`目盛りの上 24px が目盛りに とどかない (${el ? el.id || el.className || el.tagName : 'なし'})`];
    }, !!v.strip);
    r4.forEach((s) => fails.push(`${v.name}: ${s}`));
  }
  /* タッチの段の動き(ドアが開いて止まっているので ブレーキの段で): 合成の PointerEvent を目盛りに送る */
  if (v.touch) {
    const r3 = await page.evaluate(async (strip) => {
      const out = [], sim = __test.app.sim, list = document.querySelector('#notch-list');
      const wait = () => new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
      const rowEl = (n) => document.querySelector(`#notch-list .nt[data-n="${n}"]`);
      const at = (n, f) => {
        const b = rowEl(n).getBoundingClientRect();
        return strip ? { x: b.left + b.width * (1 - f), y: b.top + b.height / 2 } : { x: b.left + b.width / 2, y: b.top + b.height * f };
      };
      const fire = (type, p) => list.dispatchEvent(new PointerEvent(type, { pointerId: 7, pointerType: 'touch', isPrimary: true, clientX: p.x, clientY: p.y, bubbles: true, cancelable: true }));
      /* 1) B3 のとき B2(1つ上)をタップ → B2 だけ */
      sim.setNotch(-3); await wait();
      fire('pointerdown', at(-2, 0.5)); fire('pointerup', at(-2, 0.5)); await wait();
      if (sim.notch !== -2) out.push(`B3 で1つ上をタップしたら ${sim.notch}(B2 になるはず)`);
      /* 2) B3 から B3/B4 のさかいを ±3px ゆれながら → 変わるのは1回まで */
      sim.setNotch(-3); await wait();
      let changes = 0, last = sim.notch;
      fire('pointerdown', at(-3, 0.5));
      const edge = at(-4, 0);
      for (let k = 0; k < 24; k++) {
        const j = (k % 2 ? 3 : -3);
        fire('pointermove', strip ? { x: edge.x + j, y: edge.y } : { x: edge.x, y: edge.y + j });
        if (sim.notch !== last) { changes++; last = sim.notch; }
      }
      fire('pointerup', edge);
      if (changes > 1) out.push(`段のさかいで ±3px ゆらすと ${changes} 回 変わった(1回まで)`);
      /* 3) ひじょうの段はタップでそのまま */
      sim.setNotch(-3); await wait();
      fire('pointerdown', at(-8, 0.5)); fire('pointerup', at(-8, 0.5)); await wait();
      if (sim.notch !== -8) out.push(`ひじょうの段をタップしても ${sim.notch}`);
      sim.setNotch(-8);
      return out;
    }, !!v.strip);
    r3.forEach((s) => fails.push(`${v.name}: ${s}`));
  }
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
