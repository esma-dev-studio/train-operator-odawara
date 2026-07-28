/* =========================================================
 * main.js — 画面遷移・ゲームループ・入力・記録
 * ========================================================= */
import { TrainSim, SERVICES } from './sim/engine.js';
import { RailScene } from './scene/scene.js';
import { Cab } from './cab/cab.js';
import { CabAudio } from './audio/audio.js';
import { kanaOf, rubyStation } from './sim/kana.js';

/* 種別名のふりがな */
const SVC_KANA = { '各駅停車': 'かくえきていしゃ', '急行': 'きゅうこう', '快速急行': 'かいそくきゅうこう' };
const rubySvc = (name) => SVC_KANA[name] ? `<ruby>${name}<rt>${SVC_KANA[name]}</rt></ruby>` : name;

const $ = (s) => document.querySelector(s);
const SAVE_KEY = 'trainop_v1';

/* 雨天のフロントガラス演出(水滴+ワイパー) */
class RainGlass {
  constructor(canvas) {
    this.cv = canvas;
    this.c = canvas.getContext('2d');
    this.drops = [];
    this.t = 0;
    this.active = false;
  }
  resize(w, h) { this.cv.width = w; this.cv.height = h; }
  setActive(on) {
    this.active = on;
    this.cv.style.display = on ? 'block' : 'none';
    if (!on) { this.drops = []; this.c.clearRect(0, 0, this.cv.width, this.cv.height); }
  }
  render(dt, v) {
    if (!this.active) return;
    const w = this.cv.width, h = this.cv.height, c = this.c;
    if (!w || !h) return;
    this.t += dt;
    for (let i = 0; i < 3; i++) {
      if (this.drops.length > 240) break;
      if (Math.random() < 0.8) {
        this.drops.push({ x: Math.random() * w, y: Math.random() * h, r: 0.9 + Math.random() * 2.4, vy: 0, life: 3 + Math.random() * 6 });
      }
    }
    c.clearRect(0, 0, w, h);
    /* ワイパー(往復) */
    const period = 1.4;
    const ph = (this.t % period) / period;
    const swing = 0.5 - 0.5 * Math.cos(ph * Math.PI * 2);
    const ang = -2.45 + swing * 1.7;
    const px = w * 0.6, py = h * 1.08, len = h * 0.82;
    this.drops = this.drops.filter((d) => {
      d.life -= dt;
      d.vy += dt * (7 + d.r * 8 + v * 0.45);
      d.y += d.vy * dt;
      d.x += Math.sin(this.t * 3 + d.y * 0.02) * 0.25;
      const da = Math.atan2(d.y - py, d.x - px);
      if (Math.abs(da - ang) < 0.1 && Math.hypot(d.x - px, d.y - py) < len) return false;
      return d.life > 0 && d.y < h + 12;
    });
    c.fillStyle = 'rgba(205,218,228,0.32)';
    for (const d of this.drops) {
      c.beginPath(); c.arc(d.x, d.y, d.r, 0, 7); c.fill();
    }
    /* ワイパー本体 */
    const bx = px + Math.cos(ang) * len, by = py + Math.sin(ang) * len;
    c.strokeStyle = 'rgba(14,17,20,0.88)';
    c.lineWidth = Math.max(4, h * 0.011);
    c.beginPath();
    c.moveTo(px + Math.cos(ang) * len * 0.35, py + Math.sin(ang) * len * 0.35);
    c.lineTo(bx, by);
    c.stroke();
  }
}

const App = {
  line: null, timetable: null,
  sim: null, scene: null, cab: null, audio: null,
  running: false, paused: false,
  service: 'local', weather: 'clear', startIdx: 0, quality: 'high',
  save: { best: {} },
  debug: /[?&]debug=1/.test(location.search),

  async boot() {
    try { this.save = Object.assign({ best: {} }, JSON.parse(localStorage.getItem(SAVE_KEY) || '{}')); } catch (e) { /* 初期値 */ }
    const [line, tt] = await Promise.all([
      fetch('./data/line.json').then((r) => r.json()),
      fetch('./data/timetable.json').then((r) => r.json()),
    ]);
    this.line = line; this.timetable = tt;
    const touch = matchMedia('(pointer: coarse)').matches;
    this.quality = localStorage.getItem('trainop_quality') || (touch ? 'mid' : 'high');
    this.buildSelect();
    this.bindUI();
    this.showScreen('title');
    if (this.debug) {
      window.__test = {
        app: this,
        fast: (n) => { this._fast = n; },        // シミュレーション倍速（描画はそのまま）
        auto: (on) => { this._auto = on ? this._makeAutopilot() : null; },
      };
    }
  },

  /* デバッグ用の自動運転（tools/autodrive.mjs と同じ制御則） */
  _makeAutopilot() {
    let lastChange = -9, lastNotch = 0;
    return () => {
      const sim = this.sim;
      const set = (n) => {
        if (n === lastNotch) return;
        if (sim.t - lastChange < 0.6 && !(n < lastNotch && n <= -4)) return;
        lastChange = sim.t; lastNotch = n; sim.setNotch(n);
      };
      const h = sim.hud();
      if (h.doorOpen) { set(0); return; }
      const v = h.v;
      const target = sim.stops[sim.stopIdx];
      const d = target ? target.stopAt - sim.pos : 1e9;
      const bGrade = 9.81 * (h.grade / 1000) * 3.6;
      const bNeed = d > 0.3 ? ((v / 3.6) ** 2 / (2 * d)) * 3.6 : 9;
      let bRest = 0;
      if (h.ats && h.ats.kind !== 'stop' && v > h.ats.target - 1) {
        const lag = 22 + (v / 3.6) * 1.7;
        const dr = h.ats.at - sim.pos - lag;
        const vt = Math.max(0, h.ats.target - 1);
        if (dr > 1) bRest = (((v / 3.6) ** 2 - (vt / 3.6) ** 2) / (2 * dr)) * 3.6;
        else if (v > h.ats.target + 0.5) bRest = 2.2;
      }
      const bWant = Math.max(bNeed > 0.8 && d < 1000 ? bNeed : 0, bRest > 0.72 ? bRest : 0);
      if (bWant > 0) {
        const b = bWant * (d < 45 ? 1.0 : 1.1) - Math.min(0, bGrade);
        const step = Math.ceil((b / 4.0) * 7 + 0.25);
        if (d < 2.2 && v < 3.5) { set(-3); return; }
        if (d < 12 && v < 8 && bNeed < 1.6) { set(-1); return; }
        set(-Math.min(7, Math.max(1, step)));
        return;
      }
      if (d > 1.4 && d < 60 && v < 4 && bNeed < 1.2) { set(1); return; }
      let cruise = h.limit - 2;
      if (h.ats && h.ats.kind !== 'stop') cruise = Math.min(cruise, Math.max(h.ats.target - 1, h.ats.pattern - 5));
      cruise = Math.max(20, cruise);
      if (v > cruise + 0.5) { set(v > cruise + 5 ? -2 : -1); return; }
      if (v < cruise - 6 && d > 250) { set(4); return; }
      if (v < cruise - 1.5 && d > 250) { set(2); return; }
      set(0);
    };
  },

  showScreen(name) {
    document.querySelectorAll('.screen').forEach((el) => el.classList.toggle('active', el.id === 'screen-' + name));
  },

  /* ---------------- 選択画面 ---------------- */
  buildSelect() {
    const wrap = $('#svc-list');
    const durOf = (key) => {
      const t = this.timetable[key];
      return Math.round(t[t.length - 1][0] / 60);
    };
    wrap.innerHTML = Object.entries(SERVICES).map(([key, s]) => {
      const stops = s.stops ? s.stops.length : this.line.stations.length;
      const best = this.save.best[key + '_' + 'clear'] || this.save.best[key + '_rain'];
      return `<button class="svc-card" data-svc="${key}">
        <span class="svc-name">${rubySvc(s.name)}</span>
        <span class="svc-meta">とまる<ruby>駅<rt>えき</rt></ruby> ${stops} ／ めやす ${durOf(key)}ぷん</span>
        <span class="svc-best">${best ? `ベスト ${best.total}てん (${best.rank})` : 'まだ きろくなし'}</span>
      </button>`;
    }).join('');
    wrap.querySelectorAll('.svc-card').forEach((b) => {
      b.addEventListener('click', () => {
        this.service = b.dataset.svc;
        wrap.querySelectorAll('.svc-card').forEach((x) => x.classList.toggle('sel', x === b));
        this.buildStartSelect();
      });
    });
    wrap.querySelector('.svc-card').classList.add('sel');
    this.buildStartSelect();

    document.querySelectorAll('input[name=weather]').forEach((r) => {
      r.addEventListener('change', () => { this.weather = document.querySelector('input[name=weather]:checked').value; });
    });

    document.querySelectorAll('input[name=quality]').forEach((r) => {
      r.checked = r.value === this.quality;
      r.addEventListener('change', () => {
        this.quality = document.querySelector('input[name=quality]:checked').value;
        try { localStorage.setItem('trainop_quality', this.quality); } catch (e) { /* 保存不可でも続行 */ }
        if (this.scene) { this.scene.renderer.dispose(); this.scene = null; }   // 次の出庫で再構築
      });
    });
  },

  buildStartSelect() {
    const svc = SERVICES[this.service];
    const stops = this.line.stations.filter((st) => !svc.stops || svc.stops.includes(st.name));
    const sel = $('#start-select');
    sel.innerHTML = stops.slice(0, -1).map((st, i) =>
      `<option value="${i}">${st.name}（${kanaOf(st.name)}）から ・ のこり${stops.length - 1 - i}えき</option>`).join('');
    sel.value = '0';
  },

  /* ---------------- UIバインド ---------------- */
  bindUI() {
    $('#btn-start').addEventListener('click', () => this.startDrive());
    $('#btn-to-select').addEventListener('click', () => this.showScreen('select'));
    $('#btn-back-title').addEventListener('click', () => this.showScreen('title'));
    $('#btn-pause-resume').addEventListener('click', () => this.setPaused(false));
    $('#btn-pause-retry').addEventListener('click', () => this.retryStation());
    $('#btn-pause-quit').addEventListener('click', () => this.quitDrive());
    $('#btn-res-retry').addEventListener('click', () => { this.showScreen('drive'); this.beginRun(this.startIdx); });
    $('#btn-res-select').addEventListener('click', () => this.quitDrive());
    $('#btn-overrun-retry').addEventListener('click', () => { $('#overrun-modal').classList.add('hidden'); this.retryStation(); });

    /* タッチ用ボタン(すすむ/ブレーキ/けいてき/ポーズ)
     * ▲▼はレバーを1段ずつ動かすのと同じ。押したらレバーの持ち手を光らせて関係を見せる */
    const flashGrip = () => {
      const g = $('#lever-grip');
      g.classList.add('tb-flash');
      clearTimeout(this._gripFlashT);
      this._gripFlashT = setTimeout(() => g.classList.remove('tb-flash'), 320);
    };
    $('#tb-up').addEventListener('click', () => {
      if (this.running && !this.paused) { this.sim.setNotch(Math.min(4, this.sim.notch + 1)); flashGrip(); }
    });
    $('#tb-dn').addEventListener('click', () => {
      if (this.running && !this.paused) { this.sim.setNotch(Math.max(-8, this.sim.notch - 1)); flashGrip(); }
    });
    $('#tb-horn').addEventListener('click', () => { if (this.running && !this.paused && this.audio) this.audio.horn(); });
    $('#btn-pause-touch').addEventListener('click', () => { if (this.running) this.setPaused(!this.paused); });
    $('#btn-skip').addEventListener('click', () => {
      if (this.running && !this.paused && this.sim.skipDwell()) this.flashMsg('ドアが しまります！', 1600);
    });

    addEventListener('keydown', (ev) => {
      if (!this.running) return;
      if (ev.repeat) return;
      if (ev.code === 'Escape' || ev.code === 'KeyP') { this.setPaused(!this.paused); return; }
      if (this.paused) return;
      const n = this.sim.notch;
      if (ev.code === 'ArrowUp' || ev.code === 'KeyW') this.sim.setNotch(Math.min(4, n + 1));
      else if (ev.code === 'ArrowDown' || ev.code === 'KeyS') this.sim.setNotch(Math.max(-8, n === -8 ? -8 : n - 1));
      else if (ev.code === 'Space') { ev.preventDefault(); this.sim.setNotch(-8); }
      else if (ev.code === 'KeyN' || ev.code === 'Digit0') this.sim.setNotch(0);
      else if (ev.code === 'KeyH') this.audio && this.audio.horn();
    });
    addEventListener('keydown', (ev) => { if (ev.code === 'Space' && this.running) ev.preventDefault(); });

    /* タッチ: 画面右のレバー */
    const lever = $('#lever');
    let dragging = false;
    const leverNotch = (clientY) => {
      const r = lever.getBoundingClientRect();
      const k = Math.min(1, Math.max(0, (clientY - r.top) / r.height));
      /* 上=P4 … 下=EB の13段 */
      const idx = Math.round(k * 12);
      const val = 4 - idx >= -7 ? 4 - idx : -8;
      this.sim.setNotch(Math.max(-8, Math.min(4, 4 - idx)));
    };
    lever.addEventListener('pointerdown', (ev) => { dragging = true; lever.setPointerCapture(ev.pointerId); leverNotch(ev.clientY); });
    lever.addEventListener('pointermove', (ev) => { if (dragging) leverNotch(ev.clientY); });
    lever.addEventListener('pointerup', () => { dragging = false; });

    /* ノッチ表示列(P4〜EB)も直接さわって操作できるようにする
     * (子どもはレバーよりこちらを触りがち、という実プレイの声から) */
    const nlist = $('#notch-list');
    const notchFromPoint = (x, y) => {
      if (!this.running || this.paused) return;
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
  },

  resizeGL() {
    if (!this.scene) return;
    const wrap = $('#gl-wrap');
    this.scene.resize(wrap.clientWidth, wrap.clientHeight);
    if (this.rainGlass) this.rainGlass.resize(wrap.clientWidth, wrap.clientHeight);
  },

  /* ---------------- 運転開始 ---------------- */
  startDrive() {
    this.startIdx = Number($('#start-select').value) || 0;
    this.showScreen('drive');
    this.beginRun(this.startIdx);
  },

  beginRun(startIdx) {
    this.sim = new TrainSim(this.line, { service: this.service, weather: this.weather, timetable: this.timetable });
    this.sim.reset(startIdx);
    this.lastStationIdx = startIdx;
    try {
      if (!this.scene) {
        this.scene = new RailScene($('#gl'), this.line, this.sim, { quality: this.quality });
      } else {
        this.scene.sim = this.sim;
        this.scene.setWeather(this.weather);
      }
    } catch (err) {
      /* WebGLが使えない等。無反応にせず、必ず画面に理由を出す */
      this.showScreen('select');
      alert('3Dがひょうじ できませんでした。\nブラウザを さいしんに してから もういちど ためしてね。\n(' + (err && err.message ? err.message : err) + ')');
      return;
    }
    this.scene.setWeather(this.weather);
    if (!this.cab) this.cab = new Cab(this.sim); else this.cab.sim = this.sim;
    if (!this.rainGlass) this.rainGlass = new RainGlass($('#rain-glass'));
    this.rainGlass.setActive(this.weather === 'rain');
    if (!this.audio) this.audio = new CabAudio();
    this.audio.ensure();   // クリック起点なので自動再生制限もOK
    this.audio.bind(this.sim);
    this.sim.onEvent((type, e) => this.onSimEvent(type, e));
    $('#drive-head-svc').innerHTML = rubySvc(SERVICES[this.service].name) + '　<ruby>新百合ヶ丘<rt>しんゆりがおか</rt></ruby> いき';
    $('#msg-center').classList.add('hidden');
    $('#overrun-modal').classList.add('hidden');
    this.setPaused(false);
    this.running = true;
    this.resizeGL();
    if (!this._rafStarted) { this._rafStarted = true; this.loop(); }
  },

  onSimEvent(type, e) {
    if (type === 'arrived') {
      this.lastStationIdx = this.sim.stopIdx - 1;
      const last = this.sim.score.stops[this.sim.score.stops.length - 1];
      const abs = Math.abs(last.err);
      const grade = abs <= 0.35 ? '◎ みごと！' : abs <= 1 ? '○ いいね' : abs <= 2 ? '△ おしい' : '× ざんねん';
      const lateTxt = last.late > 3 ? `／ ${last.late}びょう おくれ` : last.early > 30 ? '／ はやすぎ' : '／ じかん ぴったり';
      this.flashMsg(`${rubyStation(e.name)} にとうちゃく　ずれ ${last.err > 0 ? '+' : ''}${last.err.toFixed(2)}m ${grade} ${lateTxt}`);
    }
    if (type === 'door-closed') this.flashMsg('ドアがしまりました ── <ruby>出発進行<rt>しゅっぱつしんこう</rt></ruby>！', 1800);
    if (type === 'overrun') this.flashMsg('⚠ いきすぎ！ とまるところを すぎています', 2600, true);
    if (type === 'overrun-stop') {
      $('#overrun-modal').classList.remove('hidden');
    }
    if (type === 'ats-brake') {
      const a = this.sim.hud().ats;
      const why = a && a.kind === 'limit' ? `（このさき ${Math.round(a.target)} のため）` : '';
      this.flashMsg(`⚠ スピードの出しすぎ！ じどうブレーキが かかりました${why}`, 2400, true);
    }
    if (type === 'finished') this.finishRun(e);
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
  },

  /* 「いまやること」コーチ(小2でもわかる次の一手を常に出す) */
  _updateCoach() {
    const el = this._coachEl || (this._coachEl = $('#coach'));
    const sim = this.sim;
    const h = sim.hud();
    let txt = '';
    if (h.finished) {
      txt = '';
    } else if (h.doorOpen) {
      const rest = Math.ceil((h.next ? h.next.dep : sim._departTime) - sim.t);
      txt = rest > 0 ? `おきゃくさんが のりおり中… しゅっぱつまで あと <b>${Math.max(0, rest)}</b> びょう`
        : 'まもなく ドアがしまります';
    } else if (sim.v < 0.5 && sim.notch <= 0) {
      txt = '<b>▲すすむ</b> をおして しゅっぱつ！';
    } else if (h.atsLamp === 'brake') {
      txt = '⚠ スピードのだしすぎで じどうブレーキ中… とまるまで まってね';
    } else if (h.ats && h.ats.kind === 'signal' && (h.ats.at - sim.pos) < 700) {
      txt = '🔴 しんごうが <b>あか</b>！ ブレーキで とまろう';
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
  },

  retryStation() {
    this.sim.reset(this.lastStationIdx);
    this.setPaused(false);
    $('#overrun-modal').classList.add('hidden');
    this.flashMsg(`${rubyStation(this.sim.stops[this.lastStationIdx].name)} から やりなおし`, 2000);
  },

  quitDrive() {
    this.running = false;
    this.setPaused(false);
    if (this.audio) this.audio.stop();
    this.showScreen('select');
  },

  /* ---------------- 終了と成績票 ---------------- */
  finishRun(res) {
    this.running = false;
    if (this.audio) this.audio.stop();
    const key = this.service + '_' + this.weather;
    const prev = this.save.best[key];
    const isBest = !prev || res.total > prev.total;
    if (isBest && this.startIdx === 0) {
      this.save.best[key] = { total: res.total, rank: res.rank };
      try { localStorage.setItem(SAVE_KEY, JSON.stringify(this.save)); } catch (e) { /* 保存不可でも続行 */ }
    }
    $('#res-rank').textContent = res.rank;
    $('#res-rank').className = 'res-rank rk-' + res.rank;
    $('#res-total').textContent = res.total;
    $('#res-svc').innerHTML = `${rubySvc(SERVICES[this.service].name)}　<ruby>新宿<rt>しんじゅく</rt></ruby> → <ruby>新百合ヶ丘<rt>しんゆりがおか</rt></ruby>${this.weather === 'rain' ? '　（あめ）' : ''}`;
    $('#res-title').textContent = res.total >= 95 ? 'でんせつの うんてんし' : res.total >= 85 ? 'めいじん うんてんし' : res.total >= 70 ? 'いちにんまえ うんてんし' : res.total >= 55 ? 'みならい うんてんし' : 'もういちど チャレンジ！';
    const bd = res.breakdown;
    $('#res-breakdown').innerHTML = [
      ['えきに ぴったり とまれた？', bd.stop, 30], ['じかんどおりに はしれた？', bd.time, 30], ['スピードを まもれた？', bd.comp, 25], ['のりごこち', bd.ride, 15],
    ].map(([label, got, max]) => `
      <div class="rb-row"><span class="rb-l">${label}</span>
      <span class="rb-bar"><i style="width:${(got / max) * 100}%"></i></span>
      <span class="rb-n">${got.toFixed(1)} / ${max}</span></div>`).join('');
    $('#res-stops').innerHTML = '<tr><th>えき</th><th>とまった ずれ</th><th>おくれ</th></tr>' +
      res.stops.map((st) => `<tr><td>${st.name}<span class="st-kana">${kanaOf(st.name)}</span></td>
        <td class="${Math.abs(st.err) <= 1 ? 'good' : Math.abs(st.err) > 2 ? 'bad' : ''}">${st.err > 0 ? '+' : ''}${st.err.toFixed(2)}m</td>
        <td class="${st.late > 30 ? 'bad' : ''}">${st.late > 0 ? '+' + st.late + 'びょう' : 'ぴったり'}</td></tr>`).join('');
    $('#res-best').textContent = isBest && this.startIdx === 0 ? '★ じこベスト こうしん！' : (prev ? `ベスト ${prev.total}てん (${prev.rank})` : '');
    this.showScreen('result');
  },

  /* ---------------- ループ ---------------- */
  loop() {
    requestAnimationFrame(() => this.loop());
    const now = performance.now();
    const dt = Math.min(0.1, (now - (this._lastT || now)) / 1000);
    this._lastT = now;
    if (!this.running) return;
    if (!this.paused) {
      const mult = this._fast || 1;
      for (let i = 0; i < mult && this.running; i++) {
        if (this._auto) this._auto();
        this.sim.tick(dt);
      }
      if (this.audio) this.audio.update(this.sim, dt);
      if (this.rainGlass) this.rainGlass.render(dt, this.sim.v);
    }
    if (!this.running) return;
    this.scene.render(this.paused ? 0 : dt);
    this.cab.render();
    this._updateCoach();
    /* fpsが持続的に低ければ自動で描画負荷を下げる(dpr→影) */
    this._fpsT = (this._fpsT || 0) + dt;
    if (this._fpsT > 6) {
      this._fpsT = 0;
      if (this.scene.fps && this.scene.fps < 33) {
        const what = this.scene.stepDownQuality();
        if (what && this.debug) console.log('[auto-quality] step down:', what, 'fps=', Math.round(this.scene.fps));
      }
    }
  },
};

addEventListener('DOMContentLoaded', () => App.boot());
