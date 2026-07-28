/* =========================================================
 * main.js — 画面遷移・ゲームループ・入力・記録
 * ========================================================= */
import { TrainSim, SERVICES } from './sim/engine.js';
import { RailScene } from './scene/scene.js';
import { Cab } from './cab/cab.js';
import { CabAudio } from './audio/audio.js';

const $ = (s) => document.querySelector(s);
const SAVE_KEY = 'trainop_v1';

const App = {
  line: null, timetable: null,
  sim: null, scene: null, cab: null, audio: null,
  running: false, paused: false,
  service: 'local', weather: 'clear', startIdx: 0,
  save: { best: {} },
  debug: /[?&]debug=1/.test(location.search),

  async boot() {
    try { this.save = Object.assign({ best: {} }, JSON.parse(localStorage.getItem(SAVE_KEY) || '{}')); } catch (e) { /* 初期値 */ }
    const [line, tt] = await Promise.all([
      fetch('./data/line.json').then((r) => r.json()),
      fetch('./data/timetable.json').then((r) => r.json()),
    ]);
    this.line = line; this.timetable = tt;
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
        <span class="svc-name">${s.name}</span>
        <span class="svc-meta">停車 ${stops}駅 ／ 基準 ${durOf(key)}分</span>
        <span class="svc-best">${best ? `BEST ${best.total}点 (${best.rank})` : '記録なし'}</span>
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
  },

  buildStartSelect() {
    const svc = SERVICES[this.service];
    const stops = this.line.stations.filter((st) => !svc.stops || svc.stops.includes(st.name));
    const sel = $('#start-select');
    sel.innerHTML = stops.slice(0, -1).map((st, i) =>
      `<option value="${i}">${st.name} から (${stops.length - 1 - i}駅先まで)</option>`).join('');
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

    addEventListener('resize', () => this.resizeGL());
  },

  resizeGL() {
    if (!this.scene) return;
    const wrap = $('#gl-wrap');
    this.scene.resize(wrap.clientWidth, wrap.clientHeight);
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
    if (!this.scene) {
      this.scene = new RailScene($('#gl'), this.line, this.sim);
    } else {
      this.scene.sim = this.sim;
      this.scene.setWeather(this.weather);
    }
    this.scene.setWeather(this.weather);
    if (!this.cab) this.cab = new Cab(this.sim); else this.cab.sim = this.sim;
    if (!this.audio) this.audio = new CabAudio();
    this.audio.ensure();   // クリック起点なので自動再生制限もOK
    this.audio.bind(this.sim);
    this.sim.onEvent((type, e) => this.onSimEvent(type, e));
    $('#drive-head-svc').textContent = SERVICES[this.service].name + '　新百合ヶ丘 行';
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
      const grade = abs <= 0.35 ? '◎ 見事' : abs <= 1 ? '○ 良好' : abs <= 2 ? '△ もう少し' : '× 不良';
      const lateTxt = last.late > 3 ? `／ ${last.late}秒遅れ` : last.early > 30 ? '／ 早着' : '／ 定時';
      this.flashMsg(`${e.name} 停車　誤差 ${last.err > 0 ? '+' : ''}${last.err.toFixed(2)}m ${grade} ${lateTxt}`);
    }
    if (type === 'door-closed') this.flashMsg('ドア閉扉よし ── 出発進行', 1800);
    if (type === 'overrun') this.flashMsg('⚠ オーバーラン！ 停止位置を過ぎています', 2600, true);
    if (type === 'overrun-stop') {
      $('#overrun-modal').classList.remove('hidden');
    }
    if (type === 'ats-brake') this.flashMsg('⚠ ATS パターン超過 ── 常用最大ブレーキ', 2200, true);
    if (type === 'finished') this.finishRun(e);
  },

  flashMsg(text, ms = 2600, warn = false) {
    const el = $('#msg-center');
    el.textContent = text;
    el.classList.toggle('warn', warn);
    el.classList.remove('hidden');
    clearTimeout(this._msgT);
    this._msgT = setTimeout(() => el.classList.add('hidden'), ms);
  },

  setPaused(p) {
    this.paused = p;
    $('#screen-pause').classList.toggle('active', p);
  },

  retryStation() {
    this.sim.reset(this.lastStationIdx);
    this.setPaused(false);
    $('#overrun-modal').classList.add('hidden');
    this.flashMsg(`${this.sim.stops[this.lastStationIdx].name} からやり直します`, 2000);
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
    $('#res-svc').textContent = `${SERVICES[this.service].name}　新宿 → 新百合ヶ丘${this.weather === 'rain' ? '　（雨天）' : ''}`;
    $('#res-title').textContent = res.total >= 95 ? '指導運転士級' : res.total >= 85 ? '主任運転士級' : res.total >= 70 ? '運転士級' : res.total >= 55 ? '見習運転士' : '再教育';
    const bd = res.breakdown;
    $('#res-breakdown').innerHTML = [
      ['停止位置精度', bd.stop, 30], ['定時運転', bd.time, 30], ['制限・信号遵守', bd.comp, 25], ['乗り心地', bd.ride, 15],
    ].map(([label, got, max]) => `
      <div class="rb-row"><span class="rb-l">${label}</span>
      <span class="rb-bar"><i style="width:${(got / max) * 100}%"></i></span>
      <span class="rb-n">${got.toFixed(1)} / ${max}</span></div>`).join('');
    $('#res-stops').innerHTML = '<tr><th>駅</th><th>停止誤差</th><th>遅延</th></tr>' +
      res.stops.map((st) => `<tr><td>${st.name}</td>
        <td class="${Math.abs(st.err) <= 1 ? 'good' : Math.abs(st.err) > 2 ? 'bad' : ''}">${st.err > 0 ? '+' : ''}${st.err.toFixed(2)}m</td>
        <td class="${st.late > 30 ? 'bad' : ''}">${st.late > 0 ? '+' + st.late + 's' : '定時'}</td></tr>`).join('');
    $('#res-best').textContent = isBest && this.startIdx === 0 ? '★ 自己ベスト更新' : (prev ? `ベスト ${prev.total}点(${prev.rank})` : '');
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
    }
    if (!this.running) return;
    this.scene.render(this.paused ? 0 : dt);
    this.cab.render();
  },
};

addEventListener('DOMContentLoaded', () => App.boot());
