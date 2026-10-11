/* =========================================================
 * ui/loadroute.js — よみこみ画面の「路線の帯」
 * 駅の数だけ点をならべ(新宿→新百合ヶ丘。のぼりは逆の順で渡す)、よみこみが進むと点がともり、
 * 小さな電車のしるしが左から右へ進む。両はしに 駅名(かな)。
 * いままでの細い棒(.load-bar)は、この帯が出ているあいだ かくす(.load-inner.lr-on)。
 * 使い方: const lr = mountLoadRoute(el, names); lr.set(0..1);
 * ========================================================= */

const CSS = `
.load-inner.lr-on { width: min(640px, 90vw); }
.load-inner.lr-on .load-bar { display: none; }
.load-route { margin: 26px 0 10px; }
.lr-track { position: relative; padding: 0 2px; }
.lr-line { position: relative; display: flex; justify-content: space-between; align-items: center; height: 14px;
  background: linear-gradient(#33424b, #33424b) center / 100% 3px no-repeat; }
.lr-line i { position: relative; width: 9px; height: 9px; border-radius: 50%; box-sizing: content-box;
  border: 2px solid #4d5e68; background: #0e1418; transition: background-color .2s, border-color .2s; }
.lr-line i.on { border-color: var(--acc-2, #56c2e8); background: var(--acc-2, #56c2e8); }
.lr-line i.end { width: 11px; height: 11px; }
#lr-train { position: absolute; left: 0; top: -12px; width: 100%; height: 13px; pointer-events: none;
  transform: translateX(-100%); transition: transform .3s linear; }
#lr-train::before { content: ''; position: absolute; right: -11px; top: 0; width: 22px; height: 13px;
  border-radius: 3px 7px 7px 3px; background: linear-gradient(180deg, #e8f2f6, #9fb2bc); box-shadow: 0 0 8px rgba(127,216,255,.7); }
#lr-train::after { content: ''; position: absolute; right: -8px; top: 3px; width: 5px; height: 4px; background: #24323b; border-radius: 1px; }
.lr-ends { display: flex; justify-content: space-between; margin-top: 8px; color: #c9d6dc;
  font-size: var(--fs-cap, 12.5px); font-weight: 700; letter-spacing: .06em; }
.lr-ends span { white-space: nowrap; }
@media (prefers-reduced-motion: reduce) { #lr-train, .lr-line i { transition: none; } }
`;

let cssDone = false;
function injectCss() {
  if (cssDone || typeof document === 'undefined') return;
  cssDone = true;
  const st = document.createElement('style');
  st.id = 'load-route-css';
  st.textContent = CSS;
  (document.head || document.documentElement).appendChild(st);
}

/* el: 帯を入れる箱(#load-route) / names: 駅名(かな)を はしる順に */
export function mountLoadRoute(el, names) {
  const list = Array.isArray(names) && names.length > 1 ? names : ['', ''];
  if (!el || typeof document === 'undefined') return { set() { /* noop */ } };
  injectCss();
  el.classList.add('load-route');
  el.textContent = '';
  const track = document.createElement('div');
  track.className = 'lr-track';
  const line = document.createElement('div');
  line.className = 'lr-line';
  line.id = 'lr-line';
  const dots = [];
  for (let i = 0; i < list.length; i++) {
    const d = document.createElement('i');
    if (i === 0 || i === list.length - 1) d.className = 'end';
    line.appendChild(d);
    dots.push(d);
  }
  const train = document.createElement('div');
  train.id = 'lr-train';
  track.appendChild(line);
  track.appendChild(train);
  const ends = document.createElement('div');
  ends.className = 'lr-ends';
  const a = document.createElement('span'), b = document.createElement('span');
  a.id = 'lr-a'; b.id = 'lr-b';
  a.textContent = list[0] || '';
  b.textContent = list[list.length - 1] || '';
  ends.appendChild(a); ends.appendChild(b);
  el.appendChild(track);
  el.appendChild(ends);
  const inner = (el.closest && el.closest('.load-inner')) || document.querySelector('.load-inner');
  if (inner) inner.classList.add('lr-on');
  const last = list.length - 1;
  let lit = -1, lk = -1;
  return {
    /* k: 0..1 の進み具合。点は k に合わせて ともり、電車のしるしは k の位置へ */
    set(k) {
      const kk = Math.min(1, Math.max(0, Number(k) || 0));
      const n = Math.round(kk * last) + 1;
      if (n !== lit) {
        for (let i = 0; i < dots.length; i++) {
          const on = i < n;
          if (on !== (i < lit)) dots[i].classList.toggle('on', on);
        }
        lit = n;
      }
      if (Math.abs(kk - lk) > 0.002) {
        lk = kk;
        train.style.transform = 'translateX(' + (kk * 100 - 100).toFixed(2) + '%)';
      }
    },
  };
}
