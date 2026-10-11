/* =========================================================
 * ui/stoppin.js — 運転台の画面に出す「8」の目印(停止位置のピン)
 * 停止位置の光の柱(scene の stopBeam)を画面に写した位置(scene.stopPin)に、
 * 実物の停止位置目標と同じ「黒い四角・白いふち・白い数字」の札を出し、下へ細い線をのばす。
 * 380m から 25m まで(それより近いと本物の標識が見えるので消す)。遠いほど小さい。
 * 毎フレーム update(pin, show) を呼ぶ。DOM を書きかえるのは 動いたとき・数字が変わったときだけ。
 * 使い方: const p = createStopPin(hudEl); p.resize(w, h); p.update(scene.stopPin, show); p.hide();
 * ========================================================= */

const CSS = `
#stop-pin { position: absolute; left: 0; top: 0; width: 0; height: 0; z-index: 5; pointer-events: none;
  opacity: 0; visibility: hidden; transition: opacity .25s, visibility 0s linear .25s; will-change: transform; }
#stop-pin.on { opacity: 1; visibility: visible; transition: opacity .25s, visibility 0s; }
#stop-pin::after { content: ''; position: absolute; left: -1px; bottom: 0; width: 2px; height: 24px;
  background: linear-gradient(rgba(255,255,255,.9), rgba(255,255,255,.25)); }
#stop-pin b { position: absolute; left: -17px; bottom: 24px; width: 34px; height: 34px; box-sizing: border-box;
  background: #0b0d0f; border: 2px solid #fff; border-radius: 3px; color: #fff;
  font: 900 23px/30px "DIN Alternate", "DIN Condensed", Bahnschrift, "Roboto Condensed", "Zen Kaku Gothic New", sans-serif;
  text-align: center; box-shadow: 0 1px 4px rgba(0,0,0,.55); }
#stop-pin b::before { content: ''; position: absolute; left: -7px; top: -7px; right: -7px; bottom: -7px;
  border: 2px solid #5fd6ff; border-radius: 6px; opacity: 0; animation: spRing 1.2s ease-out infinite; }
#stop-pin span { position: absolute; left: 22px; bottom: 30px; white-space: nowrap; color: #fff;
  font: 700 14px/1 "DIN Alternate", "DIN Condensed", Bahnschrift, "Roboto Condensed", "Zen Kaku Gothic New", sans-serif;
  font-variant-numeric: tabular-nums; letter-spacing: .02em;
  background: rgba(8,12,15,.72); border-radius: 3px; padding: 3px 6px; }
@keyframes spRing { 0% { opacity: .95; } 70% { opacity: 0; } 100% { opacity: 0; } }
@media (prefers-reduced-motion: reduce) { #stop-pin b::before { animation: none; opacity: .6; } }
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

/* きょりの数字: 100m より遠いと 10m きざみ、30m より遠いと 5m きざみ、近いと 1m きざみ */
function qM(d) {
  if (d > 100) return Math.round(d / 10) * 10;
  if (d > 30) return Math.round(d / 5) * 5;
  return Math.max(0, Math.round(d));
}

export function createStopPin(hudEl) {
  injectCss();
  const host = hudEl || (typeof document !== 'undefined' ? document.body : null);
  let el = typeof document !== 'undefined' ? document.getElementById('stop-pin') : null;
  if (!el && host) {
    el = document.createElement('div');
    el.id = 'stop-pin';
    el.setAttribute('aria-hidden', 'true');
    el.innerHTML = '<b>8</b><span></span>';
    host.appendChild(el);
  }
  const txt = el ? el.querySelector('span') : null;
  let W = 0, H = 0;
  let on = false, lx = -1e9, ly = -1e9, ls = -1, lm = -1;
  if (host && host.getBoundingClientRect) {
    /* 最初の大きさ(あとは resize で受けとる。毎フレーム読まない) */
    const wrap = host.closest ? host.closest('#gl-wrap') : null;
    const r = (wrap || host).getBoundingClientRect();
    W = r.width; H = r.height;
  }
  const show = (v) => {
    if (v === on || !el) return;
    on = v;
    el.classList.toggle('on', v);
  };
  return {
    el,
    /* 描画の箱(#gl-wrap)の大きさ(CSS px) */
    resize(w, h) { W = w; H = h; lx = -1e9; },
    hide() { show(false); },
    /* pin = scene.stopPin {vis, x, y, d} / show = 目印を出してよい場面(運転台・ガイドあり・ドアが閉まっている など) */
    update(pin, ok) {
      if (!el) return;
      const d = pin ? pin.d : 0;
      const vis = !!(ok && pin && pin.vis && d > 25 && d < 380 && W > 0);
      if (!vis) { show(false); return; }
      const px = pin.x * W, py = pin.y * H;
      const k = Math.min(1, Math.max(0, (380 - d) / 355));
      const s = 0.7 + 0.45 * k;
      if (Math.abs(px - lx) > 0.5 || Math.abs(py - ly) > 0.5 || Math.abs(s - ls) > 0.01) {
        lx = px; ly = py; ls = s;
        el.style.transform = 'translate3d(' + px.toFixed(1) + 'px,' + py.toFixed(1) + 'px,0) scale(' + s.toFixed(3) + ')';
      }
      const m = qM(d);
      if (m !== lm && txt) { lm = m; txt.textContent = m + 'm'; }
      show(true);
    },
  };
}
