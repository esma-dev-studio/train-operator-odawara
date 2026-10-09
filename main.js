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

/* 種別名のふりがな */
const SVC_KANA = { '各駅停車': 'かくえきていしゃ', '急行': 'きゅうこう', '快速急行': 'かいそくきゅうこう' };
const SVC_COLOR = { local: '#8fa0aa', exp: '#ff6b3d', rapid: '#3fb0ff' };
const rubySvc = (name) => SVC_KANA[name] ? `<ruby>${name}<rt>${SVC_KANA[name]}</rt></ruby>` : name;
const CAM_MODES = ['cab', 'chase', 'side', 'front', 'drone'];
const CAM_NAME = { cab: 'うんてんせき', chase: 'うしろから', side: 'よこから', front: 'せんろわきから', drone: 'そらから' };

const $ = (s) => document.querySelector(s);
const SAVE_KEY = 'trainop_v2';
const SET_KEY = 'trainop_settings';
const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()));
const store = {
  get(k, def) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : def; } catch (e) { return def; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* 保存できなくても続行 */ } },
};

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
    this.loadSave();
    this.settings = Object.assign({ volume: 0.8, voice: true, guide: true, quality: null }, store.get(SET_KEY, {}));
    const touch = matchMedia('(pointer: coarse)').matches;
    const qp = (location.search.match(/[?&]q=(high|mid|low)/) || [])[1];   // 検証用の画質指定
    this.quality = qp || this.settings.quality || (touch ? 'mid' : 'high');
    this.bindUI();
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
      });
      this.scene.guide = this.settings.guide;
    } catch (err) {
      this.setLoad(1, '3Dが ひょうじできませんでした。ブラウザを さいしんに してね。(' + (err && err.message ? err.message : err) + ')');
      return;
    }
    this.cab = new Cab(this.attract.sim);
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

  loadSave() {
    this.save = Object.assign({ best: {}, stamps: {}, badges: {}, runs: 0, perfect: 0, cams: {} }, store.get(SAVE_KEY, {}));
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
    const txt = `LIVE ・ ${SERVICES.exp.name} ${nx ? kanaOf(nx.name) + ' ゆき' : ''} ・ ${CAM_NAME[this.scene.camMode] || ''}`;
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
    $('#dir-seg').querySelectorAll('button').forEach((b) => {
      b.addEventListener('click', () => {
        this.direction = b.dataset.dir;
        $('#dir-seg').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
        this.line = prepareLine(this.rawLine, this.direction);
        this.startIdx = 0; this.endIdx = null; this._pick = 'start';
        this.renderSvcCards(); this.renderRoute();
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
      this.endIdx = Math.min(n - 1, this.startIdx + 2);
      this._pick = 'start'; this.renderRoute();
    });
    $('#rq-half').addEventListener('click', () => {
      const n = this._svcStops().length;
      this.endIdx = Math.min(n - 1, this.startIdx + Math.max(2, Math.ceil((n - 1) / 2)));
      this._pick = 'start'; this.renderRoute();
    });
    $('#rq-all').addEventListener('click', () => { this.startIdx = 0; this.endIdx = null; this._pick = 'start'; this.renderRoute(); });
    this._pick = 'start';
    this.renderSvcCards();
    this.renderRoute();
  },

  _svcStops() {
    const svc = SERVICES[this.service];
    return this.line.stations.filter((st) => !svc.stops || svc.stops.includes(st.name));
  },
  _ttKey() { return this.service + (this.direction === 'up' ? '_up' : ''); },

  renderSvcCards() {
    const wrap = $('#svc-list');
    const durOf = (key) => {
      const t = this.timetable[key + (this.direction === 'up' ? '_up' : '')];
      return t ? Math.round(t[t.length - 1][0] / 60) : '—';
    };
    wrap.innerHTML = Object.entries(SERVICES).map(([key, s]) => {
      const stops = s.stops ? s.stops.length : this.line.stations.length;
      const best = ['clear', 'rain', 'snow'].map((w) => this.save.best[`${key}_${this.direction}_${w}`]).filter(Boolean)
        .sort((a, b) => b.total - a.total)[0];
      return `<button class="svc-card${key === this.service ? ' sel' : ''}" data-svc="${key}">
        <span class="svc-band" style="background:${SVC_COLOR[key]}"></span>
        <span class="svc-name">${rubySvc(s.name)}</span>
        <span class="svc-meta">とまる<ruby>駅<rt>えき</rt></ruby> ${stops} ／ ぜんぶで ${durOf(key)}ぷん</span>
        <span class="svc-best">${best ? `ベスト ${best.total}てん (${best.rank})` : 'まだ きろくなし'}</span>
      </button>`;
    }).join('');
    wrap.querySelectorAll('.svc-card').forEach((b) => {
      b.addEventListener('click', () => {
        this.service = b.dataset.svc;
        this.startIdx = 0; this.endIdx = null; this._pick = 'start';
        this.renderSvcCards();
        this.renderRoute();
      });
    });
  },

  renderRoute() {
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
      const got = this.save.stamps[st.name];
      const stampMark = got ? `<span class="rt-stamp" style="border-color:${stampColor(st.name)}" title="スタンプ"></span>` : '';
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
      ? '① スタートの<ruby>駅<rt>えき</rt></ruby>を タップ → ② ゴールの<ruby>駅<rt>えき</rt></ruby>を タップ'
      : '② こんどは ゴールの<ruby>駅<rt>えき</rt></ruby>を タップしてね';
    this.renderSummary();
  },

  renderSummary() {
    const stops = this._svcStops();
    const n = stops.length;
    const end = this.endIdx == null ? n - 1 : this.endIdx;
    const tt = this.timetable[this._ttKey()];
    const min = tt ? Math.max(1, Math.round((tt[end][0] - tt[this.startIdx][1]) / 60)) : '—';
    const nStop = end - this.startIdx;
    const tod = { day: 'ひる', evening: 'ゆうがた', night: 'よる' }[this.daytime];
    const wx = { clear: 'はれ', rain: 'あめ', snow: 'ゆき' }[this.weather];
    $('#sel-summary').innerHTML = `<b>${rubyStation(stops[this.startIdx].name)} → ${rubyStation(stops[end].name)}</b><br>
      ${rubySvc(SERVICES[this.service].name)} ・ とまる<ruby>駅<rt>えき</rt></ruby> <b>${nStop}</b> ・ やく <span class="sum-time">${min}ぷん</span> ・ ${tod} ・ ${wx}`;
  },

  /* ================= えきスタンプ ================= */
  updateStampCount() {
    const n = Object.keys(this.save.stamps).length;
    $('#stamp-count').textContent = `${n}/23`;
  },

  buildStampBook() {
    const names = prepareLine(this.rawLine, 'down').stations.map((s) => s.name);
    const grid = $('#stamps-grid');
    grid.innerHTML = '';
    let got = 0;
    names.forEach((name, i) => {
      const cnt = this.save.stamps[name] || 0;
      if (cnt) got++;
      const cell = document.createElement('div');
      cell.className = 'stamp-cell' + (cnt ? '' : ' no');
      const cv = document.createElement('canvas');
      drawStamp(cv, name, { got: !!cnt, size: 112, seed: i });
      cell.appendChild(cv);
      const nm = document.createElement('div');
      nm.className = 'sc-name';
      nm.textContent = cnt ? name : '？？？';
      const ct = document.createElement('div');
      ct.className = 'sc-cnt';
      ct.textContent = cnt ? `ぴったり ${cnt}かい` : 'まだ';
      cell.append(nm, ct);
      grid.appendChild(cell);
    });
    $('#stamps-count').textContent = `${got} / ${names.length}`;
    const bg = $('#badges-grid');
    let nb = 0;
    bg.innerHTML = BADGES.map((b) => {
      const has = !!this.save.badges[b.id];
      if (has) nb++;
      return `<div class="badge${has ? '' : ' no'}"><span class="bd-ico">${has ? b.icon : '？'}</span>
        <span><div class="bd-name">${b.name}</div><div class="bd-desc">${b.desc}</div></span></div>`;
    }).join('');
    $('#badges-count').textContent = `${nb} / ${BADGES.length}`;
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
        if (key === 'quality') this._qualityDirty = v !== this.quality;
        store.set(SET_KEY, S);
      }));
    });
    $('#set-reset').addEventListener('click', () => {
      if (!confirm('きろくと スタンプを ぜんぶ けしますか？')) return;
      this.save = { best: {}, stamps: {}, badges: {}, runs: 0, perfect: 0, cams: {}, _migrated: true };
      this.writeSave();
      this.updateStampCount();
      this.renderSvcCards(); this.renderRoute();
    });
    $('#screen-settings').classList.add('active');
  },

  applyVolume() {
    if (!this.audio) return;
    if (this.audio.setVolume) this.audio.setVolume(this.settings.volume);
    else if (this.audio.master) this.audio.master.gain.value = this.settings.volume;
  },

  /* 画質の変更はステージを作り直す(タイトルに戻ったとき) */
  _rebuildScene() {
    this._qualityDirty = false;
    this.quality = this.settings.quality || this.quality;
    try { this.scene.renderer.dispose(); } catch (e) { /* noop */ }
    const A = this.attract;
    this.scene = new RailScene($('#gl'), A.line, A.sim, { quality: this.quality, timeOfDay: A.tod, weather: 'clear' });
    this.scene.guide = this.settings.guide;
    this.resizeGL();
  },

  /* ================= 入力 ================= */
  bindUI() {
    $('#btn-start').addEventListener('click', () => this.startDrive());
    $('#btn-to-select').addEventListener('click', () => { this._unlockAudio(); this.renderSvcCards(); this.renderRoute(); this.go('select'); });
    $('#btn-to-stamps').addEventListener('click', () => this.go('stamps'));
    $('#btn-stamps-back').addEventListener('click', () => this.go('title'));
    $('#btn-to-settings').addEventListener('click', () => this.openSettings());
    $('#btn-set-close').addEventListener('click', () => {
      $('#screen-settings').classList.remove('active');
      if (this._qualityDirty && this.mode !== 'drive' && this.mode !== 'result') this._rebuildScene();
    });
    $('#btn-back-title').addEventListener('click', () => this.go('title'));
    $('#btn-pause-resume').addEventListener('click', () => this.setPaused(false));
    $('#btn-pause-retry').addEventListener('click', () => this.retryStation());
    $('#btn-pause-settings').addEventListener('click', () => this.openSettings());
    $('#btn-pause-quit').addEventListener('click', () => this.quitDrive());
    $('#btn-res-retry').addEventListener('click', () => this.startDrive(true));
    $('#btn-res-select').addEventListener('click', () => { this.renderSvcCards(); this.renderRoute(); this.go('select'); });
    $('#btn-overrun-retry').addEventListener('click', () => { $('#overrun-modal').classList.add('hidden'); this.retryStation(); });
    $('#btn-cam').addEventListener('click', () => this.cycleCam());

    /* タッチ用ボタン(すすむ/ブレーキ/けいてき/ポーズ)
     * ▲▼はレバーを1段ずつ動かすのと同じ。押したらレバーの持ち手を光らせて関係を見せる */
    const flashGrip = () => {
      const g = $('#lever-grip');
      g.classList.add('tb-flash');
      clearTimeout(this._gripFlashT);
      this._gripFlashT = setTimeout(() => g.classList.remove('tb-flash'), 320);
    };
    const canOp = () => this.mode === 'drive' && this.running && !this.paused;
    $('#tb-up').addEventListener('click', () => { if (canOp()) { this.sim.setNotch(Math.min(4, this.sim.notch + 1)); flashGrip(); } });
    $('#tb-dn').addEventListener('click', () => { if (canOp()) { this.sim.setNotch(Math.max(-8, this.sim.notch - 1)); flashGrip(); } });
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

    /* タッチ: 画面右のレバー(上=P4 … 下=EB の13段) */
    const lever = $('#lever');
    let dragging = false;
    const leverNotch = (clientY) => {
      if (!canOp()) return;
      const r = lever.getBoundingClientRect();
      const k = Math.min(1, Math.max(0, (clientY - r.top) / r.height));
      const idx = Math.round(k * 12);
      this.sim.setNotch(Math.max(-8, Math.min(4, 4 - idx)));
    };
    lever.addEventListener('pointerdown', (ev) => { dragging = true; lever.setPointerCapture(ev.pointerId); leverNotch(ev.clientY); });
    lever.addEventListener('pointermove', (ev) => { if (dragging) leverNotch(ev.clientY); });
    lever.addEventListener('pointerup', () => { dragging = false; });

    /* ノッチ表示列(P4〜EB)も直接さわって操作できるようにする
     * (子どもはレバーよりこちらを触りがち、という実プレイの声から) */
    const nlist = $('#notch-list');
    const notchFromPoint = (x, y) => {
      if (!canOp()) return;
      const el = document.elementFromPoint(x, y);
      if (el && el.classList && el.classList.contains('nt')) {
        const n = Number(el.dataset.n);
        if (!Number.isNaN(n)) this.sim.setNotch(n);
      }
    };
    let ndrag = false;
    nlist.addEventListener('pointerdown', (ev) => {
      ndrag = true;
      try { nlist.setPointerCapture(ev.pointerId); } catch (e) { /* 合成イベント等 */ }
      notchFromPoint(ev.clientX, ev.clientY);
    });
    nlist.addEventListener('pointermove', (ev) => { if (ndrag) notchFromPoint(ev.clientX, ev.clientY); });
    nlist.addEventListener('pointerup', () => { ndrag = false; });

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
    lab.textContent = 'してん: ' + CAM_NAME[CAM_MODES[this.camIdx]];
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
    this.scene.setWorld(this.line, this.sim);
    this.scene.setTimeOfDay(this.daytime);
    this.scene.setWeather(this.weather);
    this.scene.guide = this.settings.guide;
    this.camIdx = 0;
    this._setCam('cab');
    this.cab.sim = this.sim;
    this.cab.baseHour = this.daytime === 'night' ? 19 : this.daytime === 'evening' ? 16 : 10;
    this.cab._nextName = null;
    if (this.audio) {
      this.audio.ensure();
      this.audio.bind(this.sim);
    }
    this.sim.onEvent((type, e) => this.onSimEvent(type, e));
    const dest = this.sim.stops[this.sim.stops.length - 1].name;
    $('#drive-head-svc').innerHTML = rubySvc(SERVICES[this.service].name) + '　' + rubyStation(dest) + ' いき';
    this._buildRouteStrip();
    this._coachTxt = null; this._rsIdx = null;
    $('#msg-center').classList.add('hidden');
    $('#overrun-modal').classList.add('hidden');
    $('#stamp-pop').classList.add('hidden');
    this.setPaused(false);
    this.running = true;
    this.resizeGL();
  },

  onSimEvent(type, e) {
    const A = this.announcer;
    if (type === 'arrived') {
      this.lastStationIdx = this.sim.stopIdx - 1;
      const last = this.sim.score.stops[this.sim.score.stops.length - 1];
      const abs = Math.abs(last.err);
      const grade = abs <= 0.35 ? '◎ みごと！' : abs <= 1 ? '○ いいね' : abs <= 2 ? '△ おしい' : '× ざんねん';
      const lateTxt = last.late > 3 ? `／ ${last.late}びょう おくれ` : last.early > 30 ? '／ はやすぎ' : '／ じかん ぴったり';
      this.flashMsg(`${rubyStation(e.name)} にとうちゃく　ずれ ${last.err > 0 ? '+' : ''}${last.err.toFixed(2)}m ${grade} ${lateTxt}`);
      if (abs <= 0.35) this.awardStamp(e.name);
    }
    if (type === 'door-closed') this.flashMsg('ドアがしまりました ── <ruby>出発進行<rt>しゅっぱつしんこう</rt></ruby>！', 1800);
    if (type === 'overrun') this.flashMsg('⚠ いきすぎ！ とまるところを すぎています', 2600, true);
    if (type === 'overrun-stop') $('#overrun-modal').classList.remove('hidden');
    if (type === 'ats-brake') {
      const a = this.sim.hud().ats;
      const why = a && a.kind === 'limit' ? `（このさき ${Math.round(a.target)} のため）` : '';
      this.flashMsg(`⚠ スピードの出しすぎ！ じどうブレーキが かかりました${why}`, 2400, true);
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
    if (type === 'melody' && this.audio && this.audio.playMelody) this.audio.playMelody(e.seed);
    if (type === 'finished') this.finishRun(e);
  },

  /* くんしょう: 新しくもらえたらトーストで知らせる */
  grantBadge(id) {
    if (this.save.badges[id]) return;
    const b = badgeById(id);
    if (!b) return;
    this.save.badges[id] = Date.now();
    this.writeSave();
    if (this.runBadges) this.runBadges.push(id);
    const t = $('#badge-toast');
    t.querySelector('.bt-ico').textContent = b.icon;
    t.querySelector('.bt-txt').textContent = `くんしょう ゲット！「${b.name}」`;
    t.classList.remove('hidden');
    t.style.animation = 'none'; void t.offsetWidth; t.style.animation = '';
    clearTimeout(this._badgeT);
    this._badgeT = setTimeout(() => t.classList.add('hidden'), 3200);
  },

  awardStamp(name) {
    const first = !this.save.stamps[name];
    this.save.stamps[name] = (this.save.stamps[name] || 0) + 1;
    this.save.perfect = (this.save.perfect || 0) + 1;
    this.writeSave();
    this.grantBadge('perfect');
    if (this.save.perfect >= 10) this.grantBadge('perfect10');
    if (this.save.perfect >= 30) this.grantBadge('perfect30');
    const kinds = Object.keys(this.save.stamps).length;
    if (kinds >= 10) this.grantBadge('stamp10');
    if (kinds >= 23) this.grantBadge('stampAll');
    if (!this.runStamps.includes(name)) this.runStamps.push(name);
    const pop = $('#stamp-pop');
    drawStamp($('#stamp-pop-cv'), name, { got: true, size: 150, seed: name.length });
    $('#stamp-pop-txt').innerHTML = first ? `${rubyStation(name)} の スタンプ ゲット！` : 'ぴったり！ スタンプ もういっこ';
    pop.classList.remove('hidden', 'go');
    void pop.offsetWidth;
    pop.classList.add('go');
    clearTimeout(this._stampT);
    this._stampT = setTimeout(() => pop.classList.add('hidden'), 2600);
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
    $('#screen-pause').classList.toggle('active', p);
    if (this.audio && this.audio.pause) this.audio.pause(p);
    if (p && this.announcer) this.announcer.cancel();
  },

  /* ================= 運転中HUD ================= */
  _buildRouteStrip() {
    const sim = this.sim;
    const a = sim.stops[sim.startIdx].stopAt, b = sim.stops[sim.stops.length - 1].stopAt;
    this._rs = { a, b };
    $('#rs-marks').innerHTML = sim.stops.slice(sim.startIdx).map((st, i, arr) =>
      `<i data-k="${sim.startIdx + i}" class="${i === 0 || i === arr.length - 1 ? 'end' : ''}" style="left:${((st.stopAt - a) / (b - a)) * 100}%"></i>`).join('');
  },

  _updateRouteStrip() {
    const sim = this.sim, R = this._rs;
    if (!R) return;
    const k = Math.max(0, Math.min(1, (sim.pos - R.a) / (R.b - R.a)));
    const left = `calc(${(k * 100).toFixed(1)}% + 11px)`;
    const t = this._rsTrain || (this._rsTrain = $('#rs-train'));
    if (t.style.left !== left) t.style.left = left;
    if (this._rsIdx !== sim.stopIdx) {
      this._rsIdx = sim.stopIdx;
      $('#rs-marks').querySelectorAll('i').forEach((el) => {
        const i = Number(el.dataset.k);
        el.classList.toggle('done', i < sim.stopIdx);
        el.classList.toggle('next', i === sim.stopIdx);
      });
    }
  },

  /* ブレーキめやす: このままのブレーキだと、どこで止まるか */
  _updateBrakeGuide(h) {
    const el = this._bgEl || (this._bgEl = { box: $('#brake-guide'), pred: $('#bg-pred'), txt: $('#bg-txt') });
    const sim = this.sim;
    const show = this.settings.guide && h.next && !h.doorOpen && h.next.dist < 650 && h.next.dist > -15 && sim.v > 0.5 && this.scene.camMode === 'cab';
    el.box.classList.toggle('hidden', !show);
    if (!show) return;
    const pred = sim.predictStop();
    let txt, cls = '';
    if (pred == null) {
      el.pred.style.display = 'none';
      txt = sim.notch > 0 ? 'ちかづいたら<br><b>ブレーキ</b>' : '<b>ブレーキ</b>を<br>かけてみよう';
    } else {
      const d = pred - h.next.dist;     // +: いきすぎ / -: てまえ
      const k = Math.sign(d) * Math.min(1, Math.sqrt(Math.abs(d) / 40));
      el.pred.style.display = 'block';
      el.pred.style.top = `${(50 - k * 50).toFixed(1)}%`;
      const ok = Math.abs(d) <= 1.0;
      cls = ok ? 'ok' : d > 0 ? 'over' : '';
      el.pred.className = 'bg-pred ' + cls;
      txt = ok ? '<b>ぴったり</b><br>このまま！' : d > 0 ? `<b>${Math.round(d)}m</b><br>いきすぎる` : `<b>${Math.round(-d)}m</b><br>てまえ`;
    }
    if (txt !== this._bgTxt) { this._bgTxt = txt; el.txt.innerHTML = txt; }
    el.txt.className = 'bg-txt ' + cls;
  },

  /* 「いまやること」コーチ(小2でもわかる次の一手を常に出す) */
  _updateCoach() {
    const el = this._coachEl || (this._coachEl = $('#coach'));
    const sim = this.sim;
    const h = sim.hud();
    let txt = '';
    const redAhead = h.ats && h.ats.kind === 'signal' && h.ats.target === 0;
    if (h.finished) {
      txt = '';
    } else if (h.doorOpen) {
      const rest = Math.ceil((h.next ? h.next.dep : sim._departTime) - sim.t);
      txt = rest > 0 ? `おきゃくさんが のりおり中… しゅっぱつまで あと <b>${Math.max(0, rest)}</b> びょう`
        : 'まもなく ドアがしまります';
    } else if (sim.v < 0.5 && sim.notch <= 0 && !(redAhead && h.ats.at - sim.pos < 150)) {
      txt = '<b>▲すすむ</b> をおして しゅっぱつ！';
    } else if (h.atsLamp === 'brake') {
      txt = '⚠ スピードのだしすぎで じどうブレーキ中… とまるまで まってね';
    } else if (redAhead && (h.ats.at - sim.pos) < 700) {
      txt = sim.v < 0.5 ? '🔴 しんごうが <b>あか</b>。あおに かわるまで まとう' : '🔴 しんごうが <b>あか</b>！ ブレーキで とまろう';
    } else if (h.ats && h.ats.kind === 'signal' && (h.ats.at - sim.pos) < 700 && sim.v > h.ats.target - 3) {
      txt = `🟡 しんごうが <b>きいろ</b>。スピードを <b>${Math.round(h.ats.target)}</b> まで おとそう`;
    } else if (h.ats && h.ats.kind === 'limit' && sim.v > h.ats.pattern - 4 && h.ats.target < h.limit) {
      /* 「いまの制限は守っているのに」の混乱に、理由(この先の低い制限)を示す */
      const m = Math.max(0, Math.round(h.ats.at - sim.pos));
      txt = `⚠ このさきは <b>${Math.round(h.ats.target)}</b> までしか だせないよ。いまから おとそう（あと <b>${m}</b> m）`;
    } else if (h.next && h.next.dist < 550) {
      txt = `<b>▼ブレーキ</b>で「8」のかんばんに ぴったり！ のこり <b>${Math.max(0, Math.round(h.next.dist))}</b> m`;
    } else if (h.ats && sim.v > h.ats.pattern - 4) {
      txt = `⚠ スピードを <b>${Math.round(h.ats.target)}</b> まで おとそう`;
    } else if (h.next) {
      txt = `つぎは <b>${kanaOf(h.next.name) || h.next.name}</b> ／ スピードは <b>${h.limit}</b> まで`;
    }
    if (txt !== this._coachTxt) {
      this._coachTxt = txt;
      el.innerHTML = txt;
      el.classList.toggle('hidden', !txt);
    }

    /* 大型HUD(じそく・のこりm/あと秒) */
    if (!this._bh) {
      this._bh = {
        v: $('#bh-v'), cap: $('#bh-ctx-cap'), num: $('#bh-ctx-num'),
        unit: $('#bh-ctx-unit'), row: document.querySelector('.bh-ctx'),
      };
    }
    const bv = String(Math.round(sim.v));
    if (this._bh.v.textContent !== bv) this._bh.v.textContent = bv;
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
    if (this._bh.num.textContent !== num) this._bh.num.textContent = num;
    if (this._bh.cap.textContent !== cap) this._bh.cap.textContent = cap;
    if (this._bh.unit.textContent !== unit) this._bh.unit.textContent = unit;
    this._bh.row.classList.toggle('bh-warn', warn);

    /* しゅっぱつスキップボタン(まだ待ち時間があるときだけ) */
    const canSkip = h.doorOpen && ((h.next ? h.next.dep : sim._departTime) - sim.t) > 6;
    $('#btn-skip').classList.toggle('hidden', !canSkip);
    this._updateBrakeGuide(h);
    this._updateRouteStrip();
  },

  retryStation() {
    this.sim.reset(this.lastStationIdx);
    this.setPaused(false);
    $('#overrun-modal').classList.add('hidden');
    if (this.scene.traffic) this.scene.traffic.reset(this.sim);
    this._coachTxt = null; this._rsIdx = null;
    this.flashMsg(`${rubyStation(this.sim.stops[this.lastStationIdx].name)} から やりなおし`, 2000);
  },

  quitDrive() {
    this.running = false;
    this.setPaused(false);
    if (this.audio) this.audio.stop();
    if (this.announcer) this.announcer.cancel();
    this.renderSvcCards(); this.renderRoute();
    this.go('select');
  },

  /* ================= 終了と成績票 ================= */
  finishRun(res) {
    this.running = false;
    if (this.audio) this.audio.stop();
    this.save.runs = (this.save.runs || 0) + 1;
    const full = this.startIdx === 0 && this.endIdx == null;
    const key = `${this.service}_${this.direction}_${this.weather}`;
    const prev = this.save.best[key];
    const isBest = full && (!prev || res.total > prev.total);
    if (isBest) this.save.best[key] = { total: res.total, rank: res.rank };
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
    /* 背景は外から列車を眺める */
    this._setCam('drone');
    setTimeout(() => this._showResult(res, prev, isBest, full), 1400);
  },

  _showResult(res, prev, isBest, full) {
    const rk = $('#res-rank');
    rk.textContent = res.rank;
    rk.className = 'res-rank rk-' + res.rank;
    const sim = this.sim;
    const from = sim.stops[sim.startIdx].name, to = sim.stops[sim.stops.length - 1].name;
    const tod = { day: '', evening: '　（ゆうがた）', night: '　（よる）' }[this.daytime];
    const wx = { clear: '', rain: '　（あめ）', snow: '　（ゆき）' }[this.weather];
    $('#res-svc').innerHTML = `${rubySvc(SERVICES[this.service].name)}　${rubyStation(from)} → ${rubyStation(to)}${wx}${tod}`;
    $('#res-title').textContent = res.total >= 95 ? 'でんせつの うんてんし' : res.total >= 85 ? 'めいじん うんてんし' : res.total >= 70 ? 'いちにんまえ うんてんし' : res.total >= 55 ? 'みならい うんてんし' : 'もういちど チャレンジ！';
    const bd = res.breakdown;
    $('#res-breakdown').innerHTML = [
      ['えきに ぴったり とまれた？', bd.stop, 30], ['じかんどおりに はしれた？', bd.time, 30], ['スピードを まもれた？', bd.comp, 25], ['のりごこち', bd.ride, 15],
    ].map(([label, got, max]) => `
      <div class="rb-row"><span class="rb-l">${label}</span>
      <span class="rb-bar"><i data-w="${(got / max) * 100}"></i></span>
      <span class="rb-n">${got.toFixed(1)} / ${max}</span></div>`).join('');
    $('#res-stops').innerHTML = '<tr><th>えき</th><th>とまった ずれ</th><th>おくれ</th></tr>' +
      res.stops.map((st) => `<tr><td>${st.name}<span class="st-kana">${kanaOf(st.name)}</span></td>
        <td class="${Math.abs(st.err) <= 1 ? 'good' : Math.abs(st.err) > 2 ? 'bad' : ''}">${st.err > 0 ? '+' : ''}${st.err.toFixed(2)}m${Math.abs(st.err) <= 0.35 ? ' ◎' : ''}</td>
        <td class="${st.late > 30 ? 'bad' : ''}">${st.late > 0 ? '+' + st.late + 'びょう' : 'ぴったり'}</td></tr>`).join('');
    $('#res-best').textContent = isBest ? '★ じこベスト こうしん！' : (prev && full ? `ベスト ${prev.total}てん (${prev.rank})` : full ? '' : 'ぜんぶ はしると ベストきろくに のこるよ');
    /* この運転でもらったスタンプ */
    const rs = $('#res-stamps');
    if (this.runStamps.length) {
      rs.innerHTML = `<p>もらった えきスタンプ ${this.runStamps.length}こ</p>`;
      this.runStamps.slice(0, 8).forEach((n, i) => { const cv = document.createElement('canvas'); drawStamp(cv, n, { size: 72, seed: i }); rs.appendChild(cv); });
      rs.classList.remove('hidden');
    } else rs.classList.add('hidden');
    const rb = $('#res-badges');
    if (this.runBadges.length) {
      rb.innerHTML = '<p>あたらしい くんしょう</p>' + this.runBadges.map((id) => {
        const b = badgeById(id);
        return `<span class="rb-badge"><span class="bd-ico">${b.icon}</span>${b.name}</span>`;
      }).join('');
      rb.classList.remove('hidden');
    } else rb.classList.add('hidden');
    this.go('result');
    /* 点数をカウントアップ・ランクをポンと押す */
    const tot = $('#res-total');
    const t0 = performance.now();
    rk.classList.remove('pop');
    const step = () => {
      const k = Math.min(1, (performance.now() - t0) / 1100);
      tot.textContent = Math.round(res.total * (1 - Math.pow(1 - k, 3)));
      if (k < 1) requestAnimationFrame(step);
      else rk.classList.add('pop');
    };
    requestAnimationFrame(step);
    requestAnimationFrame(() => document.querySelectorAll('.rb-bar i').forEach((i) => { i.style.width = i.dataset.w + '%'; }));
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
      this.cab.render();
      this._updateCoach();
    } else if (m === 'result') {
      this.scene.render(dt);
    } else if (m === 'title' || m === 'select' || m === 'stamps') {
      if (!document.hidden) {
        this._attractTick(dt);
        this.scene.render(dt);
      }
    }
    /* fpsが持続的に低ければ自動で描画負荷を下げる(ブルーム→dpr→影) */
    this._fpsT = (this._fpsT || 0) + dt;
    if (this._fpsT > 6) {
      this._fpsT = 0;
      if (this.scene.fps && this.scene.fps < 33 && !this._fast && !this.debug) {
        const what = this.scene.stepDownQuality();
        if (what) console.log('[auto-quality] step down:', what, 'fps=', Math.round(this.scene.fps));
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
