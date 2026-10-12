/* =========================================================
 * ui/stoppin.js — 運転台の画面に出す「8」の目印(停止位置のピン)と、さいごの 30m の ものさし
 *
 * ピン(#stop-pin): 停止位置目標「8」の板の中心(scene._updateStopPin が 画面に写した scene.stopPin)に、
 *   実物の板と同じ「黒い四角・白いふち・白い数字」の札を出し、下へ細い線をのばして 板を さす。
 *   380m から出る(遠いほど小さい)。30m より近いと 札が 本物の板の上へ うつって 板と 同じ大きさになり、
 *   12m で うすく消える(f = smoothstep(12, 30, d): 不透明度 f・大きさ lerp(板のpx/34, ふだん, f)・
 *   線と 札の下の すき間 24×f px)。f=0 で 札の中心が 板の中心に かさなり、黒い札が 黒い板に とけこむ。
 *   きょりの数字は ふだん出さない(上の帯が 出す。opts.label === true で 出す)。
 * ものさし(#stop-ruler): のこり 30m(RULER_D)から 画面下の コーチの 12px 上に出る横長の帯。
 *   左=てまえ(青灰)・±1m=みどり・右=いきすぎ(赤)。「8」は はばの 80% に固定。列車の先頭が
 *   対数の目もり(30m→0m が 0→80%、いきすぎ 3m までが 80→100%)で すべる。数字は出さない
 *   (のこりの きょりは 上の帯が fmtNear で出す)。止まったら 0.3秒 そのまま(判定カードへ うけわたす)。
 *   noseX() = そのときの 先頭の位置(画面の px)。判定カードの 列車の先頭は そこから すべりだす。
 * 毎フレーム update(pin, ok) と ruler(d, v, ok) を呼ぶ。DOM を書きかえるのは 値が かわったときだけ
 * (transform・opacity・CSS変数。1要素ずつ)。#coach の位置は resize と ものさしを出すときだけ 読む。
 * 使い方: const p = createStopPin(hudEl, { label: false }); p.resize(w, h);
 *         p.update(scene.stopPin, show); p.ruler(dist, v, show); if (p.rulerOn) …; p.noseX(); p.hide();
 * ========================================================= */

/* ものさしを出す のこりの きょり(m) */
export const RULER_D = 30;

const FAR = 380;        // これより遠いと ピンを出さない
const FADE = 30;        // ここから 板へ うつりはじめる
const NEAR = 12;        // ここで 消えおわる(板だけが のこる)
const BOX = 34;         // 札の大きさ(CSS px)
const STEM = 24;        // 線の長さ(CSS px)
const RW = 360, RH = 44; // ものさしの大きさ(CSS px)
const FREEZE_MS = 300;

const NUMF = '"DIN Alternate", "DIN Condensed", Bahnschrift, "Roboto Condensed", "Zen Kaku Gothic New", sans-serif';
const CSS = `
#stop-pin { position: absolute; left: 0; top: 0; width: 0; height: 0; z-index: 5; pointer-events: none;
  opacity: 0; visibility: hidden; transition: opacity .25s, visibility 0s linear .25s; will-change: transform; }
#stop-pin.on { opacity: 1; visibility: visible; transition: opacity .25s, visibility 0s; }
#stop-pin .sp-in { position: absolute; left: 0; top: 0; width: 0; height: 0; }
#stop-pin .sp-in::after { content: ''; position: absolute; left: -1px; bottom: 0; width: 2px; height: calc(var(--sp-h, ${STEM}) * 1px);
  background: linear-gradient(rgba(255,255,255,.9), rgba(255,255,255,.25)); }
#stop-pin b { position: absolute; left: -${BOX / 2}px; bottom: calc(var(--sp-b, ${STEM}) * 1px); width: ${BOX}px; height: ${BOX}px; box-sizing: border-box;
  background: #0b0d0f; border: 2px solid #fff; border-radius: 3px; color: #fff;
  font: 900 23px/30px ${NUMF}; text-align: center; box-shadow: 0 1px 4px rgba(0,0,0,.55); }
#stop-pin b::before { content: ''; position: absolute; left: -7px; top: -7px; right: -7px; bottom: -7px;
  border: 2px solid #5fd6ff; border-radius: 6px; opacity: 0; animation: spRing 1.2s ease-out infinite; }
#stop-pin span { position: absolute; left: 22px; bottom: 30px; white-space: nowrap; color: #fff;
  font: 700 14px/1 ${NUMF}; font-variant-numeric: tabular-nums; letter-spacing: .02em;
  background: rgba(8,12,15,.72); border-radius: 3px; padding: 3px 6px; }
@keyframes spRing { 0% { opacity: .95; } 70% { opacity: 0; } 100% { opacity: 0; } }

#stop-ruler { position: absolute; left: 50%; bottom: 72px; width: ${RW}px; height: ${RH}px; margin-left: -${RW / 2}px; z-index: 7;
  pointer-events: none; opacity: 0; visibility: hidden; transition: opacity .2s, visibility 0s linear .2s; }
#stop-ruler.on { opacity: 1; visibility: visible; transition: opacity .2s, visibility 0s; }
#stop-ruler .sr-bar { position: absolute; left: 0; top: 0; right: 0; bottom: 0; overflow: hidden; border-radius: 8px;
  background: rgba(8, 12, 15, 0.94); border: 1px solid #34434c; box-shadow: 0 4px 14px rgba(0,0,0,.35); }
#stop-ruler .sr-z { position: absolute; top: 0; bottom: 0; }
#stop-ruler .sr-zs { left: 0; background: linear-gradient(90deg, rgba(127,216,255,0.05), rgba(127,216,255,0.16)); }
#stop-ruler .sr-zo { background: rgba(52, 208, 124, 0.26); border-left: 1px dashed rgba(52,208,124,0.85); border-right: 1px dashed rgba(52,208,124,0.85); }
#stop-ruler .sr-zx { right: 0; background: rgba(255, 83, 71, 0.22); }
#stop-ruler .sr-t { position: absolute; bottom: 0; width: 1px; margin-left: -0.5px; height: 9px; background: rgba(238,244,248,0.5); }
#stop-ruler .sr-t.f { height: 5px; background: rgba(238,244,248,0.38); }
#stop-ruler .sr-l, #stop-ruler .sr-r { position: absolute; top: 4px; font: 700 11px/1 "Zen Kaku Gothic New", sans-serif; letter-spacing: .04em; }
#stop-ruler .sr-l { left: 7px; color: #7fd8ff; }
#stop-ruler .sr-r { right: 6px; color: #ff9a8f; }
#stop-ruler .sr-8 { position: absolute; left: 80%; top: 4px; width: 20px; height: 22px; margin-left: -10px; z-index: 2; box-sizing: border-box;
  background: #0b0d0f; color: #fff; border: 1.5px solid #fff; font: 900 13px/19px ${NUMF}; text-align: center; }
#stop-ruler .sr-8::after { content: ''; position: absolute; left: 50%; top: 20px; width: 2px; height: 18px; margin-left: -1px; background: #eef4f8; }
/* 列車の先頭: 箱のはば=ものさしのはば。右はしが先頭(判定カードの #sc-nose と おなじ形。transform だけで すべらせる) */
#stop-ruler .sr-nose { position: absolute; left: 0; top: 0; bottom: 0; width: 100%; z-index: 1; transform: translateX(-100%); will-change: transform; }
#stop-ruler .sr-nose i { position: absolute; right: 0; bottom: 5px; width: 54px; height: 15px;
  border-radius: 3px 8px 3px 3px; background: linear-gradient(180deg, #e8f2f6, #9fb2bc); box-shadow: 0 0 10px rgba(127, 216, 255, 0.55); }
#stop-ruler .sr-nose i::after { content: ''; position: absolute; right: 4px; top: 3px; width: 7px; height: 5px; background: #24323b; border-radius: 1px; }
@media (prefers-reduced-motion: reduce) {
  #stop-pin b::before { animation: none; opacity: .6; }
  #stop-pin, #stop-pin.on, #stop-ruler, #stop-ruler.on { transition: none; }
}
`;

let cssDone = false;
function injectCss() {
  if (cssDone || typeof document === 'undefined') return;
  cssDone = true;
  const st = document.createElement('style');
  st.id = 'stop-pin-css';
  st.textContent = CSS;
  (document.head || document.documentElement).appendChild(st);
}

/* きょりの数字(ピンの ラベル用): 100m より遠いと 10m きざみ、30m より遠いと 5m きざみ、近いと 1m きざみ */
function qM(d) {
  if (d > 100) return Math.round(d / 10) * 10;
  if (d > 30) return Math.round(d / 5) * 5;
  return Math.max(0, Math.round(d));
}

/* 「8」まで ちかいときの きょりの書きかた: 1m 以上は 小数1けたの m('3.2' 'm')、1m より近いと cm('40' 'cm')。
 * d が負(いきすぎ)のときは 大きさだけ(いきすぎの ことばは よぶ側が つける)。
 * かえす物は つかいまわし(同じ値なら 文字も作りなおさない)。とっておくときは num・unit を コピーする */
const _near = { num: '—', unit: 'm' };
let _nearKey = NaN;
export function fmtNear(d) {
  if (typeof d !== 'number' || !isFinite(d)) { _nearKey = NaN; _near.num = '—'; _near.unit = 'm'; return _near; }
  const a = d < 0 ? -d : d;
  const cm = Math.round(a * 100);
  if (cm >= 100) {
    const k = Math.round(a * 10);
    if (k !== _nearKey) { _nearKey = k; _near.num = (k / 10).toFixed(1); _near.unit = 'm'; }
  } else if (-1 - cm !== _nearKey) {
    _nearKey = -1 - cm; _near.num = String(cm); _near.unit = 'cm';
  }
  return _near;
}

/* ものさしの位置(はばの %): 30m→0m を 0→80%(対数。近いほど こまかい)、いきすぎ 0→3m を 80→100% */
const LN_D = Math.log(1 + RULER_D), LN_O = Math.log(4);
function rulerX(d) {
  if (d >= 0) return 80 * (1 - Math.log(1 + Math.min(RULER_D, d)) / LN_D);
  return 80 + 20 * Math.log(1 + Math.min(3, -d)) / LN_O;
}

export function createStopPin(hudEl, opts) {
  injectCss();
  const label = !!(opts && opts.label === true);
  const doc = typeof document !== 'undefined' ? document : null;
  const host = hudEl || (doc ? doc.body : null);
  let el = doc ? doc.getElementById('stop-pin') : null;
  if (!el && host) {
    el = doc.createElement('div');
    el.id = 'stop-pin';
    el.setAttribute('aria-hidden', 'true');
    el.innerHTML = '<div class="sp-in"><b>8</b>' + (label ? '<span></span>' : '') + '</div>';
    host.appendChild(el);
  }
  const inner = el ? el.querySelector('.sp-in') : null;
  const txt = el && label ? el.querySelector('span') : null;

  /* ---- ものさし(目もり・帯は 1回だけ作る) ---- */
  let rl = doc ? doc.getElementById('stop-ruler') : null;
  if (!rl && host) {
    rl = doc.createElement('div');
    rl.id = 'stop-ruler';
    rl.setAttribute('aria-hidden', 'true');
    const x1 = rulerX(1), xo1 = rulerX(-1);
    let h = '<div class="sr-bar">'
      + `<i class="sr-z sr-zs" style="width:${x1.toFixed(2)}%"></i>`
      + `<i class="sr-z sr-zo" style="left:${x1.toFixed(2)}%;width:${(xo1 - x1).toFixed(2)}%"></i>`
      + `<i class="sr-z sr-zx" style="left:${xo1.toFixed(2)}%"></i>`;
    /* 目もり: てまえ 20・10・5・3・2m、±1m の中は 25cm ごと(こまかい)、いきすぎ 2m */
    [20, 10, 5, 3, 2, -2].forEach((d) => { h += `<i class="sr-t" style="left:${rulerX(d).toFixed(2)}%"></i>`; });
    [0.75, 0.5, 0.25, -0.25, -0.5, -0.75].forEach((d) => { h += `<i class="sr-t f" style="left:${rulerX(d).toFixed(2)}%"></i>`; });
    h += '<span class="sr-l">てまえ</span><span class="sr-r">いきすぎ</span>'
      + '<div class="sr-nose"><i></i></div></div><b class="sr-8">8</b>';
    rl.innerHTML = h;
    host.appendChild(rl);
  }
  const nose = rl ? rl.querySelector('.sr-nose') : null;
  const coach = doc ? doc.getElementById('coach') : null;
  const wrapOf = () => (host && host.closest ? host.closest('#gl-wrap') : null) || host;

  let W = 0, H = 0;
  let on = false, lx = -1e9, ly = -1e9, ls = -1, lm = -1, lf = -1;
  let rOn = false, rx = -1, rBottom = -1, rWidth = -1, frozen = false, fzT = 0, nx = null;
  if (host && host.getBoundingClientRect) {
    /* 最初の大きさ(あとは resize で受けとる。毎フレーム読まない) */
    const r = wrapOf().getBoundingClientRect();
    W = r.width; H = r.height;
  }
  const show = (v) => {
    if (v === on || !el) return;
    on = v;
    el.classList.toggle('on', v);
  };
  /* ものさしの はばと 高さ(コーチの上 12px)。resize と 出すときだけ(レイアウトを読むので 毎フレームは よばない) */
  const placeRuler = () => {
    if (!rl) return;
    const w = Math.max(160, Math.min(RW, Math.round(W * 0.6)));
    let bottom = 14 + 46 + 12;   // コーチが かくれているときの 目安(1行の コーチの上)
    if (coach && coach.offsetHeight > 0) {
      const cr = coach.getBoundingClientRect(), wr = wrapOf().getBoundingClientRect();
      if (cr.height > 0 && wr.height > 0) bottom = Math.round(wr.bottom - cr.top + 12);
    }
    if (w !== rWidth) { rWidth = w; rl.style.width = w + 'px'; rl.style.marginLeft = -w / 2 + 'px'; }
    if (bottom !== rBottom) { rBottom = bottom; rl.style.bottom = bottom + 'px'; }
  };
  /* 先頭の位置(画面の px)を おぼえる。レイアウトを読むので 止まったとき・かくれるときだけ */
  const keepNose = () => {
    if (!nose || rWidth <= 0 || rx < 0) return;
    const r = rl.getBoundingClientRect();
    nx = r.left + (r.width * rx) / 100;
  };
  const freezeFor = (ms) => {
    keepNose();
    frozen = true;
    clearTimeout(fzT);
    fzT = setTimeout(() => { frozen = false; showRuler(false); }, ms);
  };
  const showRuler = (v) => {
    if (v === rOn || !rl) return;
    rOn = v;
    api.rulerOn = v;
    rl.classList.toggle('on', v);
  };

  const api = {
    el,
    rulerEl: rl,
    /* ものさしが 出ているか(止まった直後の 0.3秒も ふくむ)。出ているあいだ ブレーキめやすは かくす(main.js) */
    rulerOn: false,
    /* 描画の箱(#gl-wrap)の大きさ(CSS px) */
    resize(w, h) { W = w; H = h; lx = -1e9; placeRuler(); },
    hide() { show(false); clearTimeout(fzT); frozen = false; showRuler(false); },
    /* pin = scene.stopPin {vis, x, y, d, dist, fov, size} / ok = 目印を出してよい場面(運転台・ガイドあり・ドアが閉まっている など) */
    update(pin, ok) {
      if (!el) return;
      const d = pin ? pin.d : 0;
      const vis = !!(ok && pin && pin.vis && d > NEAR && d < FAR && W > 0);
      if (!vis) { show(false); return; }
      const px = pin.x * W, py = pin.y * H;
      const k = Math.min(1, Math.max(0, (FAR - d) / (FAR - 25)));
      let s = 0.7 + 0.45 * k;
      let f = 1;
      if (d < FADE) {
        /* 板へ うつる: 札の大きさを 画面の板の大きさへ(板のpx = 大きさ × 焦点きょり / きょり) */
        const u = (d - NEAR) / (FADE - NEAR);
        f = u <= 0 ? 0 : u >= 1 ? 1 : u * u * (3 - 2 * u);
        const fov = pin.fov > 1 ? pin.fov : 58, size = pin.size > 0 ? pin.size : 0.5;
        const bpx = pin.dist > 0.5 ? (size * (H / 2)) / Math.tan((fov * Math.PI) / 360) / pin.dist : BOX * s;
        s = bpx / BOX + (s - bpx / BOX) * f;
      }
      if (Math.abs(px - lx) > 0.5 || Math.abs(py - ly) > 0.5 || Math.abs(s - ls) > 0.005) {
        lx = px; ly = py; ls = s;
        el.style.transform = 'translate3d(' + px.toFixed(1) + 'px,' + py.toFixed(1) + 'px,0) scale(' + s.toFixed(3) + ')';
      }
      const fq = Math.round(f * 50) / 50;
      if (fq !== lf && inner) {
        lf = fq;
        inner.style.opacity = fq >= 1 ? '' : String(fq);
        /* 線の長さと 札の下の すき間。f=0 で 札の中心が 板の中心(線の先)に くる */
        el.style.setProperty('--sp-h', (STEM * fq).toFixed(1));
        el.style.setProperty('--sp-b', ((STEM + BOX / 2) * fq - BOX / 2).toFixed(1));
      }
      if (txt) {
        const m = qM(d);
        if (m !== lm) { lm = m; txt.textContent = m + 'm'; }
      }
      show(true);
    },
    /* d = 「8」まで(m。負=いきすぎ) / v = 速さ(km/h) / ok = 出してよい場面(運転台・ガイドあり・ドアが閉まっている・
     * いきすぎパネルも 判定カードも ない)。止まると(のこり 2m より近いとき) 0.3秒 そのまま見せてから かくす */
    ruler(d, v, ok) {
      if (!rl || frozen) return;
      const has = typeof d === 'number' && isFinite(d);
      /* 止まった(のこり 2m より近い): 先頭の位置を おぼえて 0.3秒 そのまま(このあいだに 判定カードが出ても 消さない) */
      if (rOn && has && d <= 2 && !(v >= 0.1)) { freezeFor(FREEZE_MS); return; }
      /* 出す: のこり 0〜30m を 走っているとき。いったん出たら いきすぎ 3m まで・てまえで 止まっているあいだも 出しつづける */
      const vis = !!(ok && has && d <= RULER_D && W > 0 && (rOn ? d > -3 : d > 0 && v > 0));
      if (!vis) {
        /* 止まらずに かくれる(いきすぎパネル など)ときも、さいごの 先頭の位置は のこす */
        if (rOn) keepNose();
        showRuler(false);
        return;
      }
      if (!rOn) { nx = null; placeRuler(); }
      const x = Math.round(rulerX(d) * 10) / 10;
      if (x !== rx && nose) { rx = x; nose.style.transform = 'translateX(' + (x - 100).toFixed(1) + '%)'; }
      showRuler(true);
    },
    /* ものさしが さいごに 止まった(かくれた)ときの 列車の先頭の位置(画面の左からの CSS px)。まだなら null */
    noseX() { return nx; },
    /* ms のあいだ ものさしを いまの形のまま 止めてから かくす(判定カードの 出かたに あわせたいとき) */
    freeze(ms) { if (rOn) freezeFor(Math.max(0, ms || 0)); },
  };
  placeRuler();
  return api;
}
