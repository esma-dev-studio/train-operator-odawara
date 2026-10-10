/* =========================================================
 * main.js — 画面遷移・ゲームループ・入力・記録
 * 3Dステージは常に1つ。タイトル/選択画面では自動運転の列車が
 * 背景を走り(デモ走行)、出発するとプレイヤーの列車に切り替わる。
 * ========================================================= */
import * as THREE from './vendor/three.module.min.js';
import { TrainSim, SERVICES } from './sim/engine.js';
import { RailScene } from './scene/scene.js';
import { Cab } from './cab/cab.js';
import { CabAudio } from './audio/audio.js';
import { Announcer } from './audio/announce.js';
import { kanaOf, rubyStation } from './sim/kana.js';
import { prepareLine } from './sim/line.js';
import { makeAutopilot } from './sim/autopilot.js';
import { drawStamp, stampColor } from './ui/stamps.js';
import { RainGlass } from './ui/rainglass.js';
import { BADGES, badgeById } from './ui/badges.js';
import { icon, hydrateIcons } from './ui/icons.js';

/* 種別名のふりがな */
const SVC_KANA = { '各駅停車': 'かくえきていしゃ', '急行': 'きゅうこう', '快速急行': 'かいそくきゅうこう' };
const SVC_COLOR = { local: '#8fa0aa', exp: '#ff6b3d', rapid: '#3fb0ff' };
const rubySvc = (name) => SVC_KANA[name] ? `<ruby>${name}<rt>${SVC_KANA[name]}</rt></ruby>` : name;
const CAM_MODES = ['cab', 'chase', 'side', 'front', 'drone'];
const CAM_NAME = { cab: 'うんてんせき', chase: 'うしろから', side: 'よこから', front: 'せんろわきから', drone: 'そらから' };

/* 停止位置のひょうか(◎ぴったり ±35cm / ○いいね ±1m / △おしい ±2m / ×ざんねん) */
const gradeOf = (abs) => (abs <= 0.35 ? { k: 'perfect', mark: '◎', word: 'ぴったり', col: 'var(--green)' }
  : abs <= 1 ? { k: 'good', mark: '○', word: 'いいね', col: 'var(--acc-2)' }
    : abs <= 2 ? { k: 'ok', mark: '△', word: 'おしい', col: 'var(--amber)' }
      : { k: 'ng', mark: '×', word: 'ざんねん', col: 'var(--red)' });
/* スタンプのランク: 3=きん(±10cm) 2=いろ(±35cm) 1=くろ(±1m) */
const tierOf = (abs) => (abs <= 0.10 ? 3 : abs <= 0.35 ? 2 : abs <= 1 ? 1 : 0);
const TIER_WORD = ['', 'くろ', 'いろ', 'きん'];
/* ずれをcmで(子どもには「+0.06m」より「6cm いきすぎ」) */
const cmOf = (err) => Math.round(Math.abs(err) * 100);
const errTxt = (err) => { const cm = cmOf(err); return cm < 5 ? 'ぴったり' : `${cm}cm ${err > 0 ? 'いきすぎ' : 'てまえ'}`; };
/* よみこみ中に出す ひとことヒント */
const LOAD_TIPS = ['レバーを したに うごかすと ブレーキ', '「8」のかんばんに ぴったり とめよう', 'きいろの しんごうは スピードを おとす'];
const RANK_LINE = [[95, 'S'], [85, 'A'], [70, 'B'], [55, 'C']];

const $ = (s) => document.querySelector(s);
const SAVE_KEY = 'trainop_v2';
const SET_KEY = 'trainop_settings';
const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()));
const store = {
  get(k, def) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : def; } catch (e) { return def; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* 保存できなくても続行 */ } },
};
/* 毎フレームのDOM書きこみは「かわったときだけ」 */
const setText = (el, s) => { if (el._t !== s) { el._t = s; el.textContent = s; } };
const setHtml = (el, s) => { if (el._h !== s) { el._h = s; el.innerHTML = s; } };
const setCls = (el, s) => { if (el._c !== s) { el._c = s; el.className = s; } };
const setHidden = (el, hide) => { if (el._hid !== hide) { el._hid = hide; el.classList.toggle('hidden', hide); } };

/* 実際の時刻に合わせて、タイトルのデモ走行を昼・夕方・夜にする */
const realTod = () => { const h = new Date().getHours(); return h >= 5 && h < 16 ? 'day' : h >= 16 && h < 18 ? 'evening' : 'night'; };

const App = {
  rawLine: null, line: null, timetable: null,
  sim: null, scene: null, cab: null, audio: null, announcer: null,
  mode: 'boot',              // boot | title | select | drive | result | stamps
  running: false, paused: false,
  service: 'local', weather: 'clear', daytime: 'day', direction: 'down',
  startIdx: 0, endIdx: null,
  camIdx: 0,
  debug: /[?&]debug=1/.test(location.search),

  /* ================= 起動 ================= */
  async boot() {
    hydrateIcons();
    this.loadSave();
    this.settings = Object.assign({ volume: 0.8, voice: true, guide: true, quality: null }, store.get(SET_KEY, {}));
    const touch = matchMedia('(pointer: coarse)').matches;
    const qp = (location.search.match(/[?&]q=(high|mid|low)/) || [])[1];   // 検証用の画質指定
    this._qp = qp;
    this.quality = qp || this.settings.quality || (touch ? 'mid' : 'high');
    this.bindUI();
    this._startLoadTips();
    this.setLoad(0.05, 'せんろを よみこみ中…');
    /* テクスチャ・空の読み込み進捗をバーに出す */
    let texDone = 0, texTotal = 1;
    THREE.DefaultLoadingManager.onProgress = (u, a, b) => { texDone = a; texTotal = b; this.setLoad(0.35 + 0.6 * (a / b), 'けしきを よみこみ中…'); };
    const [line, tt] = await Promise.all([
      fetch('./data/line.json').then((r) => r.json()),
      fetch('./data/timetable.json').then((r) => r.json()),
    ]);
    this.rawLine = line; this.timetable = tt;
    this.line = prepareLine(line, this.direction);
    this.setLoad(0.25, 'まちを つくっています…');
    await nextFrame();
    /* デモ走行の列車と3Dステージ */
    this.attract = this._makeAttract();
    try {
      this.scene = new RailScene($('#gl'), this.attract.line, this.attract.sim, {
        quality: this.quality, timeOfDay: this.attract.tod, weather: 'clear',
        autoQ: !qp && !this.settings.quality,   // 画質「じどう」のときだけ、前回の軽量化レベルを引きつぐ
      });
      this.scene.guide = this.settings.guide;
    } catch (err) {
      this.setLoad(1, '3Dが ひょうじできませんでした。ブラウザを さいしんに してね。(' + (err && err.message ? err.message : err) + ')');
      return;
    }
    this.cab = new Cab(this.attract.sim);
    this._bindInput();
    this.rainGlass = new RainGlass($('#rain-glass'));
    this.audio = new CabAudio();
    this.announcer = new Announcer();
    this.announcer.setEnabled(this.settings.voice);
    this.applyVolume();
    this.resizeGL();
    this.buildSelect();
    /* 空(HDRI)の読み込みを少しだけ待つ(最大4秒) */
    const t0 = performance.now();
    while (texDone < texTotal && performance.now() - t0 < 4000) await new Promise((r) => setTimeout(r, 100));
    this.setLoad(1, 'じゅんび OK');
    this.updateStampCount();
    /* シェーダーを先に作っておく(デモ走行が運転台視点に切りかわったときに止まらない) */
    if (this.scene.prewarm) { try { this.scene.prewarm(); } catch (e) { /* 先読みできなくても続行 */ } }
    this.go('title');
    if (!this._rafStarted) { this._rafStarted = true; this.loop(); }
    this.registerSW();
    if (this.debug) this._exposeTest();
  },

  setLoad(k, txt) {
    const f = $('#load-fill');
    if (f) f.style.width = Math.round(k * 100) + '%';
    if (txt) $('#load-txt').textContent = txt;
  },

  _startLoadTips() {
    const el = $('#load-tip');
    if (!el) return;
    let i = 0;
    clearInterval(this._tipT);
    this._tipT = setInterval(() => {
      i = (i + 1) % LOAD_TIPS.length;
      el.classList.remove('tip-in'); void el.offsetWidth;
      el.textContent = LOAD_TIPS[i];
      el.classList.add('tip-in');
    }, 2500);
  },

  loadSave() {
    this.save = Object.assign({ best: {}, stamps: {}, badges: {}, runs: 0, perfect: 0, cams: {},
      stampTier: {}, bestErr: {}, bestSeg: {}, last: null }, store.get(SAVE_KEY, {}));
    ['stampTier', 'bestErr', 'bestSeg'].forEach((k) => { if (!this.save[k]) this.save[k] = {}; });
    /* 以前の「±35cmだけのスタンプ」は いろつき(ランク2)として引きつぐ */
    Object.keys(this.save.stamps).forEach((n) => {
      if (this.save.stamps[n] > 0 && !this.save.stampTier[n]) this.save.stampTier[n] = 2;
    });
    /* v1(くだり・全区間のみ)のベストを引き継ぐ */
    const old = store.get('trainop_v1', null);
    if (old && old.best && !this.save._migrated) {
      Object.entries(old.best).forEach(([k, v]) => {
        const [svc, wx] = k.split('_');
        const nk = `${svc}_down_${wx}`;
        if (!this.save.best[nk]) this.save.best[nk] = v;
      });
      this.save._migrated = true;
      store.set(SAVE_KEY, this.save);
    }
  },
  writeSave() { store.set(SAVE_KEY, this.save); },
  _stampKinds() { return Object.keys(this.save.stampTier).filter((n) => this.save.stampTier[n] >= 1).length; },

  registerSW() {
    if (!('serviceWorker' in navigator) || location.protocol === 'file:' || this.debug) return;
    navigator.serviceWorker.register('./sw.js').catch(() => { /* オフライン対応なしでも遊べる */ });
  },

  /* ================= デモ走行(タイトル背景) ================= */
  _makeAttract() {
    const line = prepareLine(this.rawLine, 'down');
    const sim = new TrainSim(line, { service: 'exp', weather: 'clear', timetable: this.timetable });
    const start = 3;   // 経堂から: 複々線を快走 → 車両基地 → 多摩川
    sim.reset(start);
    sim.skipDwell();
    return { line, sim, ap: makeAutopilot(sim), start, tod: realTod(), camT: 0, camI: 0 };
  },

  _attractTick(dt) {
    const A = this.attract;
    if (!A || !this.scene) return;
    const sim = A.sim;
    if (sim.doorOpen) sim.skipDwell();
    A.ap();
    sim.tick(dt);
    if (sim.ended || sim.stopIdx >= sim.stops.length - 1) {
      sim.reset(A.start); sim.skipDwell();
      A.ap = makeAutopilot(sim);
      if (this.scene.traffic) this.scene.traffic.reset(sim);
      this.scene._camPos = null;
    }
    A.camT += dt;
    const seq = ['chase', 'side', 'front', 'drone', 'cab', 'side'];
    if (A.camT > 9) {
      A.camT = 0;
      A.camI = (A.camI + 1) % seq.length;
      this.scene.setCameraMode(seq[A.camI]);
      document.body.classList.toggle('cam-cab', seq[A.camI] === 'cab');
    }
    const nx = sim.stops[sim.stopIdx];
    const txt = `LIVE ・ ${SERVICES.exp.name} しんゆりがおか ゆき ・ ${nx ? 'つぎは ' + kanaOf(nx.name) + ' ・ ' : ''}${CAM_NAME[this.scene.camMode] || ''}`;
    if (txt !== this._liveTxt) { this._liveTxt = txt; $('#live-txt').textContent = txt; }
  },

  _enterAttract() {
    const A = this.attract;
    if (!A) return;
    this.scene.setWorld(A.line, A.sim);
    this.scene.setTimeOfDay(A.tod);
    this.scene.setWeather('clear');
    this.scene.setCameraMode('chase');
    A.camT = 0; A.camI = 0;
    this.rainGlass.setActive(false);
  },

  /* ================= 画面遷移 ================= */
  go(mode) {
    const prev = this.mode;
    this.mode = mode;
    document.body.className = 'mode-' + mode + (this.scene && this.scene.camMode === 'cab' ? ' cam-cab' : '');
    const screens = { title: 'title', select: 'select', result: 'result', stamps: 'stamps', boot: 'loading' };
    document.querySelectorAll('.screen').forEach((el) => {
      if (el.classList.contains('overlay')) return;
      el.classList.toggle('active', el.id === 'screen-' + screens[mode]);
    });
    if (mode === 'title') { clearInterval(this._tipT); this._tipT = null; }
    if ((mode === 'title' || mode === 'select' || mode === 'stamps') && (prev === 'drive' || prev === 'result' || prev === 'boot')) {
      if (this._qualityDirty) this._rebuildScene();
      this._enterAttract();
    }
    if (mode === 'stamps') this.buildStampBook();
    if (mode === 'title') this.updateStampCount();
    this.resizeGL();
  },

  /* ================= 選択画面 ================= */
  buildSelect() {
    /* 前回えらんだ列車を おぼえておく(はじめての子は 2駅の みじかい運転から) */
    const L = this.save.last;
    if (L && SERVICES[L.service]) {
      this.direction = L.direction === 'up' ? 'up' : 'down';
      this.service = L.service;
      this.daytime = ['day', 'evening', 'night'].includes(L.daytime) ? L.daytime : 'day';
      this.weather = ['clear', 'rain', 'snow'].includes(L.weather) ? L.weather : 'clear';
      this.line = prepareLine(this.rawLine, this.direction);
      this.startIdx = L.startIdx || 0;
      this.endIdx = L.endIdx == null ? null : L.endIdx;
    } else if ((this.save.runs || 0) < 3) {
      this.startIdx = 0; this.endIdx = 2;
    }
    $('#dir-seg').querySelectorAll('button').forEach((b) => {
      b.classList.toggle('on', b.dataset.dir === this.direction);
      b.addEventListener('click', () => {
        if (this.direction === b.dataset.dir) return;
        this.direction = b.dataset.dir;
        $('#dir-seg').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
        this.line = prepareLine(this.rawLine, this.direction);
        /* むきを かえたら、区間の長さは そのままで はじめから */
        const span = this.endIdx == null ? null : this.endIdx - this.startIdx;
        this.startIdx = 0; this.endIdx = span; this._pick = 'start';
        this.renderSvcCards(); this.renderRoute(true);
      });
    });
    const segBind = (id, key) => {
      $(id).querySelectorAll('button').forEach((b) => {
        b.classList.toggle('on', b.dataset.v === this[key]);
        b.addEventListener('click', () => {
          this[key] = b.dataset.v;
          $(id).querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
          this.renderSummary();
        });
      });
    };
    segBind('#tod-seg', 'daytime');
    segBind('#wx-seg', 'weather');
    $('#rq-short').addEventListener('click', () => {
      const n = this._svcStops().length;
      if (this.startIdx > n - 3) this.startIdx = Math.max(0, n - 3);
      this.endIdx = Math.min(n - 1, this.startIdx + 2);
      this._pick = 'start'; this.renderRoute(true);
    });
    $('#rq-half').addEventListener('click', () => {
      const n = this._svcStops().length;
      this.endIdx = Math.min(n - 1, this.startIdx + Math.max(2, Math.ceil((n - 1) / 2)));
      this._pick = 'start'; this.renderRoute(true);
    });
    $('#rq-all').addEventListener('click', () => { this.startIdx = 0; this.endIdx = null; this._pick = 'start'; this.renderRoute(true); });
    this._pick = 'start';
    this.renderSvcCards();
    this.renderRoute();
  },

  _svcStops() {
    const svc = SERVICES[this.service];
    return this.line.stations.filter((st) => !svc.stops || svc.stops.includes(st.name));
  },
  _ttKey() { return this.service + (this.direction === 'up' ? '_up' : ''); },
  _durOf(key) {
    const t = this.timetable[key + (this.direction === 'up' ? '_up' : '')];
    return t ? Math.round(t[t.length - 1][0] / 60) : null;
  },

  renderSvcCards() {
    const wrap = $('#svc-list');
    wrap.innerHTML = Object.entries(SERVICES).map(([key, s]) => {
      const stops = s.stops ? s.stops.length : this.line.stations.length;
      const best = ['clear', 'rain', 'snow'].map((w) => this.save.best[`${key}_${this.direction}_${w}`]).filter(Boolean)
        .sort((a, b) => b.total - a.total)[0];
      const dur = this._durOf(key);
      return `<button class="svc-card${key === this.service ? ' sel' : ''}" data-svc="${key}" style="--svc:${SVC_COLOR[key]}">
        <span class="svc-band"></span>
        <span class="svc-name">${rubySvc(s.name)}</span>
        <span class="svc-meta"><span class="nw">とまる<ruby>駅<rt>えき</rt></ruby> ${stops}</span> <span class="nw">ぜんぶで ${dur == null ? '—' : dur}ぷん</span></span>
        <span class="svc-best">${best ? `ベスト ${best.total}てん (${best.rank})` : 'まだ きろくなし'}</span>
      </button>`;
    }).join('');
    wrap.querySelectorAll('.svc-card').forEach((b) => {
      b.addEventListener('click', () => {
        if (this.service === b.dataset.svc) return;
        /* 種別をかえても、えらんだ駅は できるだけ のこす:
         * スタートは その駅か手前の とまる駅、ゴールは その駅か先の とまる駅 にする(区間がちぢまない) */
        const old = this._svcStops();
        const sName = old[this.startIdx] ? old[this.startIdx].name : null;
        const eName = this.endIdx == null ? null : (old[this.endIdx] ? old[this.endIdx].name : null);
        this.service = b.dataset.svc;
        const st = this._svcStops();
        const li = (nm) => this.line.stations.findIndex((s) => s.name === nm);
        const lineIdxOf = (s) => this.line.stations.indexOf(s);
        if (sName) {
          const ls = li(sName);
          let si = 0;
          st.forEach((s, i) => { if (lineIdxOf(s) <= ls) si = i; });
          this.startIdx = si;
        }
        if (eName) {
          const le = li(eName);
          const ei = st.findIndex((s) => lineIdxOf(s) >= le);
          this.endIdx = ei < 0 || ei >= st.length - 1 ? null : ei;
        }
        if (this.startIdx >= (this.endIdx == null ? st.length - 1 : this.endIdx)) { this.startIdx = 0; this.endIdx = null; }
        this._pick = 'start';
        this.renderSvcCards();
        this.renderRoute(true);
      });
    });
  },

  renderRoute(scroll = false) {
    const stops = this._svcStops();
    const n = stops.length;
    if (this.startIdx > n - 2) this.startIdx = 0;
    const end = this.endIdx == null ? n - 1 : Math.min(n - 1, Math.max(this.startIdx + 1, this.endIdx));
    this.endIdx = end === n - 1 ? null : end;
    const tt = this.timetable[this._ttKey()];
    const sIdx = this.line.stations.indexOf(stops[this.startIdx]);
    const eIdx = this.line.stations.indexOf(stops[end]);
    const html = this.line.stations.map((st, lineIdx) => {
      const si = stops.indexOf(st);
      const isStop = si >= 0;
      let cls = 'rt' + (isStop ? '' : ' pass');
      if (lineIdx >= sIdx && lineIdx <= eIdx) cls += ' in';
      if (lineIdx === sIdx) cls += ' start in-edge-top';
      if (lineIdx === eIdx) cls += ' goal in-edge-bot';
      const tag = lineIdx === sIdx ? '<span class="rt-tag">スタート</span>' : lineIdx === eIdx ? '<span class="rt-tag">ゴール</span>'
        : isStop && tt && tt[si] && si > this.startIdx && si <= end ? `<span class="rt-time">${Math.round((tt[si][0] - tt[this.startIdx][1]) / 60)}ふん</span>` : '';
      const tier = this.save.stampTier[st.name] || 0;
      const ring = tier >= 3 ? '#d9b54a' : tier === 2 ? stampColor(st.name) : '#8a8f94';
      const stampMark = tier ? `<span class="rt-stamp t${tier}" style="border-color:${ring}" title="スタンプ"></span>` : '';
      return `<li class="${cls}" data-si="${si}"><span class="rt-dot"><i></i></span>
        <span class="rt-name">${st.name}<small>${kanaOf(st.name)}</small>${stampMark}</span>${tag}</li>`;
    }).join('');
    const ol = $('#route-list');
    ol.innerHTML = html;
    ol.querySelectorAll('.rt').forEach((li) => {
      li.addEventListener('click', () => {
        const si = Number(li.dataset.si);
        if (si < 0) return;
        if (this._pick === 'start') {
          if (si >= n - 1) return;
          this.startIdx = si;
          const curEnd = this.endIdx == null ? n - 1 : this.endIdx;
          if (curEnd <= si) this.endIdx = null;
          this._pick = 'goal';
        } else if (si <= this.startIdx) {
          this.startIdx = Math.min(si, n - 2);
          this._pick = 'goal';
        } else {
          this.endIdx = si === n - 1 ? null : si;
          this._pick = 'start';
        }
        this.renderRoute();
      });
    });
    $('#route-help').innerHTML = this._pick === 'start'
      ? 'スタートの<ruby>駅<rt>えき</rt></ruby>を タップ → ゴールの<ruby>駅<rt>えき</rt></ruby>を タップ'
      : 'こんどは ゴールの<ruby>駅<rt>えき</rt></ruby>を タップしてね';
    /* 「ぜんぶ」チップには かかる時間も出す(46ぷん は小2には長い、とわかるように) */
    const full = this._durOf(this.service);
    $('#rq-all').textContent = full ? `ぜんぶ (${full}ぷん)` : 'ぜんぶ';
    /* はじめて開いたとき・区間をかえたときは、スタートの駅が見えるようにリストを動かす */
    if (scroll) {
      const row = ol.querySelector('.rt.start');
      if (row && row.scrollIntoView) row.scrollIntoView({ block: 'nearest' });
    }
    this.renderSummary();
  },

  _segKey(from, to) { return `${this.service}_${this.direction}_${from}_${to}`; },

  renderSummary() {
    const stops = this._svcStops();
    const n = stops.length;
    const end = this.endIdx == null ? n - 1 : this.endIdx;
    const tt = this.timetable[this._ttKey()];
    const slow = this.weather === 'snow' ? 1.12 : this.weather === 'rain' ? 1.04 : 1;   // 天候ダイヤ
    const min = tt ? Math.max(1, Math.round(((tt[end][0] - tt[this.startIdx][1]) * slow) / 60)) : '—';
    const nStop = end - this.startIdx;
    const tod = { day: 'ひる', evening: 'ゆうがた', night: 'よる' }[this.daytime];
    const wx = { clear: 'はれ', rain: 'あめ', snow: 'ゆき' }[this.weather];
    const b = this.save.bestSeg[this._segKey(stops[this.startIdx].name, stops[end].name)];
    $('#sel-summary').innerHTML = `<b class="sum-route">${rubyStation(stops[this.startIdx].name)} → ${rubyStation(stops[end].name)}</b>
      <span class="sum-meta"><span class="nw">${rubySvc(SERVICES[this.service].name)}</span> ・ <span class="nw">とまる<ruby>駅<rt>えき</rt></ruby> <b>${nStop}</b></span> ・ <span class="nw">やく <span class="sum-time">${min}ぷん</span></span> ・ <span class="nw">${tod}</span> ・ <span class="nw">${wx}</span>${b ? ` ・ <span class="nw sum-best">ベスト ${b.total}てん (${b.rank})</span>` : ''}</span>`;
  },

  /* ================= えきスタンプ ================= */
  updateStampCount() {
    $('#stamp-count').textContent = `${this._stampKinds()}/23`;
  },

  async buildStampBook() {
    const token = (this._bookTok = (this._bookTok || 0) + 1);
    /* キャンバスの文字が かわりのフォントで描かれないように、フォントの読みこみを待つ */
    if (document.fonts && document.fonts.ready) { try { await document.fonts.ready; } catch (e) { /* noop */ } }
    if (token !== this._bookTok || this.mode !== 'stamps') return;
    const names = prepareLine(this.rawLine, 'down').stations.map((s) => s.name);
    const grid = $('#stamps-grid');
    grid.innerHTML = '';
    let got = 0;
    names.forEach((name, i) => {
      const tier = this.save.stampTier[name] || 0;
      const cnt = this.save.stamps[name] || 0;
      if (tier) got++;
      const cell = document.createElement('div');
      cell.className = 'stamp-cell' + (tier ? ' t' + tier : ' no');
      const no = document.createElement('span');
      no.className = 'sc-no';
      no.textContent = String(i + 1);
      const cv = document.createElement('canvas');
      drawStamp(cv, name, { tier, size: 112, seed: i });
      const nm = document.createElement('div');
      nm.className = 'sc-name';
      nm.innerHTML = rubyStation(name);
      const ct = document.createElement('div');
      ct.className = 'sc-cnt';
      const be = this.save.bestErr[name];
      if (tier) ct.textContent = `${TIER_WORD[tier]} ・ ${Math.max(1, cnt)}かい`;
      else if (be != null) { const cm = cmOf(be); ct.innerHTML = `さいこう ${cm}cm → <b>あと ${Math.max(1, cm - 100)}cm</b>`; }
      else ct.textContent = 'まだ';
      cell.append(no, cv, nm, ct);
      grid.appendChild(cell);
    });
    $('#stamps-count').textContent = `${got} / ${names.length}`;
    $('#stamps-prog-fill').style.transform = `scaleX(${(got / names.length).toFixed(3)})`;
    const bg = $('#badges-grid');
    let nb = 0;
    bg.innerHTML = BADGES.map((b) => {
      const has = !!this.save.badges[b.id];
      if (has) nb++;
      return `<div class="badge${has ? '' : ' no'}"><span class="bd-ico">${this._badgeIco(b)}</span>
        <span><div class="bd-name">${b.name}</div><div class="bd-desc">${b.desc}</div></span></div>`;
    }).join('');
    $('#badges-count').textContent = `${nb} / ${BADGES.length}`;
    $('#badges-prog-fill').style.transform = `scaleX(${(nb / BADGES.length).toFixed(3)})`;
  },

  _badgeIco(b) { return b.letter ? `<b class="bd-let">${b.letter}</b>` : icon(b.icon); },

  _setBookTab(v) {
    $('#book-tabs').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x.dataset.v === v));
    $('#book-stamps').classList.toggle('hidden', v !== 'stamps');
    $('#book-badges').classList.toggle('hidden', v !== 'badges');
  },

  /* ================= せってい ================= */
  openSettings() {
    const S = this.settings;
    const list = $('#set-list');
    const cur = (key) => String(key === 'quality' ? (S.quality || this.quality) : S[key]);
    const segRow = (label, key, opts) => `<div class="set-row"><span>${label}</span><div class="seg" data-key="${key}">${opts.map(([v, t]) => `<button data-v="${v}" class="${cur(key) === String(v) ? 'on' : ''}">${t}</button>`).join('')}</div></div>`;
    list.innerHTML = `
      <div class="set-row"><span>おとの おおきさ</span><input type="range" id="set-vol" min="0" max="1" step="0.05" value="${S.volume}"></div>
      ${segRow('アナウンス', 'voice', [['true', 'あり'], ['false', 'なし']])}
      ${segRow('ガイド', 'guide', [['true', 'あり'], ['false', 'なし']])}
      <p class="set-note">ガイド = 「8」までの光のめじるし と ブレーキめやす</p>
      ${segRow('がしつ', 'quality', [['high', 'きれい'], ['mid', 'ふつう'], ['low', 'かるい']])}
      <p class="set-note">がしつは タイトルにもどったときに かわります。うごきが おもいときは じどうで かるくなります</p>
      <div class="set-row"><span>きろく</span><button class="btn btn-ghost btn-sm" id="set-reset">きろくと スタンプを けす</button></div>`;
    $('#set-vol').addEventListener('input', (e) => { S.volume = Number(e.target.value); this.applyVolume(); store.set(SET_KEY, S); });
    list.querySelectorAll('.seg').forEach((sg) => {
      sg.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
        const key = sg.dataset.key;
        const v = b.dataset.v === 'true' ? true : b.dataset.v === 'false' ? false : b.dataset.v;
        S[key] = v;
        sg.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
        if (key === 'voice') this.announcer.setEnabled(v);
        if (key === 'guide' && this.scene) this.scene.guide = v;
        if (key === 'quality') {
          this._qualityDirty = v !== this.quality;
          /* 自分で画質をえらんだら、じどう軽量化の記憶は すてる */
          try { localStorage.removeItem('trainop_perf'); } catch (e) { /* noop */ }
        }
        store.set(SET_KEY, S);
      }));
    });
    /* 「けす」は ブラウザの confirm() ではなく、ゲームの中の確認パネルで */
    $('#set-reset').addEventListener('click', () => $('#confirm-modal').classList.remove('hidden'));
    $('#confirm-modal').classList.add('hidden');
    $('#screen-settings').classList.add('active');
  },

  _resetRecords() {
    this.save = { best: {}, stamps: {}, badges: {}, runs: 0, perfect: 0, cams: {}, stampTier: {}, bestErr: {}, bestSeg: {}, last: null, _migrated: true };
    this.writeSave();
    this.updateStampCount();
    this.renderSvcCards(); this.renderRoute();
  },

  applyVolume() {
    if (!this.audio) return;
    if (this.audio.setVolume) this.audio.setVolume(this.settings.volume);
    else if (this.audio.master) this.audio.master.gain.value = this.settings.volume;
  },

  /* 効果音(audio.cue があるときだけ。なくても動く) */
  _cue(name, gain, rate) {
    if (this.audio && typeof this.audio.cue === 'function') { try { this.audio.cue(name, gain, rate); } catch (e) { /* noop */ } }
  },

  /* 画質の変更はステージを作り直す(タイトルに戻ったとき) */
  _rebuildScene() {
    this._qualityDirty = false;
    this.quality = this.settings.quality || this.quality;
    /* 同じキャンバスに作り直すと古いGPU資源が残るので、文脈ごと捨てて新しいキャンバスにする */
    try { this.scene.renderer.forceContextLoss(); this.scene.renderer.dispose(); } catch (e) { /* noop */ }
    const old = $('#gl');
    const cv = old.cloneNode(false);
    old.replaceWith(cv);
    const A = this.attract;
    this.scene = new RailScene(cv, A.line, A.sim, {
      quality: this.quality, timeOfDay: A.tod, weather: 'clear', autoQ: !this._qp && !this.settings.quality,
    });
    this.scene.guide = this.settings.guide;
    this.scene.setCameraMode(['chase', 'side', 'front', 'drone', 'cab', 'side'][A.camI] || 'chase');
    this.resizeGL();
  },

  /* ================= 入力 ================= */
  _canOp() { return this.mode === 'drive' && this.running && !this.paused; },

  /* レバー・ノッチ列: 運転台(cab.js)に入力の受け口があればそちらに任せる */
  _bindInput() {
    const canOp = () => this._canOp();
    if (this.cab && typeof this.cab.bindInput === 'function') {
      this.cab.bindInput({ canOp, setNotch: (n) => this.sim.setNotch(n) });
    } else {
      this._bindLeverLegacy(canOp);
    }
  },

  /* (旧)画面右のレバー(上=P4 … 下=EB の13段)とノッチ表示列。どちらも「指のたての位置」で段を決める */
  _bindLeverLegacy(canOp) {
    const notchAt = (el, clientY) => {
      const r = el.getBoundingClientRect();
      const k = (clientY - r.top) / Math.max(1, r.height);
      const idx = Math.max(0, Math.min(12, Math.floor(k * 13)));   // 下にはみ出しても必ず EB
      return idx === 12 ? -8 : 4 - idx;
    };
    const bind = (el) => {
      let drag = false;
      const set = (ev) => { if (canOp()) this.sim.setNotch(notchAt(el, ev.clientY)); };
      el.addEventListener('pointerdown', (ev) => {
        drag = true;
        try { el.setPointerCapture(ev.pointerId); } catch (e) { /* 合成イベント等 */ }
        set(ev);
      });
      el.addEventListener('pointermove', (ev) => { if (drag) set(ev); });
      const end = () => { drag = false; };
      el.addEventListener('pointerup', end);
      el.addEventListener('pointercancel', end);
      el.addEventListener('lostpointercapture', end);
    };
    bind($('#lever'));
    /* ノッチ表示列(P4〜EB)も直接さわって操作できる(子どもはレバーよりこちらを触りがち) */
    bind($('#notch-list'));
  },

  /* ▲▼ボタンを押したら、レバーの持ち手を光らせて関係を見せる */
  _flashGrip() {
    if (this.cab && typeof this.cab.flashGrip === 'function') { this.cab.flashGrip(); return; }
    const g = $('#lever-grip');
    if (!g) return;
    g.classList.add('tb-flash');
    clearTimeout(this._gripFlashT);
    this._gripFlashT = setTimeout(() => g.classList.remove('tb-flash'), 320);
  },

  bindUI() {
    $('#btn-start').addEventListener('click', () => this.startDrive());
    $('#btn-to-select').addEventListener('click', () => { this._unlockAudio(); this.renderSvcCards(); this.go('select'); this.renderRoute(true); });
    $('#btn-to-stamps').addEventListener('click', () => this.go('stamps'));
    $('#btn-stamps-back').addEventListener('click', () => this.go('title'));
    $('#book-tabs').querySelectorAll('button').forEach((b) => b.addEventListener('click', () => this._setBookTab(b.dataset.v)));
    $('#btn-to-settings').addEventListener('click', () => this.openSettings());
    $('#btn-set-close').addEventListener('click', () => {
      $('#screen-settings').classList.remove('active');
      if (this._qualityDirty && this.mode !== 'drive' && this.mode !== 'result') this._rebuildScene();
    });
    $('#cf-no').addEventListener('click', () => $('#confirm-modal').classList.add('hidden'));
    $('#cf-yes').addEventListener('click', () => { $('#confirm-modal').classList.add('hidden'); this._resetRecords(); });
    $('#btn-back-title').addEventListener('click', () => this.go('title'));
    $('#btn-pause-resume').addEventListener('click', () => this.setPaused(false));
    $('#btn-pause-retry').addEventListener('click', () => this.retryStation());
    $('#btn-pause-settings').addEventListener('click', () => this.openSettings());
    $('#btn-pause-quit').addEventListener('click', () => this.quitDrive());
    $('#btn-res-retry').addEventListener('click', () => this.startDrive(true));
    $('#btn-res-next').addEventListener('click', () => this._continueRun());
    $('#btn-res-select').addEventListener('click', () => { this.renderSvcCards(); this.go('select'); this.renderRoute(true); });
    $('#btn-overrun-retry').addEventListener('click', () => { $('#overrun-modal').classList.add('hidden'); this.retryStation(); });
    $('#btn-cam').addEventListener('click', () => this.cycleCam());

    /* タッチ用ボタン(すすむ/ブレーキ/けいてき/ポーズ)
     * ▲▼はレバーを1段ずつ動かすのと同じ */
    const canOp = () => this._canOp();
    $('#tb-up').addEventListener('click', () => { if (canOp()) { this.sim.setNotch(Math.min(4, this.sim.notch + 1)); this._flashGrip(); } });
    $('#tb-dn').addEventListener('click', () => { if (canOp()) { this.sim.setNotch(Math.max(-8, this.sim.notch - 1)); this._flashGrip(); } });
    $('#tb-horn').addEventListener('click', () => { if (canOp() && this.audio) { this.audio.horn(); this.grantBadge('horn'); } });
    $('#btn-pause-touch').addEventListener('click', () => { if (this.mode === 'drive' && this.running) this.setPaused(!this.paused); });
    $('#btn-skip').addEventListener('click', () => {
      if (canOp() && this.sim.skipDwell()) this.flashMsg('ドアが しまります！', 1600);
    });

    addEventListener('keydown', (ev) => {
      if (this.mode !== 'drive' || !this.running) return;
      if (ev.code === 'Space') ev.preventDefault();
      if (ev.repeat) return;
      if (ev.code === 'Escape' || ev.code === 'KeyP') { this.setPaused(!this.paused); return; }
      if (this.paused) return;
      const n = this.sim.notch;
      if (ev.code === 'ArrowUp' || ev.code === 'KeyW') this.sim.setNotch(Math.min(4, n + 1));
      else if (ev.code === 'ArrowDown' || ev.code === 'KeyS') this.sim.setNotch(Math.max(-8, n === -8 ? -8 : n - 1));
      else if (ev.code === 'Space') this.sim.setNotch(-8);
      else if (ev.code === 'KeyN' || ev.code === 'Digit0') this.sim.setNotch(0);
      else if (ev.code === 'KeyH') { if (this.audio) this.audio.horn(); this.grantBadge('horn'); }
      else if (ev.code === 'KeyC') this.cycleCam();
      else if (ev.code === 'KeyM') { this._muted = !this._muted; if (this.audio && this.audio.setMuted) this.audio.setMuted(this._muted); }
    });

    addEventListener('resize', () => this.resizeGL());
    document.addEventListener('visibilitychange', () => {
      if (document.hidden && this.mode === 'drive' && this.running && !this.paused) this.setPaused(true);
    });
  },

  _unlockAudio() {
    if (this.announcer && this.announcer.unlock) this.announcer.unlock();   // iOSは最初の発話をタップの中で
    if (!this.audio) return;
    this.audio.ensure();
    this.applyVolume();
  },

  cycleCam() {
    if (!this.scene || this.mode !== 'drive') return;
    this.camIdx = (this.camIdx + 1) % CAM_MODES.length;
    this._setCam(CAM_MODES[this.camIdx]);
    this.save.cams = this.save.cams || {};
    this.save.cams[CAM_MODES[this.camIdx]] = 1;
    if (CAM_MODES.every((m) => m === 'cab' || this.save.cams[m])) this.grantBadge('camera');
    const lab = $('#cam-label');
    lab.innerHTML = icon('camera') + ' してん: ' + CAM_NAME[CAM_MODES[this.camIdx]];
    lab.classList.remove('hidden');
    clearTimeout(this._camLabT);
    this._camLabT = setTimeout(() => lab.classList.add('hidden'), 1600);
  },

  _setCam(m) {
    this.scene.setCameraMode(m);
    document.body.classList.toggle('cam-cab', m === 'cab');
    if (this.rainGlass) this.rainGlass.setActive(this.weather === 'rain' && m === 'cab' && this.mode === 'drive');
  },

  resizeGL() {
    if (!this.scene) return;
    const wrap = $('#gl-wrap');
    this.scene.resize(wrap.clientWidth, wrap.clientHeight);
    if (this.rainGlass) this.rainGlass.resize(wrap.clientWidth, wrap.clientHeight);
  },

  /* ================= 運転開始 ================= */
  async startDrive(again = false) {
    this._unlockAudio();
    if (!again) this.line = prepareLine(this.rawLine, this.direction);
    /* 前回えらんだ列車として おぼえる(つぎに選択画面を開いたときに もどす) */
    this.save.last = { direction: this.direction, service: this.service, daytime: this.daytime, weather: this.weather, startIdx: this.startIdx, endIdx: this.endIdx };
    this.writeSave();
    const fade = $('#fade');
    fade.classList.add('on');
    await new Promise((r) => setTimeout(r, 380));
    this.go('drive');
    await nextFrame();
    this.beginRun(this.startIdx);
    await nextFrame();
    fade.classList.remove('on');
  },

  beginRun(startIdx) {
    this.sim = new TrainSim(this.line, { service: this.service, weather: this.weather, timetable: this.timetable, endIdx: this.endIdx });
    this.sim.reset(startIdx);
    this.lastStationIdx = startIdx;
    this.runStamps = [];
    this.runBadges = [];
    this.runStreak = 0;
    this._retried = false;
    this._ebTold = false;
    this._clearPops();
    this.scene.setWorld(this.line, this.sim);
    this.scene.setTimeOfDay(this.daytime);
    this.scene.setWeather(this.weather);
    this.scene.guide = this.settings.guide;
    this.camIdx = 0;
    this._setCam('cab');
    this.cab.sim = this.sim;
    this.cab.baseHour = this.daytime === 'night' ? 19 : this.daytime === 'evening' ? 16 : 10;
    this.cab._nextName = null;
    const dest = this.sim.stops[this.sim.stops.length - 1].name;
    const svcName = SERVICES[this.service].name;
    if (typeof this.cab.setService === 'function') {
      this.cab.setService({ svcHtml: rubySvc(svcName), color: SVC_COLOR[this.service], destHtml: rubyStation(dest) + ' ゆき' });
    }
    if (this.scene.prewarm) { try { this.scene.prewarm(); } catch (e) { /* noop */ } }
    this._runT0 = performance.now();
    if (this.audio) {
      this.audio.ensure();
      this.audio.bind(this.sim);
    }
    this.sim.onEvent((type, e) => this.onSimEvent(type, e));
    $('#drive-head-svc').innerHTML = `<span class="dh-svc" style="--svc:${SVC_COLOR[this.service]}">${rubySvc(svcName)}</span>${rubyStation(dest)} ゆき`;
    this._buildRouteStrip();
    this._coachTxt = null; this._cb = null;
    $('#msg-center').classList.add('hidden');
    $('#overrun-modal').classList.add('hidden');
    this.setPaused(false);
    this.running = true;
    this.resizeGL();
  },

  onSimEvent(type, e) {
    const A = this.announcer;
    if (type === 'arrived') {
      /* 'arrived' は次の駅へ進める前に出るので、いまの stopIdx が着いた駅 */
      this.lastStationIdx = this.sim.stopIdx;
      const last = this.sim.score.stops[this.sim.score.stops.length - 1];
      const abs = Math.abs(last.err);
      this.showStopCard(e.name, last);
      /* スタンプ・くんしょうは カードのあとに じゅんばんに出す */
      this._queuePop(null, 900);
      const prevBest = this.save.bestErr[e.name];
      this.save.bestErr[e.name] = Math.min(prevBest == null ? 99 : prevBest, abs);
      const tier = tierOf(abs);
      if (tier >= 1) this.awardStamp(e.name, tier);
      else this.writeSave();
    }
    if (type === 'door-closed') this.flashMsg('ドアが しまりました ── <ruby>出発進行<rt>しゅっぱつしんこう</rt></ruby>！', 1800);
    if (type === 'overrun') this.flashMsg(`${icon('warn')} いきすぎ！ とまるところを すぎています`, 2600, true);
    if (type === 'overrun-stop') $('#overrun-modal').classList.remove('hidden');
    if (type === 'ats-brake') {
      const a = this.sim.hud().ats;
      const why = a && a.kind === 'limit' ? `（このさき ${Math.round(a.target)} のため）` : '';
      this.flashMsg(`${icon('warn')} スピードの<ruby>出<rt>だ</rt></ruby>しすぎ！ じどうブレーキが かかりました${why}`, 2400, true);
    }
    /* 非常ブレーキの減点は 1回目だけ理由を説明する */
    if (type === 'eb' && e.moving && !this._ebTold) {
      this._ebTold = true;
      this.flashMsg('ひじょうブレーキは ほんとうに あぶない ときだけ。ふだんは B1〜B7 を つかおう', 2800, true);
    }
    /* 車内放送(よみは ひらがなで渡す) */
    if (A && type === 'depart') {
      const k = kanaOf(e.name) || e.name;
      A.speak(e.last ? `つぎは、しゅうてん、${k}です。` : `つぎは、${k}。${k}です。`);
    }
    if (A && type === 'approach') {
      const k = kanaOf(e.name) || e.name;
      A.speak(e.last ? `まもなく、しゅうてん、${k}です。おわすれものの ないよう、ごちゅうい ください。` : `まもなく、${k}です。`);
    }
    if (type === 'finished') this.finishRun(e);
  },

  /* ---- 停止位置の判定カード ---- */
  showStopCard(name, st) {
    const el = $('#stop-card');
    const err = st.err, abs = Math.abs(err);
    const g = gradeOf(abs);
    el.style.setProperty('--g', g.col);
    el.className = 'g-' + g.k;
    this.runStreak = abs <= 1 ? (this.runStreak || 0) + 1 : 0;
    $('#sc-sta').innerHTML = `${rubyStation(name)}<small> に とうちゃく</small>`;
    $('#sc-streak').innerHTML = this.runStreak >= 2 ? `れんぞく <b>×${this.runStreak}</b>` : '';
    $('#sc-grade').textContent = g.mark;
    const cm = cmOf(err);
    $('#sc-cm').innerHTML = `${cm < 5 ? 0 : cm}<small>cm</small><span class="sc-dir">${cm < 5 ? '' : err > 0 ? 'いきすぎ' : 'てまえ'}</span>`;
    $('#sc-word').textContent = g.word;
    $('#sc-time').innerHTML = st.late > 3 ? `じかん<br><b>${st.late}びょう おくれ</b>` : 'じかん<br><b>ぴったり</b>';
    const tip = $('#sc-tip');
    if (g.k === 'ng') { tip.textContent = err > 0 ? 'つぎは ブレーキを もうすこし はやく' : 'つぎは ブレーキを すこし よわく'; tip.classList.remove('hidden'); }
    else tip.classList.add('hidden');
    /* 列車の先頭が「8」のどこで止まったか(はしから すべりこむ) */
    const nose = $('#sc-nose');
    const x = 50 + Math.sign(err) * Math.min(1, Math.sqrt(abs / 3)) * 46;
    nose.style.transition = 'none';
    nose.style.transform = 'translateX(-96%)';
    void nose.offsetWidth;   // はじまりの位置を いったん確定させてから すべらせる
    nose.style.transition = '';
    nose.style.transform = `translateX(${(x - 100).toFixed(1)}%)`;
    clearTimeout(this._scT);
    this._scT = setTimeout(() => el.classList.add('hidden'), 3400);
  },

  /* ---- ポップアップの順番待ち(カード → スタンプ → くんしょう が重ならない) ---- */
  _queuePop(fn, ms) {
    if (!this._popQ) this._popQ = [];
    this._popQ.push([fn, ms]);
    if (!this._popBusy) this._runPop();
  },
  _runPop() {
    const it = this._popQ.shift();
    if (!it) { this._popBusy = false; return; }
    this._popBusy = true;
    if (it[0]) { try { it[0](); } catch (e) { /* noop */ } }
    this._popT = setTimeout(() => this._runPop(), it[1]);
  },
  _clearPops() {
    this._popQ = [];
    this._popBusy = false;
    clearTimeout(this._popT);
    clearTimeout(this._scT);
    ['#stop-card', '#stamp-pop', '#badge-toast'].forEach((s) => $(s).classList.add('hidden'));
  },

  /* くんしょう: 新しくもらえたらトーストで知らせる */
  grantBadge(id) {
    if (this.save.badges[id]) return;
    const b = badgeById(id);
    if (!b) return;
    this.save.badges[id] = Date.now();
    this.writeSave();
    if (this.runBadges) this.runBadges.push(id);
    this._queuePop(() => {
      const t = $('#badge-toast');
      t.querySelector('.bt-ico').innerHTML = this._badgeIco(b);
      t.querySelector('.bt-txt').textContent = `くんしょう ゲット！「${b.name}」`;
      t.classList.remove('hidden');
      t.style.animation = 'none'; void t.offsetWidth; t.style.animation = '';
      clearTimeout(this._badgeT);
      this._badgeT = setTimeout(() => t.classList.add('hidden'), 3000);
    }, 3200);
  },

  /* スタンプ: ±1m くろ / ±35cm いろ / ±10cm きん。新しいとき・ランクが上がったときだけ ポン と出す */
  awardStamp(name, tier) {
    const old = this.save.stampTier[name] || 0;
    this.save.stampTier[name] = Math.max(old, tier);
    this.save.stamps[name] = (this.save.stamps[name] || 0) + 1;
    if (tier >= 2) this.save.perfect = (this.save.perfect || 0) + 1;
    this.writeSave();
    const run = this.runStamps.find((r) => r.name === name);
    if (run) run.tier = Math.max(run.tier, tier); else this.runStamps.push({ name, tier });
    if (tier > old) {
      const cap = old === 0 ? `${rubyStation(name)} の スタンプ ゲット！`
        : tier === 3 ? 'きんの スタンプに レベルアップ！' : 'いろつき スタンプに レベルアップ！';
      this._queuePop(() => {
        const pop = $('#stamp-pop');
        drawStamp($('#stamp-pop-cv'), name, { tier, size: 128, seed: name.length });
        $('#stamp-pop-txt').innerHTML = cap;
        pop.className = 't' + tier;
        void pop.offsetWidth;
        pop.classList.add('go');
        this._cue('doorThud', 0.5, 0.7);
        clearTimeout(this._stampT);
        this._stampT = setTimeout(() => pop.classList.add('hidden'), 2500);
      }, 2600);
    }
    /* くんしょう(スタンプのあとに順番に出る) */
    if (tier >= 2) {
      this.grantBadge('perfect');
      if (this.save.perfect >= 10) this.grantBadge('perfect10');
      if (this.save.perfect >= 30) this.grantBadge('perfect30');
    }
    const kinds = this._stampKinds();
    if (kinds >= 10) this.grantBadge('stamp10');
    if (kinds >= 23) this.grantBadge('stampAll');
  },

  flashMsg(text, ms = 2600, warn = false) {
    const el = $('#msg-center');
    el.innerHTML = text;
    el.classList.toggle('warn', warn);
    el.classList.remove('hidden');
    clearTimeout(this._msgT);
    this._msgT = setTimeout(() => el.classList.add('hidden'), ms);
  },

  setPaused(p) {
    this.paused = p;
    if (p && this.sim) {
      /* ポーズ画面に「いま どこを はしっているか」を出す */
      const sim = this.sim;
      const prev = sim.stops[Math.max(0, sim.stopIdx - 1)], next = sim.stops[sim.stopIdx];
      const rest = sim.stops.length - sim.stopIdx;
      $('#pause-ctx').innerHTML = `<span class="nw">${rubySvc(SERVICES[this.service].name)}</span>　<span class="nw">${rubyStation(prev.name)} → ${next ? rubyStation(next.name) : 'ゴール'}</span>　<span class="nw">あと ${Math.max(0, rest)} えき</span>`;
    }
    $('#screen-pause').classList.toggle('active', p);
    if (this.audio && this.audio.pause) this.audio.pause(p);
    if (p && this.announcer) this.announcer.cancel();
  },

  /* ================= 運転中HUD ================= */
  /* 路線: 「まえの駅 → つぎ → そのつぎ」と「あと N えき」+ 全体の細い進みぐあい */
  _buildRouteStrip() {
    const sim = this.sim;
    const a = sim.stops[sim.startIdx].stopAt, b = sim.stops[sim.stops.length - 1].stopAt;
    const q = (s) => document.querySelector('#rs-win ' + s);
    this._rs = {
      a, b, segA: a, segB: b, k: null, kAll: null, idx: null,
      prev: q('.rs-prev span'), next: q('.rs-next span'), after: q('.rs-after span'),
      afterNode: q('.rs-after'), seg2: q('.rs-seg2'), left: q('.rs-left'),
      train: $('#rs-train'), fill: $('#rs-all-fill'),
    };
    this._updateRouteStrip();
  },

  _updateRouteStrip() {
    const sim = this.sim, R = this._rs;
    if (!R) return;
    if (R.idx !== sim.stopIdx) {
      R.idx = sim.stopIdx;
      const prev = sim.stops[Math.max(0, sim.stopIdx - 1)];
      const next = sim.stops[Math.min(sim.stops.length - 1, sim.stopIdx)];
      const after = sim.stops[sim.stopIdx + 1];
      R.prev.textContent = kanaOf(prev.name) || prev.name;
      R.next.textContent = kanaOf(next.name) || next.name;
      R.after.textContent = after ? kanaOf(after.name) || after.name : '';
      R.afterNode.classList.toggle('hidden', !after);
      R.seg2.classList.toggle('hidden', !after);
      const rest = Math.max(0, sim.stops.length - sim.stopIdx);
      R.left.innerHTML = rest <= 1 ? 'つぎ <b>ゴール</b>' : `あと <b>${rest}</b> えき`;
      R.segA = prev.stopAt; R.segB = next.stopAt;
    }
    const k = Math.max(0, Math.min(1, (sim.pos - R.segA) / Math.max(1, R.segB - R.segA)));
    const kr = Math.round(k * 400) / 4;   // 0.25%きざみ
    if (kr !== R.k) { R.k = kr; R.train.style.transform = `translateX(${(kr - 100).toFixed(2)}%)`; }
    const ka = Math.round(Math.max(0, Math.min(1, (sim.pos - R.a) / Math.max(1, R.b - R.a))) * 500) / 500;
    if (ka !== R.kAll) { R.kAll = ka; R.fill.style.transform = `scaleX(${ka})`; }
  },

  /* ブレーキ地点の計算(150msに1回だけ。重い予測を毎フレームしない) */
  _brakeCalc(h) {
    const sim = this.sim;
    const now = performance.now();
    const c = this._cb;
    if (c && now - c.t < 150 && c.notch === sim.notch && c.idx === sim.stopIdx) return c;
    let dB = sim.stopDistance(-4);
    if (dB == null) { const vms = sim.v / 3.6; dB = (vms * vms) / (2 * ((4 / 7) * 4.0 / 3.6)) + vms * 1.2; }   // 下り坂では計算上止まらないので目安
    const pred = sim.predictStop();
    this._cb = { t: now, notch: sim.notch, idx: sim.stopIdx, dB, pred };
    return this._cb;
  },

  /* 駅より手前(400m以内)に、いまの速さより低い制限があるか */
  _limitAhead(h) {
    const a = h.ats, sim = this.sim;
    if (!a || a.kind !== 'limit' || a.target >= h.limit || sim.v <= a.target + 1) return false;
    const d = a.at - sim.pos;
    return d < 400 && (!h.next || d < h.next.dist - 5);
  },

  /* B4で止まれる距離に 余裕(はやいほど大きく、最大12m)を足した「ブレーキを かける場所」までの距離 */
  _toBrake(h, c) { return h.next.dist - c.dB - Math.min(12, 3 + this.sim.v * 0.15); },

  /* ブレーキめやす: このままのブレーキだと、どこで止まるか */
  _updateBrakeGuide(h) {
    const el = this._bgEl || (this._bgEl = { box: $('#brake-guide'), pred: $('#bg-pred'), txt: $('#bg-txt') });
    const sim = this.sim;
    const show = this.settings.guide && h.next && !h.doorOpen && h.next.dist < 650 && h.next.dist > -15 && sim.v > 0.5;
    setHidden(el.box, !show);
    if (!show) return;
    const c = this._brakeCalc(h);
    const pred = c.pred;
    let txt, cls = '';
    if (this._limitAhead(h)) {
      /* 手前の制限に合わせて減速中: 駅の予想は まだ出さない */
      if (el.pred._d !== 'none') { el.pred._d = 'none'; el.pred.style.display = 'none'; }
      txt = `このさき<br><b>${Math.round(h.ats.target)}</b> まで`;
    } else if (pred == null) {
      if (el.pred._d !== 'none') { el.pred._d = 'none'; el.pred.style.display = 'none'; }
      const toBrake = Math.round(this._toBrake(h, c));
      txt = toBrake > 0 ? `ブレーキまで<br><b>${toBrake}m</b>` : '<b>ブレーキ</b>を<br>かけよう';
      if (toBrake <= 0) cls = 'over';
    } else {
      const d = pred - h.next.dist;     // +: いきすぎ / -: てまえ
      const k = Math.sign(d) * Math.min(1, Math.sqrt(Math.abs(d) / 40));
      if (el.pred._d !== 'block') { el.pred._d = 'block'; el.pred.style.display = 'block'; }
      const top = `${(50 - k * 50).toFixed(1)}%`;
      if (el.pred._top !== top) { el.pred._top = top; el.pred.style.top = top; }
      const ok = Math.abs(d) <= 1.0;
      cls = ok ? 'ok' : d > 0 ? 'over' : '';
      setCls(el.pred, 'bg-pred ' + cls);
      txt = ok ? '<b>ぴったり</b><br>このまま！' : d > 0 ? `<b>${Math.round(d)}m</b><br>いきすぎ` : `<b>${Math.round(-d)}m</b><br>てまえ`;
    }
    setHtml(el.txt, txt);
    setCls(el.txt, 'bg-txt ' + cls);
  },

  /* 「いまやること」コーチ(小2でもわかる次の一手を常に出す。まちがえる前に知らせる) */
  _updateCoach(h) {
    const el = this._coachEl || (this._coachEl = $('#coach'));
    const sim = this.sim;
    if (!h) h = sim.hud();
    let txt = '', hot = false;
    const redAhead = h.ats && h.ats.kind === 'signal' && h.ats.target === 0;
    const redNear = redAhead && h.ats.at - sim.pos < 150;
    if (h.finished) {
      txt = '';
    } else if (h.doorOpen) {
      const rest = Math.ceil((h.next ? h.next.dep : sim._departTime) - sim.t);
      txt = rest > 0 ? `おきゃくさんが のりおり中… しゅっぱつまで あと <b>${Math.max(0, rest)}</b> びょう`
        : 'まもなく ドアが しまります';
    } else if (sim.v < 0.5 && sim._left && h.next && h.next.dist > 0.5 && h.next.dist < 250 && !redNear) {
      /* 「8」の手前で止まってしまった: すこし進んで もういちど止まる */
      txt = `「8」まで あと <b>${Math.round(h.next.dist)}</b> m。<b>▲</b>を 1かい → うごいたら <b>▼</b>で とまろう`;
    } else if (sim.v < 0.5 && sim.notch <= 0 && !redNear) {
      txt = '<b>▲すすむ</b> を おして しゅっぱつ！';
    } else if (h.atsLamp === 'brake') {
      /* じどうブレーキは「ゆるしてもらえる速さ」より すこし下がると はなれる */
      const cap = Math.min(h.limit, h.ats ? h.ats.pattern : h.limit);
      const tgt = Math.max(0, Math.floor((cap - 3) / 5) * 5);
      txt = `${icon('warn')} じどうブレーキ中… スピードが <b>${tgt}</b> まで さがるのを まとう`;
    } else if (h.slipping) {
      txt = 'すべってる！ <b>▲</b>で ブレーキを すこし よわく';
    } else if (redAhead && (h.ats.at - sim.pos) < 700) {
      txt = sim.v < 0.5 ? '<i class="sig sig-r"></i>しんごうが <b>あか</b>。あおに かわるまで まとう'
        : '<i class="sig sig-r"></i>しんごうが <b>あか</b>！ ブレーキで とまろう';
    } else if (sim.notch > 0 && sim.v > h.limit - 8) {
      /* じどうブレーキが かかる まえに 知らせる */
      txt = `もうすぐ <b>${h.limit}</b>！ <b>▼</b>で <b>N</b>に もどそう`;
    } else if (h.ats && h.ats.kind === 'signal' && (h.ats.at - sim.pos) < 700 && sim.v > h.ats.target - 3) {
      txt = `<i class="sig sig-y"></i>しんごうが <b>きいろ</b>。スピードを <b>${Math.round(h.ats.target)}</b> まで おとそう`;
    } else if (h.ats && h.ats.kind === 'limit' && sim.v > h.ats.pattern - 4 && h.ats.target < h.limit) {
      /* 「いまの制限は守っているのに」の混乱に、理由(この先の低い制限)を示す */
      const m = Math.max(0, Math.round(h.ats.at - sim.pos));
      txt = `${icon('warn')} このさきは <b>${Math.round(h.ats.target)}</b> まで。いまから おとそう（あと <b>${m}</b> m）`;
    } else if (this._limitAhead(h)) {
      /* 駅より手前に 低い制限がある: まずは そちらに合わせる(駅の予想を出すと まぎらわしい) */
      const m = Math.max(0, Math.round(h.ats.at - sim.pos));
      txt = `このさきは <b>${Math.round(h.ats.target)}</b> まで。ブレーキで おとそう（あと <b>${m}</b> m）`;
    } else if (h.next && h.next.dist < 700) {
      /* 駅に近づいた: ブレーキを かける場所と、止まる場所の予想 */
      const c = this._brakeCalc(h);
      const dist = h.next.dist;
      if (sim.notch >= 0) {
        const toBrake = this._toBrake(h, c);
        if (toBrake > 40) txt = `ブレーキまで あと <b>${Math.round(toBrake)}</b> m`;
        else if (toBrake > 0) txt = 'そろそろ！ <b>▼</b>を 3〜4かい';
        else { txt = 'いま！ <b>▼ブレーキ</b>'; hot = true; }
      } else if (c.pred == null) {
        txt = 'このままだと とまれない → <b>▼</b>もっと';
      } else {
        const d = c.pred - dist;
        if (Math.abs(d) <= 1) txt = 'そのまま！ ぴったり とまるよ';
        else if (d > 1) txt = `このままだと <b>${Math.round(d)}</b>m すぎる → <b>▼</b>もっと`;
        else txt = `このままだと <b>${Math.round(-d)}</b>m たりない → <b>▲</b>すこし ゆるめる`;
      }
    } else if (h.ats && sim.v > h.ats.pattern - 4) {
      txt = `${icon('warn')} スピードを <b>${Math.round(h.ats.target)}</b> まで おとそう`;
    } else if (h.next) {
      txt = `つぎは <b>${kanaOf(h.next.name) || h.next.name}</b> ／ スピードは <b>${h.limit}</b> まで`;
    }
    if (txt !== this._coachTxt) {
      this._coachTxt = txt;
      el.innerHTML = txt;
      setHidden(el, !txt);
    }
    if (el._hot !== hot) { el._hot = hot; el.classList.toggle('coach-hot', hot); }

    /* 大型HUD(じそく・せいげん・のこりm/あと秒) */
    if (!this._bh) {
      this._bh = {
        v: $('#bh-v'), cap: $('#bh-ctx-cap'), num: $('#bh-ctx-num'),
        unit: $('#bh-ctx-unit'), row: document.querySelector('.bh-ctx'),
        lim: $('#bh-lim'), limN: $('#bh-lim-next'), skip: $('#btn-skip'),
      };
    }
    const B = this._bh;
    setText(B.v, String(Math.floor(sim.v)));   // 速度計の数字(切り捨て)とそろえる
    setCls(B.v, sim.v > h.limit + 1 ? 'over' : sim.v > h.limit - 5 ? 'near' : '');
    setText(B.lim, String(h.limit));
    let ln = '';
    if (h.ats && h.ats.kind === 'limit' && h.ats.target < h.limit && h.ats.at - sim.pos < 700) ln = '→' + Math.round(h.ats.target);
    else if (h.ats && h.ats.kind === 'signal' && h.ats.at - sim.pos < 700) ln = `<i class="sig sig-${h.ats.target === 0 ? 'r' : 'y'}"></i>`;
    setHtml(B.limN, ln);
    setHidden(B.limN, !ln);
    let cap, num, unit, warn = false;
    if (h.doorOpen) {
      cap = 'しゅっぱつまで';
      num = String(Math.max(0, Math.ceil((h.next ? h.next.dep : sim._departTime) - sim.t)));
      unit = 'びょう';
      warn = Number(num) <= 5;
    } else if (h.next) {
      cap = 'えきまで';
      const dm = Math.max(0, h.next.dist);
      num = dm >= 1000 ? (dm / 1000).toFixed(1) : String(Math.round(dm));
      unit = dm >= 1000 ? 'km' : 'm';
      warn = dm < 250;
    } else {
      cap = 'ゴールまで'; num = '—'; unit = '';
    }
    setText(B.num, num);
    setText(B.cap, cap);
    setText(B.unit, unit);
    setCls(B.row, 'bh-row bh-ctx' + (warn ? ' bh-warn' : ''));

    /* しゅっぱつスキップボタン(まだ待ち時間があるときだけ) */
    const canSkip = h.doorOpen && ((h.next ? h.next.dep : sim._departTime) - sim.t) > 7;
    setHidden(B.skip, !canSkip);
    this._updateBrakeGuide(h);
    this._updateRouteStrip();
  },

  retryStation() {
    this._retried = true;   // とちゅうからやり直した運転はベスト記録に残さない
    this.sim.reset(this.lastStationIdx);
    this.scene._camPos = null;
    this.setPaused(false);
    $('#overrun-modal').classList.add('hidden');
    if (this.scene.traffic) this.scene.traffic.reset(this.sim);
    this._clearPops();
    this._coachTxt = null; this._cb = null;
    if (this._rs) this._rs.idx = null;
    this.flashMsg(`${rubyStation(this.sim.stops[this.lastStationIdx].name)} から やりなおし`, 2000);
  },

  quitDrive() {
    this.running = false;
    this.setPaused(false);
    this._clearPops();
    if (this.audio) this.audio.stop();
    if (this.announcer) this.announcer.cancel();
    this.renderSvcCards();
    this.go('select');
    this.renderRoute(true);
  },

  /* ================= 終了と成績票 ================= */
  finishRun(res) {
    this.running = false;
    if (this.audio) this.audio.stop();
    this.save.runs = (this.save.runs || 0) + 1;
    const full = this.startIdx === 0 && this.endIdx == null && !this._retried;
    const key = `${this.service}_${this.direction}_${this.weather}`;
    const prev = this.save.best[key];
    const isBest = full && (!prev || res.total > prev.total);
    if (isBest) this.save.best[key] = { total: res.total, rank: res.rank };
    /* 区間ごとのベスト(短い運転でも「じこベスト」が出る) */
    const sim = this.sim;
    const from = sim.stops[sim.startIdx].name, to = sim.stops[sim.stops.length - 1].name;
    const segKey = this._segKey(from, to);
    const prevSeg = this.save.bestSeg[segKey];
    const segBest = !this._retried && (!prevSeg || res.total > prevSeg.total);
    if (segBest) this.save.bestSeg[segKey] = { total: res.total, rank: res.rank };
    this.writeSave();
    const nSt = res.stops.length;
    this.grantBadge('first');
    if (nSt >= 3 && res.overspeed === 0) this.grantBadge('safe');
    if (nSt >= 3 && res.stops.every((st) => st.late <= 5)) this.grantBadge('ontime');
    if (full) this.grantBadge(this.direction === 'up' ? 'fullUp' : 'fullDown');
    if (this.service === 'exp') this.grantBadge('exp');
    if (this.service === 'rapid') this.grantBadge('rapid');
    if (this.daytime === 'evening') this.grantBadge('evening');
    if (this.daytime === 'night') this.grantBadge('night');
    if (this.weather === 'rain') this.grantBadge('rain');
    if (this.weather === 'snow') this.grantBadge('snow');
    if (res.rank === 'S' || res.rank === 'A') this.grantBadge('rankA');
    if (res.rank === 'S') this.grantBadge('rankS');
    /* さいごの駅の判定カードを見せてから、外から列車を眺めて成績票へ */
    const best = { prevSeg, segBest, retried: this._retried };
    setTimeout(() => { if (this.mode === 'drive' && this.sim === sim) this._setCam('drone'); }, 1500);
    setTimeout(() => { if (this.mode === 'drive' && this.sim === sim) this._showResult(res, best); }, 3000);
  },

  /* つぎの目標(いちばん当てはまるものを1つだけ) */
  _nextGoal(res) {
    const tot = res.total;
    const up = RANK_LINE.slice().reverse().find(([th]) => tot < th && th - tot <= 8);
    if (up) return `あと <b>${up[0] - tot}</b>てんで ランク<b>${up[1]}</b>！`;
    const near = res.stops.find((st) => Math.abs(st.err) > 0.35 && Math.abs(st.err) <= 1);
    if (near) return `${rubyStation(near.name)}は あと <b>${cmOf(near.err) - 35}cm</b> で ぴったり だった！`;
    if (res.overspeed > 0) return 'じどうブレーキ 0かいで ゴールすると くんしょう「あんぜん うんてん」';
    const b = BADGES.find((x) => !this.save.badges[x.id]);
    if (b) return `つぎの くんしょう「${b.name}」── <span class="nw">${b.desc}</span>`;
    return '';
  },

  _showResult(res, best) {
    const sim = this.sim;
    $('.res-card').style.setProperty('--svc', SVC_COLOR[this.service]);
    const rk = $('#res-rank');
    rk.textContent = res.rank;
    rk.className = 'res-rank rk-' + res.rank;
    const from = sim.stops[sim.startIdx].name, to = sim.stops[sim.stops.length - 1].name;
    const tod = { day: '', evening: '　（ゆうがた）', night: '　（よる）' }[this.daytime];
    const wx = { clear: '', rain: '　（あめ）', snow: '　（ゆき）' }[this.weather];
    $('#res-svc').innerHTML = `${rubySvc(SERVICES[this.service].name)}　${rubyStation(from)} → ${rubyStation(to)}${wx}${tod}`;
    $('#res-title').textContent = res.total >= 95 ? 'でんせつの うんてんし' : res.total >= 85 ? 'めいじん うんてんし' : res.total >= 70 ? 'いちにんまえ うんてんし' : res.total >= 55 ? 'みならい うんてんし' : 'もういちど チャレンジ！';
    /* なぜ その点数か(理由をひとこと) */
    const cnt = { perfect: 0, good: 0, ok: 0, ng: 0 };
    res.stops.forEach((st) => { cnt[gradeOf(Math.abs(st.err)).k]++; });
    const stopWhy = [['perfect', 'ぴったり'], ['good', 'いいね'], ['ok', 'おしい'], ['ng', 'ざんねん']]
      .filter(([k], i) => cnt[k] > 0 || i === 0).map(([k, w]) => `${w} ${cnt[k]}`).join(' ／ ');
    const avgLate = res.stops.length ? Math.round(res.stops.reduce((a, st) => a + st.late, 0) / res.stops.length) : 0;
    const bd = res.breakdown;
    $('#res-breakdown').innerHTML = [
      ['えきに ぴったり とまれた？', bd.stop, 30, stopWhy],
      ['じかんどおりに はしれた？', bd.time, 30, avgLate <= 5 ? 'じかん どおり！' : `おくれ へいきん ${avgLate}びょう`],
      ['スピードを まもれた？', bd.comp, 25, `じどうブレーキ ${res.overspeed}かい ・ ひじょう ${res.ebUsed}かい`],
      ['のりごこち', bd.ride, 15, `ガクン ${res.jerkEvents}かい`],
    ].map(([label, got, max, why]) => {
      const r = got / max;
      const col = r >= 0.9 ? 'var(--green)' : r >= 0.6 ? 'var(--acc)' : 'var(--amber)';
      return `<div class="rb-row"><span class="rb-l">${label}</span>
        <span class="rb-bar"><i data-w="${r.toFixed(3)}" style="background:${col}"></i></span>
        <span class="rb-n"><b>${Math.round(got)}</b> / ${max}</span><span class="rb-why">${why}</span></div>`;
    }).join('');
    $('#res-stops').innerHTML = '<tr><th></th><th>えき</th><th>とまった ずれ</th><th>おくれ</th></tr>' +
      res.stops.map((st) => {
        const g = gradeOf(Math.abs(st.err));
        return `<tr><td class="gcol"><span class="gchip" style="--g:${g.col}">${g.mark}</span></td><td>${st.name}<span class="st-kana">${kanaOf(st.name)}</span></td>
        <td style="color:${g.col}">${errTxt(st.err)}</td>
        <td class="${st.late > 30 ? 'bad' : ''}">${st.late > 3 ? st.late + 'びょう' : 'ぴったり'}</td></tr>`;
      }).join('');
    /* じこベスト(区間ごと) */
    const rb = $('#res-best');
    const ps = best.prevSeg;
    if (best.retried) { rb.className = 'res-best info'; rb.textContent = 'とちゅうから やりなおした うんてんは きろくに のこらないよ'; }
    else if (best.segBest && ps) { rb.className = 'res-best new'; rb.textContent = 'じこベスト こうしん！'; }
    else if (best.segBest) { rb.className = 'res-best info'; rb.textContent = 'この くかんの はじめての きろく'; }
    else { rb.className = 'res-best info'; rb.textContent = `この くかんの ベスト ${ps.total}てん (${ps.rank})`; }
    const ng = this._nextGoal(res);
    $('#res-next').innerHTML = ng ? `<span class="rn-cap">つぎの めあて</span>${ng}` : '';
    $('#res-next').classList.toggle('hidden', !ng);
    /* この運転でもらったスタンプ */
    const rs = $('#res-stamps');
    if (this.runStamps.length) {
      rs.innerHTML = `<p>もらった えきスタンプ ${this.runStamps.length}こ</p>`;
      this.runStamps.slice(0, 8).forEach((r, i) => { const cv = document.createElement('canvas'); drawStamp(cv, r.name, { tier: r.tier, size: 72, seed: i }); rs.appendChild(cv); });
      rs.classList.remove('hidden');
    } else rs.classList.add('hidden');
    const rbg = $('#res-badges');
    if (this.runBadges.length) {
      rbg.innerHTML = '<p>あたらしい くんしょう</p>' + this.runBadges.map((id) => {
        const b = badgeById(id);
        return `<span class="rb-badge"><span class="bd-ico">${this._badgeIco(b)}</span>${b.name}</span>`;
      }).join('');
      rbg.classList.remove('hidden');
    } else rbg.classList.add('hidden');
    /* つづきを はしる(区間運転で、まだ先があるとき) */
    const nb = $('#btn-res-next');
    const stops = this._svcStops();
    if (this.endIdx != null && this.endIdx < stops.length - 1) {
      const span = this.endIdx - this.startIdx;
      const nTo = Math.min(stops.length - 1, this.endIdx + span);
      nb.innerHTML = `つづきを はしる ${icon('chevron-right')}<small>${stops[this.endIdx].name} → ${stops[nTo].name}</small>`;
      nb.classList.remove('hidden');
    } else nb.classList.add('hidden');
    /* 段階的に見せる */
    [['#res-breakdown', 1.2], ['#res-next', 1.5], ['#res-stamps', 1.5], ['#res-badges', 1.8], ['.res-table-wrap', 2.0]].forEach(([s, d]) => {
      const el = $(s);
      el.style.animation = 'none'; void el.offsetWidth; el.style.animation = ''; el.style.animationDelay = d + 's';
    });
    this.go('result');
    $('#screen-result').scrollTop = 0;
    /* 点数をカウントアップ(10点ごとに ピッ)・ランクをポンと押す */
    const tot = $('#res-total');
    const t0 = performance.now();
    rk.classList.remove('pop');
    let lastTen = 0;
    const step = () => {
      const k = Math.min(1, (performance.now() - t0) / 1100);
      const v = Math.round(res.total * (1 - Math.pow(1 - k, 3)));
      tot.textContent = v;
      const ten = Math.floor(v / 10);
      if (ten > lastTen) { lastTen = ten; this._cue('beep', 0.08, 2); }
      if (k < 1) requestAnimationFrame(step);
      else {
        rk.classList.add('pop');
        this._cue('doorThud', 0.55, 0.7);
        if (res.rank === 'S' || res.rank === 'A') this._cue('stopPerfect', 0.3);
      }
    };
    requestAnimationFrame(step);
    setTimeout(() => document.querySelectorAll('.rb-bar i').forEach((i) => { i.style.transform = `scaleX(${i.dataset.w})`; }), 1300);
  },

  /* 成績票の「つづきを はしる」: 同じ駅数だけ先へ */
  _continueRun() {
    const n = this._svcStops().length;
    if (this.endIdx == null) return;
    const span = this.endIdx - this.startIdx;
    this.startIdx = this.endIdx;
    this.endIdx = Math.min(n - 1, this.startIdx + span);
    if (this.endIdx >= n - 1) this.endIdx = null;
    this.startDrive(true);
  },

  /* ================= ループ ================= */
  loop() {
    requestAnimationFrame(() => this.loop());
    const now = performance.now();
    const dt = Math.min(0.1, (now - (this._lastT || now)) / 1000);
    this._lastT = now;
    if (!this.scene) return;
    const m = this.mode;
    if (m === 'drive') {
      if (!this.sim || !this.running && !this.sim.ended) { this.scene.render(0); return; }
      if (this.running && !this.paused) {
        const mult = this._fast || 1;
        for (let i = 0; i < mult && this.running; i++) {
          if (this._auto) this._auto();
          this.sim.tick(dt);
        }
        if (this.audio) this.audio.update(this.sim, dt, this.scene.audioEnv());
        if (this.rainGlass) this.rainGlass.render(dt, this.sim.v, this.scene.cockpit, this.scene._inTunnelNow);
      }
      this.scene.render(this.paused ? 0 : dt);
      const h = this.sim.hud();   // 1フレームに1回だけ計算して計器とHUDで使う
      if (typeof this.cab.setLight === 'function' && this.scene.cockpit) this.cab.setLight(this.scene.cockpit.light);
      this.cab.render(h);
      this._updateCoach(h);
    } else if (m === 'result') {
      this.scene.render(dt);
    } else if (m === 'title' || m === 'select' || m === 'stamps') {
      if (!document.hidden) {
        this._attractTick(dt);
        this.scene.render(dt);
      }
    }
    /* fpsが持続的に低ければ自動で描画負荷を下げる */
    if (typeof this.scene.autoQualityTick === 'function') {
      if (!this._fast && !this.debug) {
        const fadeOn = (this._fadeEl || (this._fadeEl = $('#fade'))).classList.contains('on');
        this.scene.autoQualityTick(dt, { busy: fadeOn || now - (this._runT0 || 0) < 5000 });
      }
    } else {
      this._fpsT = (this._fpsT || 0) + dt;
      if (this._fpsT > 6) {
        this._fpsT = 0;
        if (this.scene.fps && this.scene.fps < 33 && !this._fast && !this.debug) {
          const what = this.scene.stepDownQuality();
          if (what) console.log('[auto-quality] step down:', what, 'fps=', Math.round(this.scene.fps));
        }
      }
    }
  },

  /* ================= デバッグ(?debug=1) ================= */
  _exposeTest() {
    window.__test = {
      app: this,
      fast: (n) => { this._fast = n; },        // シミュレーション倍速（描画はそのまま）
      auto: (on) => { this._auto = on ? this._makeAutopilot() : null; },
      /* E2E用: 設定して即出発 {service, weather, daytime, dir, start, end} */
      setup: async (c = {}) => {
        if (c.service) this.service = c.service;
        if (c.weather) this.weather = c.weather;
        if (c.daytime) this.daytime = c.daytime;
        if (c.dir) this.direction = c.dir;
        this.line = prepareLine(this.rawLine, this.direction);
        this.endIdx = c.end != null ? c.end : null;
        this.startIdx = c.start || 0;
        await this.startDrive(true);
      },
      cam: (m) => { this.camIdx = CAM_MODES.indexOf(m); this._setCam(m); },
      go: (m) => this.go(m),
      /* 描画せずにシミュレーションだけ sec 秒すすめる(自動運転)。撮影位置まで一気に動かす用 */
      advance: (sec) => {
        const sim = this.sim, ap = makeAutopilot(sim);
        for (let t = 0; t < sec && !sim.ended; t += 0.05) { if (sim.doorOpen) sim.skipDwell(); ap(); sim.tick(0.05); }
        if (this.scene) this.scene._camPos = null;
        return { pos: Math.round(sim.pos), v: Math.round(sim.v), next: sim.stops[sim.stopIdx] && sim.stops[sim.stopIdx].name };
      },
      /* 次の停車駅の手前 m メートルまで自動運転で進める */
      approach: (m) => {
        const sim = this.sim, ap = makeAutopilot(sim);
        for (let i = 0; i < 200000 && !sim.ended; i++) {
          if (sim.doorOpen) sim.skipDwell();
          const nx = sim.stops[sim.stopIdx];
          if (nx && !sim.doorOpen && nx.stopAt - sim.pos < m && sim.v > 1) break;
          ap(); sim.tick(0.05);
        }
        if (this.scene) this.scene._camPos = null;
        return { pos: Math.round(sim.pos), v: Math.round(sim.v) };
      },
    };
  },

  /* デバッグ用の自動運転（tools/autodrive.mjs と同じ制御則: sim/autopilot.js） */
  _makeAutopilot() {
    const sim = this.sim;
    const ap = makeAutopilot(sim);
    return () => { if (this.sim === sim) ap(); };
  },
};

addEventListener('DOMContentLoaded', () => App.boot());
