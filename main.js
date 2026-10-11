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
/* ずれをcmで(子どもには「+0.06m」より「6cm いきすぎ」)。1m より大きいときは「5.2m てまえ」 */
const cmOf = (err) => Math.round(Math.abs(err) * 100);
const errTxt = (err) => {
  const a = Math.abs(err);
  if (a >= 1) return `${a.toFixed(1)}m ${err > 0 ? 'いきすぎ' : 'てまえ'}`;
  const cm = cmOf(err);
  return cm < 5 ? 'ぴったり' : `${cm}cm ${err > 0 ? 'いきすぎ' : 'てまえ'}`;
};
/* 距離のまるめ: 100m より遠いと 10m、20m より遠いと 5m きざみ(数字が ちらちら かわって読めない、を ふせぐ) */
const qStep = (m) => (m >= 100 ? 10 : m >= 20 ? 5 : 1);
const qM = (m) => Math.round(m / qStep(m)) * qStep(m);
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
    /* タッチ端末か(iPadの「デスクトップ用Webサイト」表示でも maxTouchPoints は 5 になる)。
     * 画質のきまり・タッチボタン・コーチのボタン表記(すすむ/ブレーキ か ↑/↓)に使う */
    const touch = navigator.maxTouchPoints > 1 || matchMedia('(any-pointer: coarse)').matches;
    this._touch = touch;
    document.documentElement.classList.toggle('touch', touch);
    this.KUP = touch ? `<span class="kc">${icon('chevron-up')}すすむ</span>` : '<span class="kc">↑</span>';
    this.KDN = touch ? `<span class="kc">${icon('chevron-down')}ブレーキ</span>` : '<span class="kc">↓</span>';
    const qp = (location.search.match(/[?&]q=(high|mid|low)/) || [])[1];   // 検証用の画質指定
    this._qp = qp;
    this.quality = qp || this.settings.quality || this._defQuality();
    /* 前回の むき(のぼり/くだり)を先に もどす(タイトルのデモ走行も おなじ むきで はしる。ワールドを2回 作らない) */
    if (this.save.last && this.save.last.direction === 'up') this.direction = 'up';
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

  /* 画質「じどう」のときの きまり(タッチ端末=ふつう / パソコン=きれい) */
  _defQuality() { return this._touch ? 'mid' : 'high'; },

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
  /* デモ走行の列車。路線は プレイヤーの路線(this.line)と おなじものを使う
   * (おなじ路線オブジェクトなら setWorld は ワールドを作り直さない → 運転から もどるときに 止まらない) */
  _makeAttract() {
    const A = { line: null, sim: null, ap: null, start: 3, dir: null, tod: realTod(), camT: 0, camI: 0 };
    this._attractLine(A, this.line);
    return A;
  },

  /* デモ走行を 路線 line(むき つき)に のせかえる。
   * くだりは 経堂から(複々線を快走 → 車両基地 → 多摩川)、のぼりは 登戸から(多摩川 → 成城の街) */
  _attractLine(A, line) {
    const dir = (line && line.meta && line.meta.direction) || 'down';
    if (!line) line = prepareLine(this.rawLine, dir);
    if (A.line === line && A.sim) return false;
    A.line = line; A.dir = dir;
    A.start = dir === 'up' ? 2 : 3;
    A.sim = new TrainSim(line, { service: 'exp', weather: 'clear', timetable: this.timetable });
    A.sim.reset(A.start);
    A.sim.skipDwell();
    A.ap = makeAutopilot(A.sim);
    return true;
  },

  /* 夜は うしろからだと 列車が 見えない(窓あかりの谷間)ので、よこから はじめる */
  _attractSeq(A) { return A.tod === 'night' ? ['side', 'front', 'side', 'cab', 'chase'] : ['chase', 'side', 'front', 'drone', 'cab', 'side']; },

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
    const seq = this._attractSeq(A);
    if (A.camT > 9) {
      A.camT = 0;
      A.camI = (A.camI + 1) % seq.length;
      this.scene.setCameraMode(seq[A.camI]);
      document.body.classList.toggle('cam-cab', seq[A.camI] === 'cab');
    }
    const nx = sim.stops[sim.stopIdx];
    const dest = A.dir === 'up' ? 'しんじゅく' : 'しんゆりがおか';
    const txt = `LIVE ・ きゅうこう ${dest} ゆき ・ ${nx ? 'つぎは ' + kanaOf(nx.name) + ' ・ ' : ''}${CAM_NAME[this.scene.camMode] || ''}`;
    if (txt !== this._liveTxt) { this._liveTxt = txt; $('#live-txt').textContent = txt; }
  },

  _enterAttract() {
    const A = this.attract;
    if (!A) return;
    this._attractLine(A, this.line);
    this.scene.setWorld(A.line, A.sim);
    this.scene.setTimeOfDay(A.tod);
    this.scene.setWeather('clear');
    A.camT = 0; A.camI = 0;
    this.scene.setCameraMode(this._attractSeq(A)[0]);
    document.body.classList.toggle('cam-cab', this.scene.camMode === 'cab');
    this.rainGlass.setActive(false);
  },

  /* タイトルなどに もどるとき: ワールドを作り直す(重い)ときだけ 暗転で かくす(画面が かたまって見えない) */
  _returnToAttract(prev) {
    const A = this.attract;
    if (!A) return;
    const nextLine = this.line || A.line;
    const heavy = !!this._qualityDirty || (this.scene && this.scene.line !== nextLine);
    if (!heavy || prev === 'boot') {
      if (this._qualityDirty) this._rebuildScene();
      this._enterAttract();
      return;
    }
    const fade = $('#fade');
    fade.classList.add('on');
    const tok = (this._swapTok = (this._swapTok || 0) + 1);
    nextFrame().then(nextFrame).then(() => {
      if (tok !== this._swapTok) return;
      try {
        if (this.mode === 'title' || this.mode === 'select' || this.mode === 'stamps') {
          if (this._qualityDirty) this._rebuildScene();
          this._enterAttract();
        }
      } finally {
        if (!this._starting) fade.classList.remove('on');
      }
    });
  },

  /* ================= 画面遷移 ================= */
  go(mode) {
    const prev = this.mode;
    this.mode = mode;
    /* mode-* と cam-cab だけを入れかえる(運転台の cab-dark など、ほかの部品がつけた class は のこす) */
    const bc = document.body.classList;
    Array.from(bc).forEach((c) => { if (c.indexOf('mode-') === 0) bc.remove(c); });
    bc.add('mode-' + mode);
    bc.toggle('cam-cab', !!(this.scene && this.scene.camMode === 'cab'));
    const screens = { title: 'title', select: 'select', result: 'result', stamps: 'stamps', boot: 'loading' };
    document.querySelectorAll('.screen').forEach((el) => {
      if (el.classList.contains('overlay')) return;
      el.classList.toggle('active', el.id === 'screen-' + screens[mode]);
    });
    if (mode === 'title') { clearInterval(this._tipT); this._tipT = null; }
    if ((mode === 'title' || mode === 'select' || mode === 'stamps') && (prev === 'drive' || prev === 'result' || prev === 'boot')) {
      this._returnToAttract(prev);
    }
    this._applyBackdrop();
    if (mode === 'stamps') this.buildStampBook();
    if (mode === 'title') this.updateStampCount();
    this.resizeGL();
  },

  /* 不透明に ちかい画面(えらぶ・スタンプ・成績票)の うしろは「背景モード」: 影とブルームを止め、3Dは 1/3 の回数だけ描く */
  _applyBackdrop() {
    const m = this.mode;
    const bd = m === 'select' || m === 'stamps' || m === 'result';
    if (!this.scene || this._bd === bd && this._bdScene === this.scene) return;
    this._bd = bd; this._bdScene = this.scene;
    if (typeof this.scene.setBackdrop === 'function') { try { this.scene.setBackdrop(bd); } catch (e) { /* noop */ } }
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
      if (!this.line || this.line.meta.direction !== this.direction) this.line = prepareLine(this.rawLine, this.direction);
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
        /* いまの 3Dの 路線と おなじ むきに もどしたときは それを つかう(出発で ワールドを 作りなおさない) */
        const SL = this.scene && this.scene.line;
        this.line = SL && SL.meta && SL.meta.direction === this.direction ? SL : prepareLine(this.rawLine, this.direction);
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
          /* あめ・ゆきの空(くもり空の環境マップ)を 出発までに 先に よんでおく */
          if (key === 'weather' && b.dataset.v !== 'clear' && this.scene && typeof this.scene.ensureEnv === 'function') {
            try { const p = this.scene.ensureEnv('rain'); if (p && typeof p.catch === 'function') p.catch(() => { /* noop */ }); } catch (e) { /* noop */ }
          }
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
    if (scroll) this._scrollToStart(ol);
    this.renderSummary();
  },

  /* スタートの駅が 見えていないときだけ、上から 4わり くらいの 位置に くるよう スクロールする。
   * 広い画面は リスト自身が スクロールする。たて画面は 画面ごと(下の パネルに かくれる ぶんは 見えない あつかい)。
   * scrollIntoView は つかわない(画面の 見出しまで 上に おしだされるため) */
  _scrollToStart(ol) {
    const row = ol.querySelector('.rt.start');
    const sc = $('#screen-select');
    if (!row || !sc || !sc.classList.contains('active')) return;
    const own = ol.scrollHeight > ol.clientHeight + 2 && getComputedStyle(ol).overflowY !== 'visible';
    /* 画面ごと うごかすときは、スタートが いちばん上の駅なら うごかさない(見出しと ①むき から 見てもらう) */
    if (!own && this.startIdx === 0) return;
    const box = own ? ol : sc;
    const br = box.getBoundingClientRect(), r = row.getBoundingClientRect();
    let bottom = br.bottom;
    const dock = $('.sel-opts');
    if (!own && dock && getComputedStyle(dock).position === 'fixed') bottom = Math.min(bottom, dock.getBoundingClientRect().top);
    if (r.top >= br.top + 4 && r.bottom <= bottom - 4) return;
    box.scrollTop += r.top - br.top - (bottom - br.top) * 0.4;
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
      drawStamp(cv, name, { tier, size: 88, seed: i });
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
    /* 見本: くろ・いろ・きん の3つ(±の記号は つかわない) */
    const lg = $('#stamp-legend');
    if (lg && !lg.childElementCount) {
      const cap = document.createElement('span');
      cap.className = 'sl-cap';
      cap.textContent = '「8」に とまると もらえるよ';
      lg.appendChild(cap);
      [[1, 'くろ', '1m いない'], [2, 'いろ', '35cm いない'], [3, 'きん', '10cm いない']].forEach(([t, w, d]) => {
        const it = document.createElement('span');
        it.className = 'sl-it sl-t' + t;
        const cv = document.createElement('canvas');
        drawStamp(cv, '経堂', { tier: t, size: 40, seed: t });
        const tx = document.createElement('span');
        tx.innerHTML = `<b>${w}</b> ─ ${d}`;
        it.append(cv, tx);
        lg.appendChild(it);
      });
    }
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
    const cur = (key) => String(key === 'quality' ? (S.quality == null ? 'auto' : S.quality) : S[key]);
    const segRow = (label, key, opts) => `<div class="set-row"><span>${label}</span><div class="seg" data-key="${key}">${opts.map(([v, t]) => `<button data-v="${v}" class="${cur(key) === String(v) ? 'on' : ''}">${t}</button>`).join('')}</div></div>`;
    list.innerHTML = `
      <div class="set-row"><span>おとの おおきさ</span><input type="range" id="set-vol" min="0" max="1" step="0.05" value="${S.volume}"></div>
      ${segRow('アナウンス', 'voice', [['true', 'あり'], ['false', 'なし']])}
      ${segRow('ガイド', 'guide', [['true', 'あり'], ['false', 'なし']])}
      <p class="set-note">ガイド = 「8」までの光のめじるし と ブレーキめやす</p>
      ${segRow('がしつ', 'quality', [['auto', 'じどう'], ['high', 'きれい'], ['mid', 'ふつう'], ['low', 'かるい']])}
      <p class="set-note">がしつは タイトルにもどったときに かわります。「じどう」は うごきが おもいと かるくなります</p>
      <div class="set-row"><span>きろく</span><button class="btn btn-sm btn-warn" id="set-reset">きろくと スタンプを けす</button></div>`;
    $('#set-vol').addEventListener('input', (e) => { S.volume = Number(e.target.value); this.applyVolume(); store.set(SET_KEY, S); });
    list.querySelectorAll('.seg').forEach((sg) => {
      sg.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
        const key = sg.dataset.key;
        const v = b.dataset.v === 'true' ? true : b.dataset.v === 'false' ? false : b.dataset.v;
        const was = S[key];
        S[key] = v;
        sg.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
        if (key === 'voice') this.announcer.setEnabled(v && !this._muted);
        if (key === 'guide' && this.scene) this.scene.guide = v;
        if (key === 'quality' && v === 'auto') {
          /* じどう: 端末に あわせた画質にもどし、じどう軽量化を また つかう */
          S.quality = null;
          this._qualityDirty = this._defQuality() !== this.quality || was != null;
        } else if (key === 'quality') {
          this._qualityDirty = v !== this.quality || was == null;
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
    /* 車内放送(読み上げ)も おなじ おおきさに */
    if (this.announcer && typeof this.announcer.setVolume === 'function') this.announcer.setVolume(this.settings.volume);
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
    this.quality = this._qp || this.settings.quality || this._defQuality();
    /* 同じキャンバスに作り直すと古いGPU資源が残るので、文脈ごと捨てて新しいキャンバスにする */
    try { this.scene.renderer.forceContextLoss(); this.scene.renderer.dispose(); } catch (e) { /* noop */ }
    const old = $('#gl');
    const cv = old.cloneNode(false);
    old.replaceWith(cv);
    const A = this.attract;
    this._attractLine(A, this.line);   // 新しいステージは さいしょから プレイヤーの路線で(2回 作らない)
    this.scene = new RailScene(cv, A.line, A.sim, {
      quality: this.quality, timeOfDay: A.tod, weather: 'clear', autoQ: !this._qp && !this.settings.quality,
    });
    this.scene.guide = this.settings.guide;
    this.scene.setCameraMode(this._attractSeq(A)[A.camI] || 'chase');
    this._bd = null;
    this._applyBackdrop();
    this.resizeGL();
  },

  /* ================= 入力 ================= */
  /* 「いきすぎ！」の パネルが出ているあいだは レバーも うごかない(えらぶまで まつ) */
  _canOp() { return this.mode === 'drive' && this.running && !this.paused && !this._overrun; },

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
    $('#btn-res-select').addEventListener('click', () => {
      if (this._starting) return;   // 出発の フェード中(すぐ うんてん画面に かわる)
      this.renderSvcCards(); this.go('select'); this.renderRoute(true);
    });
    $('#btn-overrun-retry').addEventListener('click', () => { this._setOverrun(false); this.retryStation(); });
    /* このまま つぎの駅へ: その駅は ×(0てん)で とうちゃく あつかいにして、ドアを あける */
    $('#btn-overrun-go').addEventListener('click', () => {
      if (!this._overrun) return;
      this._setOverrun(false);
      if (this.sim && typeof this.sim.acceptOverrun === 'function' && this.sim.acceptOverrun()) {
        /* はんていカードの あとに ひとこと(カードの上に かさねない) */
        this._queuePop(() => this.flashMsg('つぎは もっと はやく ブレーキ！', 2000), 0);
      }
    });
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
      if (ev.code === 'KeyM') {
        this._muted = !this._muted;
        if (this.audio && this.audio.setMuted) this.audio.setMuted(this._muted);
        if (this.announcer) this.announcer.setEnabled(!this._muted && this.settings.voice);
        return;
      }
      if (this.paused || this._overrun) return;
      const n = this.sim.notch;
      if (ev.code === 'ArrowUp' || ev.code === 'KeyW') this.sim.setNotch(Math.min(4, n + 1));
      else if (ev.code === 'ArrowDown' || ev.code === 'KeyS') this.sim.setNotch(Math.max(-8, n === -8 ? -8 : n - 1));
      else if (ev.code === 'Space') this.sim.setNotch(-8);
      else if (ev.code === 'KeyN' || ev.code === 'Digit0') this.sim.setNotch(0);
      else if (ev.code === 'KeyH') { if (this.audio) this.audio.horn(); this.grantBadge('horn'); }
      else if (ev.code === 'KeyC') this.cycleCam();
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
    const RG = this.rainGlass;
    if (RG) {
      /* ゆきの ガラス(雪のつぶ)は rainGlass.setMode が あるときだけ */
      const canSnow = typeof RG.setMode === 'function';
      if (canSnow && (this.weather === 'rain' || this.weather === 'snow')) RG.setMode(this.weather);
      RG.setActive((this.weather === 'rain' || (this.weather === 'snow' && canSnow)) && m === 'cab' && this.mode === 'drive');
    }
  },

  resizeGL() {
    this._pauseDirty = true;   // ポーズ中でも 大きさが かわったら 1回 描きなおす
    /* 画面の むき・大きさが かわったら スキップボタンの もとの高さ(CSSの bottom)を 読みなおす */
    if (this._bh) this._bh.skip._base = null;
    if (!this.scene) return;
    const wrap = $('#gl-wrap');
    this.scene.resize(wrap.clientWidth, wrap.clientHeight);
    if (this.rainGlass) this.rainGlass.resize(wrap.clientWidth, wrap.clientHeight);
  },

  /* ================= 運転開始 ================= */
  async startDrive(again = false) {
    /* 二度おし よけ: フェード(380ms)のあいだも 画面のボタンは押せるので、
     * 2かい目は むしする(区間が とんだり、ワールドを2回 作りなおしたり しない) */
    if (this._starting) return;
    this._starting = true;
    try {
      this._unlockAudio();
      /* 路線は むきが おなじなら いまのものを つかう(タイトルのデモ走行と おなじ路線なら
       * ワールドを 作りなおさないので、出発の 暗転が みじかい) */
      if (!again && (!this.line || !this.line.meta || this.line.meta.direction !== this.direction)) {
        this.line = prepareLine(this.rawLine, this.direction);
      }
      /* 前回えらんだ列車として おぼえる(つぎに選択画面を開いたときに もどす) */
      this.save.last = { direction: this.direction, service: this.service, daytime: this.daytime, weather: this.weather, startIdx: this.startIdx, endIdx: this.endIdx };
      this.writeSave();
      const fade = $('#fade');
      fade.classList.add('on');
      /* じゅんびが 0.7秒より ながいときだけ「じゅんび中」を出す(すぐ おわるときは 出さない) */
      clearTimeout(this._slowT);
      this._slowT = setTimeout(() => { if (this._starting) fade.classList.add('slow'); }, 700);
      await new Promise((r) => setTimeout(r, 380));
      this.go('drive');
      await nextFrame();
      this.beginRun(this.startIdx);
      /* シェーダーの先読み: 少しずつ作れるなら(prewarmAsync) 待つ(ながくても6秒)。ないときは いっきに。
       * 待つあいだは 時計を止める(暗いうちに 発車までの びょうが へらない) */
      this.running = false;
      const S = this.scene;
      if (typeof S.prewarmAsync === 'function') {
        try {
          await Promise.race([S.prewarmAsync(), new Promise((r) => setTimeout(r, 6000))]);
        } catch (e) { /* 先読みできなくても続行 */ }
      } else if (S.prewarm) {
        try { S.prewarm(); } catch (e) { /* noop */ }
      }
      await nextFrame();
      if (this.mode === 'drive' && this.sim && !this.sim.ended) this.running = true;
      this._runT0 = performance.now();
      await nextFrame();   // 運転台の さいしょの1コマが 描けてから 明ける
      fade.classList.remove('on');
    } finally {
      this._starting = false;
      clearTimeout(this._slowT);
      $('#fade').classList.remove('slow');
    }
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
    this._jerkTold = false;
    this._overChimed = false;
    this._finalSeq = false;
    this._celebrateUntil = 0;
    this._setOverrun(false);
    this._resetCoachState();
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
    this._runT0 = performance.now();
    if (this.audio) {
      this.audio.ensure();
      this.audio.bind(this.sim);
    }
    this.sim.onEvent((type, e) => this.onSimEvent(type, e));
    $('#drive-head-svc').innerHTML = `<span class="dh-svc" style="--svc:${SVC_COLOR[this.service]}">${rubySvc(svcName)}</span>${rubyStation(dest)} ゆき`;
    this._buildRouteStrip();
    this._renderMarks();
    $('#msg-center').classList.add('hidden');
    this.setPaused(false);
    this.running = true;
    this.resizeGL();
  },

  /* コーチ・めやすの「まえの表示」を わすれる(新しい運転・やりなおしのとき) */
  _resetCoachState() {
    this._coachTxt = null; this._cb = null;
    this._sd = {};
    this._want = undefined; this._wantDir = undefined;
    if (this.cab && typeof this.cab.setTarget === 'function') { try { this.cab.setTarget(null); } catch (e) { /* noop */ } }
    ['#tb-up', '#tb-dn'].forEach((s) => { const b = $(s); if (b) b.classList.remove('want'); });
  },

  /* 「いきすぎ！」パネル(暗い幕つき)を出す・しまう */
  _setOverrun(on) {
    this._overrun = !!on;
    const m = $('#overrun-modal');
    if (m) m.classList.toggle('hidden', !on);
    document.body.classList.toggle('ov-open', !!on);
  },

  /* この運転の ◎○△× (さいきんの10えき)と「れんぞく ×N」を 路線の帯に出す(とうちゃくの ときだけ 書きかえる) */
  _renderMarks() {
    const el = $('#rs-marks');
    if (!el || !this.sim) return;
    const S = this.sim.score.stops.slice(-10);
    el.innerHTML = S.map((st) => {
      const g = gradeOf(Math.abs(st.err));
      return `<i class="gm" style="--g:${g.col}">${g.mark}</i>`;
    }).join('') + (this.runStreak >= 2 ? `<span class="gm-st">れんぞく ×${this.runStreak}</span>` : '');
  },

  onSimEvent(type, e) {
    const A = this.announcer;
    if (type === 'arrived') {
      /* 'arrived' は次の駅へ進める前に出るので、いまの stopIdx が着いた駅 */
      this.lastStationIdx = this.sim.stopIdx;
      const last = this.sim.score.stops[this.sim.score.stops.length - 1];
      const abs = Math.abs(last.err);
      /* とうちゃくの お祝いは じゅんばんに: 「いきすぎ」などの お知らせは けしてから カードを出す。
       * カードが出ているあいだ(3.4秒)は「はやく しゅっぱつ」ボタンも 出さない */
      clearTimeout(this._msgT);
      $('#msg-center').classList.add('hidden');
      this._celebrateUntil = performance.now() + 3400;
      if (this.sim.stopIdx >= this.sim.stops.length - 1) this._finalSeq = true;   // しゅうてん: くんしょうは 成績票で
      this.showStopCard(e.name, last);
      this._renderMarks();
      /* スタンプ・くんしょうは カードのあとに じゅんばんに出す。
       * スタンプが出るときは カードの0.9秒あと、出ないときは くんしょうが カード(3.4秒)と かさならないよう待つ */
      const prevBest = this.save.bestErr[e.name];
      this.save.bestErr[e.name] = Math.min(prevBest == null ? 99 : prevBest, abs);
      const tier = tierOf(abs);
      const raised = tier >= 1 && tier > (this.save.stampTier[e.name] || 0);
      this._queuePop(null, raised ? 900 : 3400);
      if (tier >= 1) this.awardStamp(e.name, tier);
      else this.writeSave();
    }
    if (type === 'door-closed') {
      /* 出発信号が あか(さきの電車が いる)ときは「出発進行」と いわない(コーチの「まとう」と くいちがう) */
      const sg = this.sim.nextSignals(1)[0];
      const red = sg && sg.dist < 150 && sg.aspect === 0;
      if (red) this.flashMsg('ドアが しまりました。<i class="sig sig-r"></i>しんごうが あか ── まとう', 2200);
      else this.flashMsg('ドアが しまりました ── <ruby>出発進行<rt>しゅっぱつしんこう</rt></ruby>！', 1800);
    }
    if (type === 'overrun' && !this._overrun) this.flashMsg(`${icon('warn')} いきすぎ！ とまるところを すぎています`, 2600, true);
    if (type === 'overrun-stop') {
      clearTimeout(this._msgT);
      $('#msg-center').classList.add('hidden');
      $('#ov-txt').innerHTML = `「8」より <b>${Math.round(e.err)}m</b> さきで とまったよ`;
      /* 「このまま つぎの駅へ」は エンジンに acceptOverrun が あるときだけ */
      $('#btn-overrun-go').classList.toggle('hidden', !(this.sim && typeof this.sim.acceptOverrun === 'function'));
      this._setOverrun(true);
    }
    if (type === 'ats-brake') {
      /* じどうブレーキの りゆうを ひとことで(kind が ないときは まえの文) */
      const kind = e.kind;
      const tg = e.target != null ? Math.round(e.target) : null;
      let msg;
      if (kind === 'stop') msg = 'ブレーキが おそかった！ じどうブレーキが かかったよ。「ブレーキまで」が 0 に なる まえに ブレーキ';
      else if (kind === 'signal') msg = `<i class="sig sig-${tg === 0 ? 'r' : 'y'}"></i>しんごうが ${tg === 0 ? 'あか' : 'きいろ'}！ じどうブレーキ`;
      else if (kind === 'over') msg = `スピード オーバー（${tg} より はやい）！ じどうブレーキ`;
      else {
        const a = this.sim.hud().ats;
        const why = a && a.kind === 'limit' ? `（このさき ${Math.round(a.target)} のため）` : '';
        msg = `スピードの<ruby>出<rt>だ</rt></ruby>しすぎ！ じどうブレーキが かかりました${why}`;
      }
      this.flashMsg(`${icon('warn')} ${msg}`, kind === 'stop' ? 3200 : 2400, true);
    }
    /* ガクン(レバーを いっきに うごかした): その場で 見せる。せつめいは 1回目だけ */
    if (type === 'jerk') {
      if (this.scene && this.scene.camMode === 'cab' && typeof this.scene._bv === 'number') this.scene._bv += e.dir < 0 ? -1.4 : 1.0;
      this._cue('doorThud', 0.3, 1.6);
      if (!this._jerkTold) {
        this._jerkTold = true;
        this.flashMsg('ガクン！ おきゃくさんが よろけたよ。レバーは 1だんずつ うごかそう', 2600, true);
      } else this.flashMsg('ガクン！', 900, true);
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
    const gold = abs <= 0.10;   // ±10cm: きんの スタンプと おなじ ランク
    el.style.setProperty('--g', gold ? 'var(--gold)' : g.col);
    el.className = 'g-' + g.k + (gold ? ' gold' : '');
    this.runStreak = abs <= 1 ? (this.runStreak || 0) + 1 : 0;
    $('#sc-sta').innerHTML = `${rubyStation(name)}<small> に とうちゃく</small>`;
    $('#sc-streak').innerHTML = this.runStreak >= 2 ? `れんぞく <b>×${this.runStreak}</b>` : '';
    $('#sc-grade').textContent = g.mark;
    const dir = err > 0 ? 'いきすぎ' : 'てまえ';
    if (abs >= 1) {
      $('#sc-cm').innerHTML = `${abs.toFixed(1)}<small>m</small><span class="sc-dir">${dir}</span>`;
    } else {
      const cm = cmOf(err);
      $('#sc-cm').innerHTML = `${cm < 5 ? 0 : cm}<small>cm</small><span class="sc-dir">${cm < 5 ? '' : dir}</span>`;
    }
    $('#sc-word').textContent = gold ? 'きんの ぴったり！' : g.word;
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
    /* しゅうてんでは トーストを出さない(カード → スタンプ → そらから → 成績票 の じゅんばんを まもる)。
     * 成績票の「あたらしい くんしょう」に ならぶ */
    if (this._finalSeq) return;
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
        this._cue('stampPress', 0.5);
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
    this._pauseDirty = true;   // ポーズの あいだは 3Dを 1回だけ 描いて とめる
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

  /* 表示する距離を「きざみ」で まるめ、前の表示から 半きざみ以上 かわったときだけ 書きかえる
   * (150msごとの計算で 95 → 90 → 95 と ちらつかない)。
   * コーチと ブレーキめやすは おなじ slot を つかう(おなじ距離が べつの数字に ならない) */
  _steady(slot, m) {
    if (!this._sd) this._sd = {};
    const prev = this._sd[slot];
    if (prev != null && Math.abs(m - prev) < qStep(prev) * 0.75) return prev;
    const q = qM(m);
    this._sd[slot] = q;
    return q;
  },

  /* ブレーキめやす: このままのブレーキだと、どこで止まるか。
   * ブレーキを かける場所の 120m 手前から(または ブレーキ中・手前の制限に あわせるとき)だけ 出す */
  _updateBrakeGuide(h) {
    const el = this._bgEl || (this._bgEl = {
      box: $('#brake-guide'), pred: $('#bg-pred'), txt: $('#bg-txt'),
      lo: document.querySelector('#brake-guide .bg-lbl-over'), ls: document.querySelector('#brake-guide .bg-lbl-short'),
    });
    const sim = this.sim;
    let show = this.settings.guide && h.next && !h.doorOpen && h.next.dist < 650 && h.next.dist > -15 && sim.v > 0.5 && !this._overrun;
    let c = null;
    if (show) {
      c = this._brakeCalc(h);
      show = sim.notch < 0 || this._limitAhead(h) || this._toBrake(h, c) < 120;
    }
    setHidden(el.box, !show);
    if (!show) return;
    const pred = c.pred;
    let txt, cls = '', act = 0;
    if (this._limitAhead(h)) {
      /* 手前の制限に合わせて減速中: 駅の予想は まだ出さない(CLAUDE.md: ATSの先行パターンの理由表示) */
      if (el.pred._d !== 'none') { el.pred._d = 'none'; el.pred.style.display = 'none'; }
      txt = `このさき<br><b>${Math.round(h.ats.target)}</b> まで`;
    } else if (pred == null) {
      if (el.pred._d !== 'none') { el.pred._d = 'none'; el.pred.style.display = 'none'; }
      const toBrake = this._toBrake(h, c);
      txt = toBrake > 0 ? `ブレーキまで<br><b>${this._steady('toBrake', toBrake)}m</b>` : '<b>ブレーキ</b>を<br>かけよう';
      if (toBrake <= 0) cls = 'over';
    } else {
      const d = pred - h.next.dist;     // +: いきすぎ / -: てまえ
      const k = Math.sign(d) * Math.min(1, Math.sqrt(Math.abs(d) / 40));
      if (el.pred._d !== 'block') { el.pred._d = 'block'; el.pred.style.display = 'block'; }
      const ty = `translateY(${(50 - k * 50).toFixed(1)}%)`;
      if (el.pred._ty !== ty) { el.pred._ty = ty; el.pred.style.transform = ty; }
      const ok = Math.abs(d) <= 1.0;
      cls = ok ? 'ok' : d > 0 ? 'over' : '';
      setCls(el.pred, 'bg-pred ' + cls);
      /* ことば(いきすぎ/てまえ)は めもりの はしの ラベルを 光らせて しめす。文は 数字だけ */
      txt = ok ? '<b>ぴったり</b>' : `<b>${this._steady('pred', Math.abs(d))}</b>m`;
      act = ok ? 0 : d > 0 ? 1 : -1;
    }
    setHtml(el.txt, txt);
    setCls(el.txt, 'bg-txt ' + cls);
    if (el.lo) setCls(el.lo, 'bg-lbl bg-lbl-over' + (act > 0 ? ' act' : ''));
    if (el.ls) setCls(el.ls, 'bg-lbl bg-lbl-short' + (act < 0 ? ' act' : ''));
  },

  /* 「いまやること」コーチ(小2でもわかる次の一手を常に出す。まちがえる前に知らせる)。
   * want = その文で つかってほしい ノッチ(運転台の めもりと すすむ/ブレーキ ボタンを 光らせる) */
  _updateCoach(h) {
    const el = this._coachEl || (this._coachEl = $('#coach'));
    const sim = this.sim;
    if (!h) h = sim.hud();
    const KUP = this.KUP || '<b>▲</b>', KDN = this.KDN || '<b>▼</b>';
    let txt = '', hot = false, want = null;
    const redAhead = h.ats && h.ats.kind === 'signal' && h.ats.target === 0;
    const redNear = redAhead && h.ats.at - sim.pos < 150;
    const wet = this.weather === 'rain' || this.weather === 'snow';
    /* スピード オーバーの チャイムは こえた ときに 1回だけ(制限より おそくなったら また鳴る) */
    if (sim.v > h.limit + 0.5) {
      if (!this._overChimed && !h.doorOpen) { this._overChimed = true; this._cue('atsChime', 0.3); }
    } else if (sim.v < h.limit) this._overChimed = false;
    if (this._overrun) {
      txt = '<b>やりなおす</b> を タップしてね';
    } else if (h.finished) {
      txt = '';
    } else if (h.doorOpen) {
      const rest = Math.ceil((h.next ? h.next.dep : sim._departTime) - sim.t);
      txt = rest > 0 ? `おきゃくさんが のりおり中… しゅっぱつまで あと <b>${Math.max(0, rest)}</b> びょう`
        : 'まもなく ドアが しまります';
    } else if (sim.v < 0.5 && sim._left && h.next && h.next.dist > 0.5 && h.next.dist < 250 && !redNear) {
      /* 「8」の手前で止まってしまった: すこし進んで もういちど止まる */
      txt = `「8」まで あと <b>${Math.round(h.next.dist)}</b> m。${KUP}を 1かい → うごいたら ${KDN}で とまろう`;
      const st = h.settle || 0;   // 少し手前で止まったときの まちじかん(エンジンに あるときだけ)
      if (st > 0) txt += `（あと <b>${Math.ceil(st)}</b> びょうで ドアが あくよ）`;
      want = 1;
    } else if (sim.v < 0.5 && sim.notch <= 0 && !redNear) {
      txt = `${KUP} を おして しゅっぱつ！`;
      want = wet ? 2 : 4;
    } else if (h.atsLamp === 'brake') {
      /* じどうブレーキが はなれる速さ(engine の照査と同じ: パターン-5 かつ いまの制限+3 いか。2秒は かかったまま) */
      const rel = Math.min(h.ats ? h.ats.pattern - 5 : 999, h.limit + 3);
      const tgt = Math.max(0, Math.floor(rel / 5) * 5);
      txt = sim.v > tgt + 1
        ? `${icon('warn')} じどうブレーキ中… スピードが <b>${tgt}</b> まで さがるのを まとう`
        : `${icon('warn')} じどうブレーキ中… もうすぐ ゆるむよ`;
    } else if (h.slipping) {
      txt = `すべってる！ ${KUP}で ブレーキを すこし よわく`;
      want = Math.min(-1, sim.notch + 1);
    } else if (redAhead && (h.ats.at - sim.pos) < 700) {
      if (sim.v < 0.5) txt = '<i class="sig sig-r"></i>しんごうが <b>あか</b>。あおに かわるまで まとう';
      else { txt = `<i class="sig sig-r"></i>しんごうが <b>あか</b>！ ${KDN}で とまろう`; want = -6; }
    } else if (h.ats && h.ats.kind === 'limit' && sim.v > h.ats.pattern - 4 && h.ats.target < h.limit) {
      /* 「いまの制限は守っているのに」の混乱に、理由(この先の低い制限)を示す。
       * 先行パターンの じどうブレーキの 理由なので「もうすぐ ◯◯」「スピード オーバー」より 先に出す */
      const m = this._steady('limAt', Math.max(0, h.ats.at - sim.pos));
      txt = `${icon('warn')} このさきは <b>${Math.round(h.ats.target)}</b> まで。いまから おとそう（あと <b>${m}</b> m）`;
      want = -3;
    } else if (sim.v > h.limit + 0.5) {
      /* だ行(ノッチ N や よわい ブレーキ)の まま 制限を こえた: じどうブレーキの まえに 知らせる */
      txt = `${icon('warn')} スピード オーバー！ <b>${h.limit}</b> より おそく → ${KDN}`;
      hot = true;
      want = Math.min(sim.notch, -2);
    } else if (sim.notch > 0 && sim.v > h.limit - 8) {
      /* じどうブレーキが かかる まえに 知らせる */
      txt = `もうすぐ <b>${h.limit}</b>！ ${KDN}で <b>N</b>に もどそう`;
      want = 0;
    } else if (h.ats && h.ats.kind === 'signal' && (h.ats.at - sim.pos) < 700 && sim.v > h.ats.target - 3) {
      txt = `<i class="sig sig-y"></i>しんごうが <b>きいろ</b>。スピードを <b>${Math.round(h.ats.target)}</b> まで おとそう`;
      want = -3;
    } else if (this._limitAhead(h)) {
      /* 駅より手前に 低い制限がある: まずは そちらに合わせる(駅の予想を出すと まぎらわしい) */
      const m = this._steady('limAt', Math.max(0, h.ats.at - sim.pos));
      txt = `このさきは <b>${Math.round(h.ats.target)}</b> まで。${KDN}で おとそう（あと <b>${m}</b> m）`;
      want = -3;
    } else if (h.next && h.next.dist < 650) {
      /* 駅に近づいた(ブレーキめやすと おなじ 650m から): ブレーキを かける場所と、止まる場所の予想 */
      const c = this._brakeCalc(h);
      const dist = h.next.dist;
      if (sim.notch >= 0) {
        const toBrake = this._toBrake(h, c);
        if (toBrake > 40) txt = `ブレーキまで あと <b>${this._steady('toBrake', toBrake)}</b> m`;
        else if (toBrake > 0) { txt = `そろそろ！ ${KDN}を 3〜4かい`; want = -4; }
        else { txt = `いま！ ${KDN}`; hot = true; want = -4; }
      } else if (c.pred == null) {
        txt = `このままだと とまれない → ${KDN} もっと`;
        want = Math.max(-7, sim.notch - 1);
      } else {
        const d = c.pred - dist;
        if (Math.abs(d) <= 1) { txt = 'そのまま！ ぴったり とまるよ'; want = sim.notch; }
        else if (d > 1) {
          txt = `このままだと <b>いきすぎ</b>（${this._steady('pred', d)}m）→ ${KDN} もっと`;
          want = Math.max(-7, sim.notch - 1);
        } else {
          txt = `このままだと <b>てまえ</b>で とまる（${this._steady('pred', -d)}m）→ ${KUP} で ブレーキを よわく`;
          want = Math.min(-1, sim.notch + 1);
        }
      }
    } else if (h.ats && sim.v > h.ats.pattern - 4) {
      txt = `${icon('warn')} スピードを <b>${Math.round(h.ats.target)}</b> まで おとそう`;
      want = -3;
    } else if (h.next) {
      txt = `つぎは <b>${kanaOf(h.next.name) || h.next.name}</b> ／ スピードは <b>${h.limit}</b> まで`;
    }
    if (txt !== this._coachTxt) {
      this._coachTxt = txt;
      el.innerHTML = txt;
      setHidden(el, !txt);
    }
    if (el._hot !== hot) { el._hot = hot; el.classList.toggle('coach-hot', hot); }

    /* つかってほしい ノッチを 運転台(P4: cab.setTarget)と すすむ/ブレーキ ボタンで しめす(ガイド「あり」のときだけ) */
    const w = this.settings.guide ? want : null;
    if (w !== this._want) {
      this._want = w;
      if (this.cab && typeof this.cab.setTarget === 'function') { try { this.cab.setTarget(w); } catch (e) { /* noop */ } }
    }
    const wdir = w == null ? '' : w > sim.notch ? 'up' : w < sim.notch ? 'dn' : '';
    if (wdir !== this._wantDir) {
      this._wantDir = wdir;
      if (!this._tbUp) { this._tbUp = $('#tb-up'); this._tbDn = $('#tb-dn'); }
      this._tbUp.classList.toggle('want', wdir === 'up');
      this._tbDn.classList.toggle('want', wdir === 'dn');
    }

    /* 大型HUD(じそく・せいげん・のこりm/あと秒) */
    if (!this._bh) {
      this._bh = {
        v: $('#bh-v'), cap: $('#bh-ctx-cap'), num: $('#bh-ctx-num'),
        unit: $('#bh-ctx-unit'), row: document.querySelector('.bh-ctx'),
        lim: $('#bh-lim'), limN: $('#bh-lim-next'), skip: $('#btn-skip'), card: $('#stop-card'),
      };
    }
    const B = this._bh;
    setText(B.v, String(Math.floor(sim.v)));   // 速度計の数字(切り捨て)とそろえる
    setCls(B.v, sim.v > h.limit + 1 ? 'over' : sim.v > h.limit - 5 ? 'near' : '');
    setText(B.lim, String(h.limit));
    let ln = '';
    if (h.ats && h.ats.kind === 'limit' && h.ats.target < h.limit && h.ats.at - sim.pos < 700) ln = '→' + Math.round(h.ats.target);
    else if (h.ats && h.ats.kind === 'signal' && h.ats.at - sim.pos < 700) {
      /* 信号の ランプには ことばを そえる(赤い丸だけでは 小2には わからない) */
      ln = h.ats.target === 0 ? '<i class="sig sig-r"></i>とまれ' : `<i class="sig sig-y"></i>${Math.round(h.ats.target)}`;
    }
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

    /* しゅっぱつスキップボタン(まだ待ち時間があるときだけ)。
     * とうちゃくの お祝い(判定カード・3.4秒)の あいだは 出さない(お祝いを タップして とばしてしまう) */
    const celebrating = performance.now() <= (this._celebrateUntil || 0) || !B.card.classList.contains('hidden');
    const canSkip = !celebrating && !this._overrun && h.doorOpen && ((h.next ? h.next.dep : sim._departTime) - sim.t) > 7;
    setHidden(B.skip, !canSkip);
    if (canSkip) {
      /* コーチが 2〜4行に のびても(せまい たて画面) ボタンが かくれないよう、コーチの すぐ上に おく。
       * #coach と #btn-skip は おなじ #gl-wrap の中(offsetTop は transform を むしする)。
       * CSSの bottom(画面サイズ別)より 下には さげない。
       * レイアウトを読むのは ドアが あいていて、コーチの 文が かわったときだけ(毎フレームは 読まない) */
      if (B.skip._base == null) {
        B.skip.style.bottom = ''; B.skip._b = null; B.skip._for = undefined;
        B.skip._base = parseFloat(getComputedStyle(B.skip).bottom) || 66;
      }
      if (B.skip._for !== this._coachTxt) {
        B.skip._for = this._coachTxt;
        const par = el.offsetParent;
        const need = el.classList.contains('hidden') || !par ? 0 : Math.round(par.clientHeight - el.offsetTop + 8);
        const b = Math.max(B.skip._base, need);
        if (B.skip._b !== b) { B.skip._b = b; B.skip.style.bottom = b + 'px'; }
      }
    } else B.skip._base = null;
    this._updateBrakeGuide(h);
    this._updateRouteStrip();
  },

  retryStation() {
    this._retried = true;   // とちゅうからやり直した運転はベスト記録に残さない
    this.sim.reset(this.lastStationIdx);
    this.scene._camPos = null;
    this.setPaused(false);
    this._setOverrun(false);
    this._celebrateUntil = 0;
    if (this.scene.traffic) this.scene.traffic.reset(this.sim);
    this._clearPops();
    this.runStreak = 0;   // やりなおしたら「れんぞく」も 0から
    this._resetCoachState();
    if (this._rs) this._rs.idx = null;
    this._renderMarks();   // sim.reset で きろくも 0 に もどる
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
    /* しゅうてんの おわりの 儀式: ドアが あいて「おつかれさまでした」。
     * 判定カードと スタンプ(順番待ちの列)の あとに そらからの 景色 → 0.4秒の 暗転で 成績票へ */
    this._cue('hissLong', 0.24, 0.92);
    this._cue('doorSlide', 0.5);
    if (this.announcer) this.announcer.speak('しゅうてん、' + (kanaOf(to) || to) + 'です。おつかれさまでした。');
    const best = { prevSeg, segBest, retried: this._retried };
    this._queuePop(() => { if (this.mode === 'drive' && this.sim === sim) this._setCam('drone'); }, 2400);
    this._queuePop(async () => {
      if (this.mode !== 'drive' || this.sim !== sim) return;
      const f = $('#fade');
      f.classList.add('on');
      await new Promise((r) => setTimeout(r, 400));
      if (this.mode !== 'drive' || this.sim !== sim) { if (!this._starting) f.classList.remove('on'); return; }
      this._clearPops();
      this._showResult(res, best);
      f.classList.remove('on');
    }, 0);
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
      ['のりごこち', bd.ride, 15, res.jerkEvents > 0 ? `ガクン ${res.jerkEvents}かい（レバーを いっきに うごかした）` : 'ガクン 0かい'],
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
      nb.innerHTML = `つづきを はしる ${icon('chevron-right')}<small>${rubyStation(stops[this.endIdx].name)} → ${rubyStation(stops[nTo].name)}</small>`;
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
    const fadeEl = $('#fade');
    const step = () => {
      /* 成績票を はなれたら(もういちど・つづき・えらびなおす) ピッ や スタンプの音を とめる */
      if (this.mode !== 'result' || fadeEl.classList.contains('on')) return;
      const k = Math.min(1, (performance.now() - t0) / 1100);
      const v = Math.round(res.total * (1 - Math.pow(1 - k, 3)));
      tot.textContent = v;
      const ten = Math.floor(v / 10);
      if (ten > lastTen) { lastTen = ten; this._cue('tick', 0.14, 1 + ten * 0.05); }   // 点が ふえるほど 音が たかくなる
      if (k < 1) requestAnimationFrame(step);
      else {
        rk.classList.add('pop');
        this._cue('stampPress', 0.55);
        if (res.rank === 'S' || res.rank === 'A') this._cue('stopPerfect', 0.3);
      }
    };
    requestAnimationFrame(step);
    setTimeout(() => document.querySelectorAll('.rb-bar i').forEach((i) => { i.style.transform = `scaleX(${i.dataset.w})`; }), 1300);
  },

  /* 成績票の「つづきを はしる」: 同じ駅数だけ先へ */
  _continueRun() {
    /* 出発の フェード中は むし(区間を うごかす まえに みる。2かい おすと 1区間 とばしてしまう) */
    if (this._starting || this.endIdx == null) return;
    const n = this._svcStops().length;
    const span = this.endIdx - this.startIdx;
    this.startIdx = this.endIdx;
    this.endIdx = Math.min(n - 1, this.startIdx + span);
    if (this.endIdx >= n - 1) this.endIdx = null;
    this.startDrive(true);
  },

  /* ================= ループ ================= */
  _render(dt) { this._rc = (this._rc || 0) + 1; this.scene.render(dt); },

  loop() {
    requestAnimationFrame(() => this.loop());
    const now = performance.now();
    const dt = Math.min(0.1, (now - (this._lastT || now)) / 1000);
    this._lastT = now;
    if (!this.scene) return;
    const m = this.mode;
    let busy = false;
    if (m === 'drive') {
      if (!this.sim || !this.running && !this.sim.ended) { this._render(0); return; }
      if (this.running && !this.paused) {
        const mult = this._fast || 1;
        for (let i = 0; i < mult && this.running; i++) {
          if (this._auto) this._auto();
          this.sim.tick(dt);
        }
        if (this.audio) this.audio.update(this.sim, dt, this.scene.audioEnv());
        if (this.rainGlass) this.rainGlass.render(dt, this.sim.v, this.scene.cockpit, this.scene._inTunnelNow);
      }
      if (!this.paused) this._render(dt);
      else {
        /* ポーズ中は 止まった絵なので、入ったときと 画面の大きさが かわったときに 1回だけ描く */
        busy = true;
        if (this._pauseDirty) { this._pauseDirty = false; this._render(0); }
      }
      const h = this.sim.hud();   // 1フレームに1回だけ計算して計器とHUDで使う
      if (typeof this.cab.setLight === 'function' && this.scene.cockpit) this.cab.setLight(this.scene.cockpit.light);
      this.cab.render(h);
      this._updateCoach(h);
    } else if (m === 'title') {
      /* タイトルは 3Dが 主役なので 毎フレーム */
      if (!document.hidden) {
        this._attractTick(dt);
        this._render(dt);
      }
    } else if (m === 'result' || m === 'select' || m === 'stamps') {
      /* ほぼ不透明な画面の うしろ: デモ走行は 毎フレーム すすめ、3Dは 3フレームに1回(約20fps)だけ 描く */
      busy = true;
      if (!document.hidden) {
        if (m !== 'result') this._attractTick(dt);
        this._ovAcc = (this._ovAcc || 0) + dt;
        this._ovN = ((this._ovN || 0) + 1) % 3;
        if (this._ovN === 0) { this._render(Math.min(0.1, this._ovAcc)); this._ovAcc = 0; }
      }
    }
    /* fpsが持続的に低ければ自動で描画負荷を下げる(間引いて描く画面・ポーズ中は はからない) */
    if (typeof this.scene.autoQualityTick === 'function') {
      if (!this._fast && !this.debug) {
        const fadeOn = (this._fadeEl || (this._fadeEl = $('#fade'))).classList.contains('on');
        this.scene.autoQualityTick(dt, { busy: busy || fadeOn || now - (this._runT0 || 0) < 5000 });
      }
    } else if (!busy) {
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
      /* 3Dを描いた回数(メニューの うしろが 約20回/秒に なっているかの 確認用) */
      renders: () => this._rc || 0,
      /* 撮影・確認用: 「8」を m メートル すぎた ところで 止まった ことにする(大オーバーランの パネルを出す) */
      overrun: (m = 15.2) => {
        const sim = this.sim, st = sim.stops[sim.stopIdx];
        if (!st) return null;
        sim.pos = st.stopAt + m; sim.v = 0; sim._left = true; sim.setNotch(-8);
        sim.tick(0.05);
        if (this.scene) this.scene._camPos = null;
        return { overrun: !!this._overrun, err: Math.round((sim.pos - st.stopAt) * 10) / 10 };
      },
      /* 描画せずにシミュレーションだけ sec 秒すすめる(自動運転)。撮影位置まで一気に動かす用 */
      advance: (sec) => {
        const sim = this.sim, ap = makeAutopilot(sim);
        for (let t = 0; t < sec && !sim.ended; t += 0.05) { if (sim.doorOpen) sim.skipDwell(); ap(); sim.tick(0.05); }
        if (this.scene) this.scene._camPos = null;
        return { pos: Math.round(sim.pos), v: Math.round(sim.v), next: sim.stops[sim.stopIdx] && sim.stops[sim.stopIdx].name };
      },
      /* 自動運転で 次の駅に止まるまで進める(描画を待たない。停止判定カードが出る) */
      arrive: () => {
        const sim = this.sim, ap = makeAutopilot(sim);
        for (let i = 0; i < 40000 && !sim.doorOpen && !sim.ended; i++) { ap(); sim.tick(0.05); }
        if (this.scene) this.scene._camPos = null;
        clearTimeout(this._scT);   // 撮影用: 判定カードを消さずに残す(ソフト描画は撮影までが遅い)
        const st = sim.score.stops[sim.score.stops.length - 1];
        return st ? { name: st.name, err: st.err } : null;
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
