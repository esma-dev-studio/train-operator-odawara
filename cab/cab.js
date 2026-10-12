/* =========================================================
 * cab/cab.js — 運転台の計器盤（DOM+Canvas 2D）
 * 速度計(区切りの帯・制限の三角・液晶。針は べつのキャンバスを回すだけ) / ブレーキの強さ / マスコン(13段) /
 * 表示灯(1枚の表示盤。ドアの灯は「ドアが しまった」で つく) / 運転モニタ / 制限スピード板
 *
 * index.html の #cab をコンストラクタで組みかえる(要素は移動するだけ。idとリスナーはそのまま)。
 * 毎フレームの書き込みは「値が変わったときだけ」(_set)。止まっている間はDOMを一切さわらない。
 * main.js との約束(なくても動く): render(h) / bindInput({canOp,setNotch}) / flashGrip() /
 *   setService({svcHtml,color,destHtml}) / setLight(lum) / setTarget(n|null: つぎにねらうノッチを点滅) /
 *   setSun(x, k)(天板の日だまり: scene.cockpit.sunX / sunK。計器盤の上の あたたかい光を 横に すべらせる)
 * 外から見せかたを変える: body.cab-compact(外のカメラの ほそい計器盤。マスコンは 横一列。クラスが変わったら はかりなおす)
 *   h.uiLimAt(コーチと同じ まるめた「制限まで あと m」)・h.uiBrakeNow(いまブレーキ)があれば そろえる
 * ========================================================= */
import { STATION_KANA } from '../sim/kana.js';

const $ = (s) => document.querySelector(s);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
/* 数字の書体(DIN系があればそれ。なければ本文の書体) */
const NUM_FONT = '"DIN Alternate","DIN Condensed",Bahnschrift,"Roboto Condensed","Zen Kaku Gothic New",sans-serif';
const TAU = Math.PI * 2;

/* 種別(main.js が setService を呼ぶまでの代わり) */
const SVC = {
  local: { kana: 'かくえきていしゃ', color: '#8fa0aa' },
  exp: { kana: 'きゅうこう', color: '#ff6b3d' },
  rapid: { kana: 'かいそくきゅうこう', color: '#3fb0ff' },
};
const ruby = (name, kana) => (kana ? `<ruby>${name}<rt>${kana}</rt></ruby>` : name);
const rubySt = (name) => ruby(name, STATION_KANA[name]);
/* 「ふん/ぷん」の読み分け(1・3・4・6・8・10 は ぷん) */
const fun = (m) => ([2, 5, 7, 9].includes(m % 10) ? 'ふん' : 'ぷん');
/* 距離の表示のきざみ(main.js の qStep と同じ: 100m以上は10m、20m以上は5m、ほかは1m) */
const qStep = (m) => (m >= 100 ? 10 : m >= 20 ? 5 : 1);
/* このさきの制限・信号を出しはじめる距離(main.js の上の帯と同じ 700m) */
const LOOKAHEAD = 700;

/* ノッチ: 上から P4 … P1, N, B1 … B7, EB の13段 */
const NOTCHES = [['P4', 4], ['P3', 3], ['P2', 2], ['P1', 1], ['N', 0],
  ['B1', -1], ['B2', -2], ['B3', -3], ['B4', -4], ['B5', -5], ['B6', -6], ['B7', -7], ['ひじょう', -8]];
const notchIdx = (n) => (n === -8 ? 12 : 4 - n);
const zoneOf = (n) => (n === -8 ? 'eb' : n > 0 ? 'p' : n < 0 ? 'b' : 'n');

/* 速度計の目盛り: 0〜120km/h を 270°(下があく) */
const A0 = Math.PI * 0.75, A1 = Math.PI * 2.25, VMAX = 120;
const angOf = (v) => A0 + (A1 - A0) * (v / VMAX);
/* 帯は 2.5km/h ごとの区切り(49こ)。1つの区切りは目盛りを中心に 1.8km/h ぶん光る */
const SEG_N = 48, SEG_HALF = 0.9;
const NO_DASH = [];

export class Cab {
  constructor(sim) {
    this.sim = sim;
    this.root = $('#cab');
    this.speedo = $('#speedo');
    this.ctx = this.speedo.getContext('2d');
    this.needle = null;
    this._night = false;
    this._dials = {};
    this._k = {};
    this._restructure();
    this.els = {
      notchList: $('#notch-list'),
      lever: $('#lever'),
      leverGrip: $('#lever-grip'),
      gripT: $('#lever-grip .lg-t'),
      lampPat: $('#lamp-pattern'),
      lampBrk: $('#lamp-brake'),
      lampDoor: $('#lamp-door'),
      lampSlip: $('#lamp-slip'),
      lampDoorT: document.querySelector('#lamp-door .lamp-t'),
      timsSvc: $('#tims-svc'),
      timsDest: $('#tims-dest'),
      timsNext: $('#tims-next'),
      timsDist: $('#tims-dist'),
      timsSch: $('#tims-sch'),
      timsClock: $('#tims-clock'),
      timsCap: this.root.querySelector('.tims-cap'),
      timsDelay: $('#tims-delay'),
      timsProg: $('#tims-prog'),
      timsList: $('#tims-list'),
      limNow: $('#lim-now'),
      limNext: $('#lim-next'),
      grade: $('#grade-ind'),
      bcLeds: [...document.querySelectorAll('#bc-fill i')],
    };
    this._buildNotch();
    this._makeNoise();
    this._observeSizes();
    /* Webフォントが後から読めたら、文字盤を描きなおす */
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(() => { this._dials = {}; this._k.w = -1; }).catch(() => {});
    }
  }

  /* ---------------- DOM の組みかえ(一度だけ) ---------------- */
  _restructure() {
    const root = this.root;
    if (root.querySelector('.cab-mascon')) return;

    /* 速度計: 文字盤・帯・液晶のキャンバス(#speedo)の上に、針だけのキャンバスを重ねる(針は回すだけ) */
    const sp = this.speedo;
    if (sp && sp.parentElement && !sp.parentElement.classList.contains('speedo-wrap')) {
      const wrap = document.createElement('div');
      wrap.className = 'speedo-wrap';
      sp.parentElement.insertBefore(wrap, sp);
      wrap.appendChild(sp);
      const nd = document.createElement('canvas');
      nd.className = 'speedo-needle';
      nd.setAttribute('aria-hidden', 'true');
      wrap.appendChild(nd);
    }
    /* 速度計のわき: ブレーキの強さ(8つのLED) */
    const bw = root.querySelector('.bc-wrap');
    if (bw) bw.innerHTML = '<span class="bc-cap">ブレーキ</span><div class="bc-leds" id="bc-fill">' + '<i></i>'.repeat(8) + '</div>';

    /* 運転モニタ: 見出し(種別・行き先・時計) + つぎの駅 + そのさきの駅 */
    const tims = root.querySelector('.cab-tims');
    if (tims) {
      const keep = {};
      ['tims-clock', 'tims-next', 'tims-dist', 'tims-sch', 'tims-delay'].forEach((id) => {
        const el = document.getElementById(id);
        keep[id] = el || Object.assign(document.createElement('span'), { id });
        if (el) el.remove();
      });
      tims.innerHTML = `<div class="tims-screen">
  <div class="tims-head"><span class="tims-svc" id="tims-svc"></span><span class="tims-dest" id="tims-dest"></span><i data-slot="tims-clock"></i></div>
  <div class="tims-body">
    <div class="tims-main">
      <div class="tims-cap">つぎは</div>
      <i data-slot="tims-next"></i>
      <div class="tims-row2"><i data-slot="tims-dist"></i><i data-slot="tims-sch"></i></div>
      <div class="tims-row3"><i data-slot="tims-delay"></i></div>
      <div class="tims-prog"><i id="tims-prog"></i></div>
    </div>
    <ol class="tims-list" id="tims-list"></ol>
  </div>
</div>`;
      tims.querySelectorAll('[data-slot]').forEach((s) => s.replaceWith(keep[s.dataset.slot]));
      keep['tims-next'].textContent = '';
      keep['tims-clock'].textContent = '';
    }

    /* 表示灯: 見出し(ほかの計器とおなじく、穴の上に小さく) */
    const lamps = root.querySelector('.cab-lamps');
    if (lamps && !lamps.querySelector('.lamps-cap')) lamps.insertAdjacentHTML('afterbegin', '<span class="lamps-cap">ランプ</span>');
    /* ドアの灯は「ドアが しまった」(戸じめ)で つく */
    const ld = root.querySelector('#lamp-door');
    if (ld) ld.innerHTML = 'ドア<br>しまった';
    /* レンズの文字(2行)は1つの箱に入れて、レンズのまん中におく(flex の中の <br> にたよらない) */
    root.querySelectorAll('.lamp').forEach((l) => { if (!l.querySelector('.lamp-t')) l.innerHTML = `<span class="lamp-t">${l.innerHTML}</span>`; });
    /* 4つの灯は1枚の表示盤(ひとつの枠に すきまなく並ぶ。さわる物ではない) */
    if (lamps && !lamps.querySelector('.lamps-grid')) {
      const grid = document.createElement('div');
      grid.className = 'lamps-grid';
      grid.setAttribute('aria-hidden', 'true');
      lamps.querySelectorAll('.lamp').forEach((l) => grid.appendChild(l));
      lamps.appendChild(grid);
    }

    /* 天板の日だまり(setSun で 横に すべらせる・こさを かえる。transform と opacity だけ) */
    if (!root.querySelector('.cab-sun')) root.insertAdjacentHTML('afterbegin', '<i class="cab-sun" aria-hidden="true"></i>');

    /* 制限スピード: 見出しにふりがな */
    const cap = root.querySelector('.lim-cap');
    if (cap) cap.innerHTML = '<ruby>制限<rt>せいげん</rt></ruby>スピード';

    /* マスコン: ノッチ目盛り(#notch-list)とレバー(#lever)を1つの台にまとめる */
    const list = $('#notch-list'), lever = $('#lever');
    const mascon = document.createElement('div');
    mascon.className = 'cab-block cab-mascon';
    root.appendChild(mascon);
    const oldNotch = list.parentElement;
    mascon.appendChild(list);
    mascon.appendChild(lever);
    if (oldNotch && oldNotch !== root && oldNotch.classList.contains('cab-notch') && !oldNotch.children.length) oldNotch.remove();
    lever.querySelectorAll('.lv-lab').forEach((s) => s.remove());
    const slot = document.createElement('div');
    slot.className = 'lever-slot';
    lever.insertBefore(slot, lever.firstChild);
    const grip = $('#lever-grip');
    grip.innerHTML = '<span class="lg-t">N</span><i class="lg-led"></i>';
    grip.classList.add('lg-n');
  }

  _buildNotch() {
    /* 段の場所は CSS で決める(たて: 上から順に自動で並ぶ / 横向きのスマホ: data-i で 左=ひじょう … 右=P4) */
    const rows = NOTCHES.map(([label, val], i) =>
      `<div class="nt nt-${zoneOf(val)}" data-n="${val}" data-i="${i}">${label}</div>`).join('');
    /* 左の見出し(さわっても反応しない。.nt ではない) */
    const caps = '<span class="nt-cap nt-cap-p" style="grid-row:1/5">すすむ</span>'
      + '<span class="nt-cap nt-cap-b" style="grid-row:6/13">ブレーキ</span>';
    this.els.notchList.innerHTML = caps + rows;
    this._nt = [...this.els.notchList.querySelectorAll('.nt')];
    this._onIdx = -1;
    this._tgtIdx = -1;
    this._lastNotch = null;
  }

  /* パネルの地(細かいざらつき)は一度だけ画像にして CSS 変数へ
   * (#cab の style 属性に入れると --cab-lum を書くたびに長い文字列ごと書きなおされるので <style> に置く) */
  _makeNoise() {
    if (document.getElementById('cab-noise-css')) return;
    try {
      const cv = document.createElement('canvas');
      cv.width = cv.height = 128;
      const c = cv.getContext('2d');
      const img = c.createImageData(128, 128);
      let seed = 11;
      for (let i = 0; i < img.data.length; i += 4) {
        seed = (seed * 16807) % 2147483647;
        const r = seed / 2147483647;
        const v = r > 0.5 ? 255 : 0;
        img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
        img.data[i + 3] = Math.round(Math.abs(r - 0.5) * 2 * 18);   // 最大で約7%
      }
      c.putImageData(img, 0, 0);
      const st = document.createElement('style');
      st.id = 'cab-noise-css';
      st.textContent = `#cab{--cab-noise:url(${cv.toDataURL('image/png')})}`;
      document.head.appendChild(st);
    } catch (e) { /* 地紋なしでも動く */ }
  }

  /* 大きさが変わったとき: 速度計の解像度・レバーの持ち手の位置。
   * 外のカメラの ほそい計器盤(body.cab-compact)に かわったときも はかりなおす(レイアウトが きまった つぎのコマで) */
  _observeSizes() {
    const onResize = () => { this._fitSpeedo(); this._measureLever(); this._measureGlass(); };
    if (typeof ResizeObserver !== 'undefined') {
      this._ro = new ResizeObserver(onResize);
      this._ro.observe(this.speedo);
      this._ro.observe(this.els.lever);
    }
    addEventListener('resize', onResize);
    try {
      this._mqStrip = matchMedia('(max-height: 540px) and (orientation: landscape)');
      this._mqCompact = matchMedia('(min-width: 561px)');
    } catch (e) { this._mqStrip = null; this._mqCompact = null; }
    this._compact = this._isCompact();
    if (typeof MutationObserver !== 'undefined' && document.body) {
      this._mo = new MutationObserver(() => {
        const c = this._isCompact();
        if (c === this._compact) return;
        this._compact = c;
        requestAnimationFrame(() => {
          onResize();
          if (this._lastNotch != null) this._placeGrip(notchIdx(this._lastNotch));
        });
      });
      this._mo.observe(document.body, { attributes: true, attributeFilter: ['class'] });
    }
    onResize();
  }

  /* 外のカメラの ほそい計器盤(CSS は 561px 以上の はばのときだけ ほそくする) */
  _isCompact() {
    const b = document.body;
    return !!b && b.classList.contains('cab-compact') && (!this._mqCompact || this._mqCompact.matches);
  }

  /* マスコンが 横一列(左=ひじょう … 右=P4)か: ほそい計器盤・横向きのスマホ、または 目盛りが横長 */
  _isStrip(r) {
    if (this._isCompact()) return true;
    if (this._mqStrip && this._mqStrip.matches) return true;
    return !!r && r.width > r.height * 2;
  }

  /* 夜のガラスに映る計器の明かりの位置(モニタ・速度計)を #glass-sheen の CSS 変数へ。
   * 大きさが変わったときだけ(値が同じなら書かない) */
  _measureGlass() {
    const gw = $('#gl-wrap'), sh = $('#glass-sheen'), ts = this.root.querySelector('.tims-screen');
    if (!gw || !sh || !ts) return;
    const g = gw.getBoundingClientRect(), t = ts.getBoundingClientRect(), sp = this.speedo.getBoundingClientRect();
    if (!(g.width > 0) || !(t.width > 0)) return;
    const pct = (v) => v.toFixed(1) + '%';
    const tx = pct(((t.left + t.width / 2 - g.left) / g.width) * 100);
    const tw = pct((t.width / g.width) * 55);
    const sx = sp.width > 0 ? pct(((sp.left + sp.width / 2 - g.left) / g.width) * 100) : '8.0%';
    const key = tx + tw + sx;
    if (key === this._rfKey) return;
    this._rfKey = key;
    sh.style.setProperty('--rf-tx', tx);
    sh.style.setProperty('--rf-tw', tw);
    sh.style.setProperty('--rf-sx', sx);
  }

  _fitSpeedo() {
    const css = this.speedo.clientWidth;
    if (!css) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const px = Math.round(css * dpr);
    this._cssW = css;
    if (this.speedo.width !== px || this.speedo.height !== px) {
      this.speedo.width = this.speedo.height = px;
      this._dials = {};
      this._grad = null;
      this._k.w = -1;
    }
    /* 針のキャンバス: 大きさが変わったときだけ、右向き(0°)の針を一度描く。あとは CSS で回すだけ */
    const nd = this.needle || (this.needle = this.root.querySelector('.speedo-needle'));
    if (nd && (nd.width !== px || nd.height !== px || this._ndSmall !== (css < 100))) {
      nd.width = nd.height = px;
      this._ndSmall = css < 100;
      this._drawNeedle(nd, px);
      this._ndDeg = null;
    }
  }

  /* 針(先細り・影つき)と中心のキャップ。右向き(角度0)で描いておく */
  _drawNeedle(cv, W) {
    const c = cv.getContext('2d'), R = W / 2;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, W, W);
    c.save();
    c.translate(R, R);
    c.shadowColor = 'rgba(0,0,0,0.55)'; c.shadowBlur = R * 0.04; c.shadowOffsetY = R * 0.02;
    c.beginPath();
    c.moveTo(-0.16 * R, -0.028 * R); c.lineTo(0.80 * R, -0.008 * R); c.lineTo(0.84 * R, 0);
    c.lineTo(0.80 * R, 0.008 * R); c.lineTo(-0.16 * R, 0.028 * R); c.closePath();
    c.fillStyle = '#ff5a36'; c.fill();
    c.restore();
    /* 中心のキャップ(回しても見え方が変わらないよう、光は まん中に) */
    const hub = c.createRadialGradient(R, R, 0, R, R, R * 0.085);
    hub.addColorStop(0, '#6b757c'); hub.addColorStop(0.55, '#2a3035'); hub.addColorStop(1, '#121518');
    c.fillStyle = hub;
    c.beginPath(); c.arc(R, R, R * 0.085, 0, TAU); c.fill();
    c.fillStyle = 'rgba(255,255,255,0.45)';
    c.beginPath(); c.arc(R, R, R * 0.02, 0, TAU); c.fill();
  }

  _measureLever() {
    const lv = this.els.lever, g = this.els.leverGrip;
    const H = lv.clientHeight, gh = g.offsetHeight;
    if (!H) return;
    /* 持ち手は台(.cab-mascon)の内側の余白までははみ出してよい */
    const cs = getComputedStyle(lv.parentElement);
    const padT = parseFloat(cs.paddingTop) || 0, padB = parseFloat(cs.paddingBottom) || 0;
    if (H !== this._levH || gh !== this._gripH || padT !== this._padT || padB !== this._padB) {
      this._levH = H; this._gripH = gh; this._padT = padT; this._padB = padB;
      if (this._lastNotch != null) this._placeGrip(notchIdx(this._lastNotch));
    }
  }

  /* 持ち手のまん中を、その段のまん中に(上下のはしは台の中におさめる)。
   * レバーが横長(横一列の目盛り)のときは 左=ひじょう … 右=P4 で横に動かす */
  _placeGrip(idx) {
    const lv = this.els.lever;
    /* 横一列のときは レバーの列は出さない(CSS)。大きさが 0 なら 何もしない */
    if (this._isStrip(null) && !(lv.clientWidth > 0)) return;
    if (lv.clientWidth > lv.clientHeight * 2) {
      const W = lv.clientWidth, gw = this.els.leverGrip.offsetWidth || 30;
      const x = clamp(((12 - idx + 0.5) * W) / 13 - gw / 2, 0, W - gw);
      this.els.leverGrip.style.transform = `translateX(${x.toFixed(1)}px)`;
      return;
    }
    const H = this._levH || lv.clientHeight, gh = this._gripH || this.els.leverGrip.offsetHeight || 30;
    const y = clamp(((idx + 0.5) * H) / 13 - gh / 2, 1 - (this._padT || 0), H - gh + (this._padB || 0) - 1);
    this.els.leverGrip.style.transform = `translateY(${y.toFixed(1)}px)`;
  }

  /* ---------------- 入力(main.js から1回だけ呼ぶ) ----------------
   * レバーも目盛りも、さわった位置で13段のどれかに。下へはみ出してもかならず EB。
   *  ・段のさかいで指がゆれても ばたばたしない: いまの段の まん中から 0.8段 はなれるまで変えない
   *  ・指(タッチ)で いまの段の となり(2段の手前まで)を さわったら 1段だけ動かす(ねらった段の となりに当たっても同じ)。
   *    ひじょうの段・2段より遠くは その段へ
   *  ・横向きのスマホ(目盛りが横一列: 横幅が高さの2倍より大きい)は 左=ひじょう … 右=P4 */
  bindInput({ canOp = () => true, setNotch } = {}) {
    if (this._inputBound) return;
    this._inputBound = true;
    const list = this.els.notchList;
    /* さわった位置 → 段の位置(0〜13 の小数。0 = P4 の上のはし)。目盛りの外(上の天板など)は いちばん近い段へ。
     * 横一列(ほそい計器盤・横向きのスマホ)は 左=ひじょう … 右=P4 */
    const rowAt = (ev, r, horiz) => {
      if (horiz) return clamp(13 - ((ev.clientX - r.left) / Math.max(1, r.width)) * 13, 0, 12.999);
      return clamp(((ev.clientY - r.top) / Math.max(1, r.height)) * 13, 0, 12.999);
    };
    const send = (idx) => {
      const n = idx === 12 ? -8 : 4 - idx;
      if (setNotch) setNotch(n); else if (this.sim) this.sim.setNotch(n);
    };
    [this.els.lever, list].forEach((el) => {
      let id = null, dragIdx = -1, armed = true, x0 = 0, y0 = 0, rowPx = 14, horiz = false;
      el.addEventListener('pointerdown', (ev) => {
        id = ev.pointerId;
        try { el.setPointerCapture(id); } catch (e) { /* 合成イベント等 */ }
        if (ev.cancelable) ev.preventDefault();
        dragIdx = -1;
        if (!canOp()) return;
        const r = list.getBoundingClientRect();
        horiz = this._isStrip(r);
        rowPx = Math.max(4, (horiz ? r.width : r.height) / 13);
        x0 = ev.clientX; y0 = ev.clientY;
        armed = true;
        const f = rowAt(ev, r, horiz), t = Math.floor(f);
        const cur = this._lastNotch != null ? notchIdx(this._lastNotch) : -1;
        let idx = t;
        if (ev.pointerType !== 'mouse' && cur >= 0 && t !== 12) {
          const d = f - (cur + 0.5);
          if (Math.abs(d) <= 0.5) idx = cur;
          else if (Math.abs(d) < 2) { idx = clamp(cur + (d > 0 ? 1 : -1), 0, 12); armed = false; }
        }
        dragIdx = idx;
        if (idx !== cur) send(idx);
      });
      el.addEventListener('pointermove', (ev) => {
        if (id !== ev.pointerId || dragIdx < 0 || !canOp()) return;
        /* 1段だけ動かしたタップは、指が半段ぶん動くまで そのまま(指のゆれで さらに動かない) */
        if (!armed) {
          if (Math.abs(horiz ? ev.clientX - x0 : ev.clientY - y0) < rowPx * 0.5) return;
          armed = true;
        }
        const f = rowAt(ev, list.getBoundingClientRect(), horiz);
        if (Math.abs(f - (dragIdx + 0.5)) > 0.8) {
          const idx = Math.floor(f);
          if (idx !== dragIdx) { dragIdx = idx; send(idx); }
        }
      });
      const end = (ev) => { if (id === ev.pointerId) { id = null; dragIdx = -1; } };
      el.addEventListener('pointerup', end);
      el.addEventListener('pointercancel', end);
      el.addEventListener('lostpointercapture', end);
    });
  }

  /* ▲▼ボタンを押したとき: レバーの持ち手を光らせて関係を見せる */
  flashGrip() {
    const g = this.els.leverGrip;
    g.classList.add('tb-flash');
    clearTimeout(this._flashT);
    this._flashT = setTimeout(() => g.classList.remove('tb-flash'), 320);
  }

  /* つぎにねらうノッチ(-8〜4)。その段の枠を点滅させる。null で消す(変わったときだけ書く) */
  setTarget(n) {
    const idx = n == null || !Number.isFinite(n) ? -1 : notchIdx(clamp(Math.round(n), -8, 4));
    if (idx === this._tgtIdx) return;
    const nt = this._nt || [];
    if (this._tgtIdx >= 0 && nt[this._tgtIdx]) nt[this._tgtIdx].classList.remove('tgt');
    if (idx >= 0 && nt[idx]) nt[idx].classList.add('tgt');
    this._tgtIdx = idx;
  }

  /* 天板の日だまり(x: 横の位置 -1..1、k: こさ 0..1)。1秒に10回まで、0.01 より変わったときだけ書く(合成だけで済む) */
  setSun(x, k) {
    const el = this._sunEl || (this._sunEl = this.root.querySelector('.cab-sun'));
    if (!el) return;
    x = Number.isFinite(x) ? clamp(x, -1, 1) : 0;
    k = Number.isFinite(k) ? clamp(k, 0, 1) : 0;
    const now = performance.now();
    const kOff = k === 0 && this._sunK !== 0;   // 消えるときは かならず書く
    if (!kOff && this._sunT != null && now - this._sunT < 100) return;
    const dk = this._sunK == null || Math.abs(k - this._sunK) > 0.01 || kOff;
    const dx = this._sunX == null || Math.abs(x - this._sunX) > 0.01;
    if (!dk && !dx) return;
    this._sunT = now;
    /* 夕方(16時はじまり)の日は だいだい(運転ごとに かわるだけ) */
    this._cls(el, 'cab-sun-eve', this.baseHour === 16);
    if (dk) { this._sunK = k; el.style.opacity = k.toFixed(2); }
    if (dx) { this._sunX = x; el.style.transform = `translateX(${(x * 55).toFixed(1)}%)`; }
  }

  /* 運転モニタの見出し(種別・行き先)。呼ばれるまでは sim から作る */
  setService({ svcHtml, color, destHtml } = {}) {
    this._svc = { svcHtml: svcHtml || '', color: color || '#8fa0aa', destHtml: destHtml || '' };
    this._hdrFor = null;
  }

  /* 室内の明るさ(0..1, scene.cockpit.light)。暗いと計器盤を減光し、計器だけ光らせる */
  setLight(lum) {
    if (!Number.isFinite(lum)) return;
    lum = clamp(lum, 0, 1);
    if (this._lum == null || Math.abs(lum - this._lum) > 0.02) {
      this._lum = lum;
      this.root.style.setProperty('--cab-lum', lum.toFixed(2));
    }
    /* 夜(.16)・トンネル(.3)は 夜の計器(文字盤の明かり)。夜のホーム(.46)でも夜のまま
     * (駅に とまるたびに 文字盤が 昼の色に かわらないように)。夕方(.55)・地下のホーム(.5)は 昼の計器 */
    const dark = lum < 0.5;
    const b = document.body;
    if (b.classList.contains('cab-dark') !== dark) b.classList.toggle('cab-dark', dark);
    if (dark !== this._night) { this._night = dark; this._k.night = -1; }
  }

  fmtClock(t) {
    /* ゲーム内時刻: 昼は10:00発、夜は19:00発 */
    const total = Math.floor(t) + (this.baseHour || 10) * 3600;
    const h = Math.floor(total / 3600) % 24;
    const m = Math.floor((total % 3600) / 60);
    const s = Math.floor(total % 60);
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }

  /* 時:分(ゲーム内) */
  _hm(t) {
    const total = Math.floor(t) + (this.baseHour || 10) * 3600;
    return `${Math.floor(total / 3600) % 24}:${String(Math.floor((total % 3600) / 60)).padStart(2, '0')}`;
  }

  /* 変わったときだけ書く */
  _set(el, s) { if (el._t !== s) { el._t = s; el.textContent = s; } }
  _cls(el, c, on) { const k = '_c_' + c; if (el[k] !== on) { el[k] = on; el.classList.toggle(c, on); } }

  /* ---------------- 毎フレーム ---------------- */
  render(h) {
    const sim = this.sim;
    if (!sim) return;
    if (!h) h = sim.hud();
    if (sim !== this._simRef) this._newRun(sim);
    /* 時間がとんだ(やりなおし・早送り)ときは表示の動き(ポン)をつけない */
    const lastT = this._lastSimT != null ? this._lastSimT : sim.t;
    this._jump = !(Math.abs(sim.t - lastT) < 1);
    /* 時間がもどった(駅からやりなおし): そのさきの駅・のこり距離の基準を作りなおす */
    if (sim.t < lastT - 0.5) { this._listIdx = null; this._limAt = null; }
    this._lastSimT = sim.t;
    if (h.notch !== this._lastNotch) this._renderNotch(h.notch);
    /* 駅でドアが開いているあいだの 出発信号(赤)は 注意にしない(のりおりを待っているだけ。
     * 赤い「とまれ」・きいろの帯・スピードちゅうい を出すと「なにか まちがえた」と思ってしまう) */
    const a = h.ats;
    this._dwellRed = !!h.doorOpen && !!a && a.kind === 'signal' && a.target === 0;
    this._renderSpeedo(h);
    this._renderBC(h.bc);
    this._cls(this.els.lampPat, 'on', (h.atsLamp === 'pattern' && !this._dwellRed) || h.atsLamp === 'brake');
    this._cls(this.els.lampBrk, 'on', h.atsLamp === 'brake');
    this._renderDoorLamp(!h.doorOpen && !h.finished);
    this._cls(this.els.lampSlip, 'on', !!h.slipping);
    this._renderTims(h, sim);
    this._renderLimit(h);
    this._renderGrade(h.grade);
  }

  /* ドアの灯(戸じめ): ドアが しまっているあいだ つく。ついた瞬間だけ 1.2秒 ふわっと光る(.just) */
  _renderDoorLamp(on) {
    const el = this.els.lampDoor;
    if (el._c_on === on) return;
    const was = el._c_on;
    this._cls(el, 'on', on);
    if (on && was === false && !this._jump) {
      el.classList.add('just');
      clearTimeout(this._doorJustT);
      this._doorJustT = setTimeout(() => el.classList.remove('just'), 1200);
    } else if (!on) {
      clearTimeout(this._doorJustT);
      el.classList.remove('just');
    }
  }

  /* 運転がかわった(新しい sim): 表示の記憶を捨てる */
  _newRun(sim) {
    this._simRef = sim;
    this._hdrFor = null;
    this._listIdx = null;
    this._lim = null;
    this._limKey = null;
    this._limKind = null;
    this._limAt = null;
    this._nextName = null;
    this._noNext = false;
    this._distK = null;
    this._delayK = null;
    this._depM = null;
    this._limSd = null;
    this._clockM = null;
    this._arrM = null;
    this._atSta = null;   // 最初のフレームでかならず「つぎは」「ただいま」を書く
    this._atCur = null;
    this._lastNotch = null;
    this._vs = null;
  }

  _renderNotch(n) {
    this._lastNotch = n;
    const idx = notchIdx(n);
    /* 1段ずつ動かしたときだけ 90ms でカチッと動く(CSS)。目盛りを遠くまでタップしたときなどは すぐその段へ */
    this._cls(this.els.leverGrip, 'lg-jump', !(this._onIdx >= 0 && Math.abs(idx - this._onIdx) === 1));
    if (this._onIdx >= 0 && this._nt[this._onIdx]) this._nt[this._onIdx].classList.remove('on');
    if (this._nt[idx]) this._nt[idx].classList.add('on');
    this._onIdx = idx;
    const g = this.els.leverGrip, z = zoneOf(n);
    if (this._gripZone !== z) {
      if (this._gripZone) g.classList.remove('lg-' + this._gripZone);
      else g.classList.remove('lg-n');
      g.classList.add('lg-' + z);
      this._gripZone = z;
    }
    /* 持ち手の字は 目盛り・コーチと同じ ことば(ひじょう) */
    this.els.gripT.textContent = n === -8 ? 'ひじょう' : n > 0 ? 'P' + n : n < 0 ? 'B' + -n : 'N';
    this._placeGrip(idx);
  }

  /* ---------------- 速度計 ---------------- */
  _renderSpeedo(h) {
    const W = this.speedo.width;
    if (!W) return;
    const v = Math.max(0, h.v || 0);
    /* 針はなめらかに追いかける(実時間で時定数0.1秒)。液晶は切り捨ての整数のまま */
    const now = performance.now();
    const dtR = this._vsT != null ? Math.min(1, (now - this._vsT) / 1000) : 1;
    this._vsT = now;
    if (this._vs == null || this._jump) this._vs = v;
    else this._vs += (v - this._vs) * Math.min(1, dtR * 10);
    if (Math.abs(v - this._vs) < 0.03) this._vs = v;
    /* 針: べつのキャンバスを CSS で回すだけ(0.05°より動いたときだけ書く。合成だけで済む) */
    const nd = this.needle;
    if (nd) {
      const deg = (angOf(Math.min(VMAX + 2, this._vs)) * 180) / Math.PI;
      if (this._ndDeg == null || Math.abs(deg - this._ndDeg) > 0.05) {
        this._ndDeg = deg;
        nd.style.transform = 'rotate(' + deg.toFixed(2) + 'deg)';
      }
    }
    const lim = h.limit;
    const a = this._dwellRed ? null : h.ats;
    const pat = a && a.pattern < lim ? a.pattern : 999;
    const patI = pat < 999 ? Math.floor(pat / 2.5) : 99;
    /* このさきの制限(線路わきの標識・信号)の目標スピード: その位置に小さいきいろの三角
     * (止まれの信号・駅の停止(0km/h)は出さない: 針の止まる位置にかさなるため) */
    const tgtI = a && a.kind !== 'stop' && a.target >= 2.5 && a.target < lim ? Math.floor(a.target / 2.5) : -1;
    const lamp = this._dwellRed && h.atsLamp === 'pattern' ? 'normal' : h.atsLamp;
    /* きいろの帯(パターン〜制限)を光らせるのは、ATSが注意を出しているか、パターンに近いときだけ
     * (駅で止まっているあいだは 帯を出さず、パターンのはじまりに 小さな印だけ) */
    const warn = lamp !== 'normal' || v > pat - 10 ? 1 : 0;
    const blinking = lamp === 'brake' || (lamp === 'pattern' && pat < lim);
    const blink = blinking ? ((now / 250) | 0) & 1 : 0;   // 2Hzで点滅
    const vi = Math.floor(v), night = this._night ? 1 : 0;
    /* 液晶の色: 制限+1 をこえたら あか(2Hzで点滅)、制限-5 をこえたら だいだい */
    const over = vi > lim + 1 ? 1 : 0, near = !over && vi > lim - 5 ? 1 : 0;
    const ob = over ? ((now / 250) | 0) & 1 : 0;
    const k = this._k;
    if (k.vi === vi && k.lim === lim && k.patI === patI && k.tgtI === tgtI && k.lamp === lamp && k.warn === warn && k.blink === blink && k.night === night && k.over === over && k.near === near && k.ob === ob && k.w === W) return;
    k.vi = vi; k.lim = lim; k.patI = patI; k.tgtI = tgtI; k.lamp = lamp; k.warn = warn; k.blink = blink; k.night = night; k.over = over; k.near = near; k.ob = ob; k.w = W;
    this._draws = (this._draws || 0) + 1;   // 描きなおした回数(確認用)
    this._drawSpeedo(vi, lim, pat, tgtI, lamp, warn, blink, night, over ? (ob ? 2 : 1) : near ? 3 : 0);
  }

  /* ink: 0 ふつう / 1 制限こえ(あか) / 2 制限こえ(点滅のうすいほう) / 3 制限ちかい(だいだい) */
  _drawSpeedo(vi, lim, pat, tgtI, lamp, warn, blink, night, ink) {
    const c = this.ctx, W = this.speedo.width, R = W / 2;
    const small = (this._cssW || 150) < 100;
    const px = W / (this._cssW || W);   // CSSの1pxぶん
    const dial = this._dial(W, night, small);
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, W, W);
    c.drawImage(dial, 0, 0);

    /* 区切りの帯: 消灯の地 → みどり(だいじょうぶ) → きいろ(このさき下げる)。制限より上は消灯のまま */
    const rr = R * 0.885, seg = (A1 - A0) / SEG_N;
    const limI = Math.floor(Math.min(lim, VMAX) / 2.5);
    const gI = Math.min(limI, Math.floor(Math.min(lim, pat) / 2.5));
    c.lineWidth = R * 0.07;
    c.lineCap = 'butt';
    /* 破線の長さは大きさが変わったときだけ作りなおす(毎回の配列を作らない) */
    if (!this._dash || this._dashW !== W) { this._dash = [rr * seg * 0.72, rr * seg * 0.28]; this._dashW = W; }
    c.setLineDash(this._dash);
    this._segArc(c, R, rr, 0, SEG_N, '#241514');
    let tick = false;
    if (lamp === 'brake') {
      if (!blink) this._segArc(c, R, rr, 0, limI, '#ff4a3d');
    } else {
      this._segArc(c, R, rr, 0, gI, '#1fa85a');
      /* パターン〜制限: 注意のときだけ きいろ(点滅)。ふだんは帯を出さず、パターンのはじまりに くすんだ印 */
      if (warn) this._segArc(c, R, rr, gI + 1, limI, lamp === 'pattern' && blink ? '#4a3812' : '#ffb32e');
      else tick = pat < lim;
    }
    c.setLineDash(NO_DASH);
    if (tick) this._wedge(c, R, px, pat, 0.03, '#b07a1e');

    /* 制限の三角(あか)と、このさきの目標(小さいきいろ)。中心をさす三角で、ふちは黒 */
    if (tgtI >= 0) this._wedge(c, R, px, tgtI * 2.5, 0.04, '#ffb32e');
    this._wedge(c, R, px, lim, 0.065, '#ff4a3d');

    /* 液晶: 速度(切り捨て)。小さい速度計では ATS の状態も出す */
    const lcd = this._lcdBox(R, small);
    let txt = String(vi);
    let col = ink === 1 ? '#ff5347' : ink === 2 ? '#ff9a8f' : ink === 3 ? '#ffc443' : night ? '#e6fff1' : '#d6ffe8';
    if (small && lamp !== 'normal') {
      c.fillStyle = lamp === 'brake' ? '#ff4a3d' : '#ffb32e';
      this._rrect(c, lcd.x + 1, lcd.y + 1, lcd.w - 2, lcd.h - 2, lcd.h * 0.25);
      c.fill();
      txt = lamp === 'brake' ? 'ブレーキ' : 'ちゅうい';
      col = '#140a00';
      c.font = `700 ${(lcd.h * 0.62).toFixed(1)}px "Zen Kaku Gothic New",sans-serif`;
    } else {
      c.font = `700 ${(lcd.h * (small ? 0.8 : 0.86)).toFixed(1)}px ${NUM_FONT}`;
    }
    c.fillStyle = col;
    c.textAlign = 'center'; c.textBaseline = 'middle';
    c.fillText(txt, R, lcd.y + lcd.h * 0.54, lcd.w - 4);

    /* ガラスの映り込み(グラデーションは大きさごとに作りおき)。針は べつのキャンバス(この上) */
    const g = this._grads(R);
    c.fillStyle = g.glass;
    c.beginPath(); c.arc(R, R, R * 0.915, 0, TAU); c.fill();
  }

  /* 区切りの帯の i0〜i1 番目(2.5km/hごと)を1本の破線の弧で */
  _segArc(c, R, rr, i0, i1, col) {
    if (i1 < i0) return;
    c.strokeStyle = col;
    c.beginPath();
    c.arc(R, R, rr, angOf(i0 * 2.5 - SEG_HALF), angOf(i1 * 2.5 + SEG_HALF));
    c.stroke();
  }

  /* 目盛りの外がわの三角(先が中心をさす)。sp: km/h、hw: 半分の幅(R に対する比) */
  _wedge(c, R, px, sp, hw, col) {
    const an = angOf(Math.min(VMAX, sp)), ca = Math.cos(an), sa = Math.sin(an);
    const r0 = R * 0.80, r1 = R * 0.95, w = R * hw;
    c.beginPath();
    c.moveTo(R + ca * r0, R + sa * r0);
    c.lineTo(R + ca * r1 - sa * w, R + sa * r1 + ca * w);
    c.lineTo(R + ca * r1 + sa * w, R + sa * r1 - ca * w);
    c.closePath();
    c.fillStyle = col; c.fill();
    c.lineWidth = px; c.lineJoin = 'round'; c.strokeStyle = '#000'; c.stroke();
  }

  _lcdBox(R, small) {
    /* 小さい速度計: 0 と 120 の数字にかからないよう、下のすきまいっぱいに。
     * ふつう: 大きな液晶(字は 約23px)。0 と 120 の数字は すこし外(半径 0.66)へ */
    return small ? { x: R - R * 0.41, y: R + R * 0.53, w: R * 0.82, h: R * 0.27 }
      : { x: R - R * 0.31, y: R + R * 0.33, w: R * 0.62, h: R * 0.36 };
  }

  _grads(R) {
    if (this._grad && this._grad.R === R) return this._grad;
    const c = this.ctx;
    const glass = c.createRadialGradient(R - 0.35 * R, R - 0.55 * R, 0, R - 0.35 * R, R - 0.55 * R, R * 0.9);
    glass.addColorStop(0, 'rgba(255,255,255,0.10)'); glass.addColorStop(1, 'rgba(255,255,255,0)');
    this._grad = { R, glass };
    return this._grad;
  }

  /* 角丸の四角(古いSafariには ctx.roundRect がないので arcTo で) */
  _rrect(c, x, y, w, h, r) {
    c.beginPath();
    c.moveTo(x + r, y);
    c.arcTo(x + w, y, x + w, y + h, r);
    c.arcTo(x + w, y + h, x, y + h, r);
    c.arcTo(x, y + h, x, y, r);
    c.arcTo(x, y, x + w, y, r);
    c.closePath();
  }

  /* 文字盤(動かない部分)は大きさ・昼夜ごとに一度だけ描いておく */
  _dial(W, night, small) {
    const key = W + (night ? 'n' : 'd') + (small ? 's' : '');
    if (this._dials[key]) return this._dials[key];
    const cv = document.createElement('canvas');
    cv.width = cv.height = W;
    const c = cv.getContext('2d');
    const R = W / 2, s = R / 75;
    c.translate(R, R);
    /* ベゼル(金属の縁)。夜は室内が暗いので、縁の金属も暗く(光るのは文字盤だけ) */
    const bz = c.createLinearGradient(-R, -R, R, R);
    const bzc = night ? ['#5b6266', '#2a3033', '#0d1012', '#3e4549'] : ['#c9d0d4', '#5d666c', '#1c2124', '#8c959b'];
    bz.addColorStop(0, bzc[0]); bz.addColorStop(0.35, bzc[1]); bz.addColorStop(0.65, bzc[2]); bz.addColorStop(1, bzc[3]);
    c.fillStyle = bz;
    c.beginPath(); c.arc(0, 0, R - 1, 0, TAU); c.fill();
    c.fillStyle = '#060708';
    c.beginPath(); c.arc(0, 0, R * 0.93, 0, TAU); c.fill();
    /* 盤面 */
    const face = c.createRadialGradient(0, -0.2 * R, 0, 0, -0.2 * R, R * 0.92);
    face.addColorStop(0, night ? '#161c20' : '#1d2327'); face.addColorStop(1, '#0a0c0e');
    c.fillStyle = face;
    c.beginPath(); c.arc(0, 0, R * 0.915, 0, TAU); c.fill();
    /* 目盛り: 5きざみ(細) / 10きざみ(中) / 20きざみ(太・数字) */
    const ink = night ? '#ffe2b0' : '#eef2f4';
    if (night) { c.shadowColor = 'rgba(255,190,110,0.8)'; c.shadowBlur = R * 0.04; }
    c.lineCap = 'butt';
    for (let v = 0; v <= VMAX; v += 5) {
      const an = angOf(v), major = v % 20 === 0, mid = v % 10 === 0;
      const r0 = major ? 0.76 : 0.80, r1 = 0.86;
      c.strokeStyle = major ? ink : mid ? (night ? '#c9b48e' : '#a3adb3') : (night ? '#8c7c62' : '#6b757b');
      c.lineWidth = (major ? 3 : mid ? 2 : 1.2) * s;
      c.beginPath();
      c.moveTo(Math.cos(an) * R * r0, Math.sin(an) * R * r0);
      c.lineTo(Math.cos(an) * R * r1, Math.sin(an) * R * r1);
      c.stroke();
    }
    c.fillStyle = ink;
    c.textAlign = 'center'; c.textBaseline = 'middle';
    c.font = `700 ${(R * (small ? 0.19 : 0.18)).toFixed(1)}px ${NUM_FONT}`;
    /* 数字は 目盛りの線(0.76R から外)に かからない半径に。字の はば・高さを 角度の向きに投影した半分だけ 内へ
     * (3時の「100」は 横に長いので内へ、12時の「60」は 高さのぶんだけ) */
    const nh = (small ? 0.19 : 0.18) * 0.72, rn0 = small ? 0.70 : 0.72;
    for (let v = 0; v <= VMAX; v += 20) {
      const an = angOf(v), str = String(v), w = c.measureText(str).width / R;
      const ext = Math.abs(Math.cos(an)) * w / 2 + Math.abs(Math.sin(an)) * nh / 2;
      const rn = rn0 - ext;
      c.fillText(str, Math.cos(an) * R * rn, Math.sin(an) * R * rn);
    }
    c.shadowBlur = 0; c.shadowColor = 'transparent';
    if (!small) {
      c.fillStyle = night ? '#a8977a' : '#7d8890';
      c.font = `500 ${(R * 0.1).toFixed(1)}px ${NUM_FONT}`;
      c.fillText('km/h', 0, R * 0.24);
    }
    /* 液晶の窓 */
    c.translate(-R, -R);
    const lcd = this._lcdBox(R, small);
    c.fillStyle = '#06140f';
    this._rrect(c, lcd.x, lcd.y, lcd.w, lcd.h, lcd.h * 0.22);
    c.fill();
    c.strokeStyle = '#000'; c.lineWidth = Math.max(1, s);
    c.stroke();
    c.strokeStyle = 'rgba(255,255,255,0.08)'; c.lineWidth = 1;
    c.beginPath(); c.moveTo(lcd.x + lcd.h * 0.25, lcd.y + lcd.h + 0.5 * s); c.lineTo(lcd.x + lcd.w - lcd.h * 0.25, lcd.y + lcd.h + 0.5 * s); c.stroke();
    this._dials[key] = cv;
    return cv;
  }

  /* ブレーキの強さ: 8つのLED(つくのは数が変わったときだけ) */
  _renderBC(bc) {
    const n = clamp(Math.round(((bc || 0) / 4.6) * 8), 0, 8);
    if (n === this._bcN) return;
    const leds = this.els.bcLeds;
    for (let i = 0; i < leds.length; i++) {
      const on = i < n;
      if (on !== (i < (this._bcN || 0))) leds[i].classList.toggle('on', on);
    }
    this._bcN = n;
  }

  /* ---------------- 運転モニタ ---------------- */
  _renderTims(h, sim) {
    const E = this.els;
    /* 見出し(種別・行き先): 運転ごとに1回 */
    if (this._hdrFor !== sim) {
      this._hdrFor = sim;
      let svc = this._svc;
      if (!svc) {
        const key = sim.serviceKey || 'local', info = SVC[key] || SVC.local;
        const name = (sim.service && sim.service.name) || '';
        const last = sim.stops && sim.stops[sim.stops.length - 1];
        svc = { svcHtml: ruby(name, info.kana), color: info.color, destHtml: last ? `${rubySt(last.name)} ゆき` : '' };
      }
      E.timsSvc.innerHTML = svc.svcHtml;
      E.timsSvc.style.setProperty('--svc', svc.color);
      E.timsDest.innerHTML = svc.destHtml;
    }
    /* 時計(時:分。コロンの点滅はCSS) */
    const cm = Math.floor((sim.t + (this.baseHour || 10) * 3600) / 60);
    if (cm !== this._clockM) {
      this._clockM = cm;
      const hh = Math.floor(cm / 60) % 24, mm = String(cm % 60).padStart(2, '0');
      E.timsClock.innerHTML = `${hh}<i class="tc-c">:</i>${mm}`;
    }
    const nx = h.next;
    /* 駅でドアが開いているあいだは「ただいま <いまの駅>」、つぎの駅は小さく(停止の判定カード・スタンプと同じ駅) */
    const cur = sim.stopIdx > 0 && sim.stops ? sim.stops[sim.stopIdx - 1] : null;
    const atSta = !!h.doorOpen && !!cur;
    if (atSta !== this._atSta || (atSta && cur !== this._atCur)) {
      this._atSta = atSta;
      this._atCur = atSta ? cur : null;
      if (E.timsCap) E.timsCap.textContent = atSta ? 'ただいま' : 'つぎは';
      this._cls(E.timsDist, 'tims-dist-small', atSta);
      if (atSta) { this._cls(E.timsDist, 'late', false); this._cls(E.timsDist, 'near', false); }
      if (atSta) {
        E.timsNext._t = null;
        E.timsNext.innerHTML = rubySt(cur.name);
        E.timsDist.innerHTML = nx ? `つぎは ${rubySt(nx.name)}` : '';
      }
      /* ドアが閉まったら、つぎの駅・のこり距離・つく時刻を書きなおす */
      this._nextName = null; this._distK = null; this._arrM = null; this._noNext = false; this._delayK = null; this._depM = null;
    }
    if (!nx) {
      if (!this._noNext) {
        this._noNext = true;
        this._nextName = null; this._distK = null; this._delayK = null;
        if (!atSta) { E.timsNext.textContent = '—'; E.timsDist.textContent = ''; }
        E.timsDelay.textContent = '';
        E.timsSch._t = null; E.timsSch.textContent = ''; this._arrM = null;
      }
      return;
    }
    this._noNext = false;
    if (!atSta && this._nextName !== nx.name) {
      this._nextName = nx.name;
      E.timsNext._t = null;
      E.timsNext.innerHTML = rubySt(nx.name);
    }
    /* そのさきの駅(3つまで): 駅をすぎたときだけ作りなおす */
    if (this._listIdx !== sim.stopIdx) {
      this._listIdx = sim.stopIdx;
      const items = [];
      const lastI = sim.stops.length - 1;
      for (let i = sim.stopIdx; i < Math.min(sim.stops.length, sim.stopIdx + 3); i++) {
        const st = sim.stops[i], tt = sim.timetable && sim.timetable[i];
        /* 終点(この運転のゴール)は黄色いわくの「ゴール」をつける */
        const cls = [i === sim.stopIdx ? 'next' : '', i === lastI ? 'goal' : ''].filter(Boolean).join(' ');
        items.push(`<li${cls ? ` class="${cls}"` : ''}><span class="tl-n">${rubySt(st.name)}</span>${i === lastI ? '<span class="tl-goal">ゴール</span>' : ''}<span class="tl-t">${tt ? this._hm(tt.arr) : ''} つく</span></li>`);
      }
      E.timsList.innerHTML = items.join('');
      const cur = sim.stops[sim.stopIdx], prev = sim.stops[sim.stopIdx - 1];
      this._segLen = cur && prev ? Math.max(1, cur.stopAt - prev.stopAt) : 0;
      this._prog = null;
    }
    /* のこりの距離(m は1mごと、km は10mごと)。とまる位置を すぎたら「すぎた ◯m」(あか)。
     * だいだい(.near)は「いま ブレーキ」のときだけ(コーチ・ブレーキめやすと同じ きまり: だいだい = いま やる) */
    const d = Math.max(0, nx.dist);
    const past = nx.dist < -0.5;
    const dk = past ? -1 - Math.round(-nx.dist) : d >= 1000 ? 100000 + Math.round(d / 100) : Math.round(d);
    if (!atSta && dk !== this._distK) {
      this._distK = dk;
      /* km は 小数1けた(上の帯と同じ書き方) */
      E.timsDist.textContent = past ? `すぎた ${Math.round(-nx.dist)} m` : d >= 1000 ? (d / 1000).toFixed(1) + ' km' : Math.round(d) + ' m';
      this._cls(E.timsDist, 'late', past);
    }
    if (!atSta) this._cls(E.timsDist, 'near', !past && h.uiBrakeNow === true);
    /* つく時刻(分が変わったときだけ文字列を作る。毎フレームの文字列づくりをしない) */
    const am = Math.floor(nx.arr / 60);
    if (am !== this._arrM) { this._arrM = am; this._set(E.timsSch, `${this._hm(nx.arr)} つく`); }
    if (atSta) {
      /* 駅で止まっているあいだは しゅっぱつの時刻(のこり秒は画面の下のコーチが言う。数字を2か所に出さない) */
      const dm = nx.dep != null ? Math.floor(nx.dep / 60) : -1;
      if (dm !== this._depM) {
        this._depM = dm;
        this._delayK = null;
        E.timsDelay.textContent = dm >= 0 ? `しゅっぱつ ${this._hm(nx.dep)}` : '';
        this._cls(E.timsDelay, 'late', false);
      }
    } else {
      this._depM = null;
      /* じかん: 分のきざみ。時計(上の 時:分)と つく時刻(時:分)の ひき算と かならず同じ数に
       * (どちらも 表示している「分」で数える。時計の分が かわるのと 同じコマで かわる) */
      const b = (this.baseHour || 10) * 3600;
      const mNow = Math.floor((sim.t + b) / 60), mArr = Math.floor((nx.arr + b) / 60);
      let dk2, txt, late = false;
      if (nx.arr >= sim.t) {
        const m = Math.max(0, mArr - mNow);
        dk2 = m;
        txt = m >= 1 ? `つく じかんまで あと ${m}${fun(m)}` : 'もうすぐ つく じかん';
      } else {
        const m = Math.max(0, mNow - mArr);
        dk2 = -1 - m;
        txt = m === 0 ? 'すこし おくれ' : `${m}${fun(m)} おくれ`;
        late = true;
      }
      if (dk2 !== this._delayK) { this._delayK = dk2; E.timsDelay.textContent = txt; this._cls(E.timsDelay, 'late', late); }
    }
    /* すすみぐあい(前の駅→つぎの駅) */
    {
      const p = this._segLen ? Math.round(clamp(1 - d / this._segLen, 0, 1) * 400) : 0;
      if (p !== this._prog) { this._prog = p; E.timsProg.style.transform = `scaleX(${(p / 400).toFixed(4)})`; }
    }
  }

  /* ---------------- 制限スピード ---------------- */
  _renderLimit(h) {
    const E = this.els;
    if (h.limit !== this._lim) {
      const first = this._lim == null;
      this._lim = h.limit;
      E.limNow.textContent = h.limit;
      this._cls(E.limNow, 'l3', h.limit >= 100);
      /* かわったときだけ「ポン」と、白いふちが 0.6秒 光る(目が計器盤にいくように) */
      if (!first && !this._jump) {
        if (E.limNow.animate) E.limNow.animate([{ transform: 'scale(1.25)' }, { transform: 'scale(1)' }], { duration: 450, easing: 'cubic-bezier(.2,1.6,.4,1)' });
        E.limNow.classList.add('flash');
        clearTimeout(this._limFlashT);
        this._limFlashT = setTimeout(() => E.limNow.classList.remove('flash'), 600);
      }
    }
    const a = h.ats;
    /* このさきの制限・信号は 700m 手前から(上の帯と同じ)。駅で のりおり中の 赤信号は 出さない */
    if (a && (a.kind === 'limit' || a.kind === 'signal') && a.at - h.pos < LOOKAHEAD && !this._dwellRed) {
      if (a.at !== this._limAt) { this._limAt = a.at; this._limD0 = Math.max(1, a.at - h.pos); this._limSd = null; }
      if (a.kind !== this._limKind || a.target !== this._limKey) {
        this._limKind = a.kind; this._limKey = a.target;
        let l1;
        if (a.kind === 'limit') l1 = `<b class="ln-board">${a.target}</b>まで`;
        else if (a.target === 0) l1 = '<i class="ln-sig"></i>しんごう とまれ';
        else l1 = `<i class="ln-sig ln-sig-y"></i>しんごう <b class="ln-board">${a.target}</b>`;
        E.limNext.innerHTML = `<span class="ln-l1">${l1}</span><span class="ln-l2">あと <b class="ln-d"></b>m</span><i class="ln-bar"><s></s></i>`;
        this._lnD = E.limNext.querySelector('.ln-d');
        this._lnBar = E.limNext.querySelector('.ln-bar s');
        this._lnBarK = null;
        this._lnD._t = null;
      }
      /* 「あと ◯m」: コーチと同じ数(main.js が h.uiLimAt に まるめた距離を入れる)。
       * なければ 同じ きざみ(100m以上 10m・20m以上 5m・ほか 1m)で、半きざみ以上 かわったときだけ */
      const raw = Math.max(0, a.at - h.pos);
      let d;
      if (typeof h.uiLimAt === 'number' && a.kind === 'limit') d = Math.max(0, Math.round(h.uiLimAt));
      else {
        const prev = this._limSd;
        if (prev != null && Math.abs(raw - prev) < qStep(prev) * 0.75) d = prev;
        else d = Math.round(raw / qStep(raw)) * qStep(raw);
        this._limSd = d;
      }
      this._set(this._lnD, String(d));
      const bk = Math.round(clamp(raw / this._limD0, 0, 1) * 200);
      if (bk !== this._lnBarK) { this._lnBarK = bk; this._lnBar.style.transform = `scaleX(${(bk / 200).toFixed(3)})`; }
      this._cls(E.limNext, 'hidden', false);
    } else {
      this._cls(E.limNext, 'hidden', true);
      this._limAt = null;
      this._limSd = null;
    }
  }

  /* 勾配: たいら / のぼりざか / くだりざか。きつさは 小さな棒の数(10‰まで 1本・20‰まで 2本・それより きつい 3本と「きつい」)。
   * ‰ の数字は 小学2年生には読めないので出さない */
  _renderGrade(g) {
    const kind = Math.abs(g) < 1.5 ? 0 : g > 0 ? 1 : -1;
    const pm = Math.abs(g);
    const pips = kind === 0 ? 0 : pm >= 20 ? 3 : pm >= 10 ? 2 : 1;
    const key = kind * 10 + pips;
    if (key === this._gradeK) return;
    this._gradeK = key;
    this.els.grade.innerHTML = kind === 0 ? '<i class="gr-ico gr-0"></i>たいら'
      : `<i class="gr-ico gr-${kind > 0 ? 'up' : 'dn'}"></i>${kind > 0 ? 'のぼりざか' : 'くだりざか'}`
        + `<span class="gr-pips gr-${kind > 0 ? 'up' : 'dn'}-c" aria-hidden="true">${'<i></i>'.repeat(pips)}</span>${pips === 3 ? `<span class="gr-hard gr-${kind > 0 ? 'up' : 'dn'}-c">きつい</span>` : ''}`;
  }
}
