/* =========================================================
 * scene/scene.js — three.js 前面展望シーン
 * 実線形(line.json)からレール・架線・駅・信号・街並みを手続き生成。
 * ゲームロジックは持たない（simの状態を毎フレーム描くだけ）。
 * ========================================================= */
import * as THREE from 'three';

const UP = new THREE.Vector3(0, 1, 0);

/* 路線データから5mごとのフレーム（位置・進行方向・左方向）を作る */
function buildFrames(line) {
  const pts = line.pts.map(([x, y, e]) => new THREE.Vector3(x, e, -y));
  const frames = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
    const t = b.clone().sub(a).normalize();
    const left = new THREE.Vector3().crossVectors(UP, t).normalize();
    frames.push({ p: pts[i], t, left });
  }
  return frames;
}

/* 進行位置s(m)のフレームを補間 */
export function frameAt(frames, step, s) {
  const f = s / step;
  const i = Math.max(0, Math.min(frames.length - 2, Math.floor(f)));
  const k = Math.min(1, Math.max(0, f - i));
  const p = frames[i].p.clone().lerp(frames[i + 1].p, k);
  const t = frames[i].t.clone().lerp(frames[i + 1].t, k).normalize();
  const left = frames[i].left.clone().lerp(frames[i + 1].left, k).normalize();
  return { p, t, left };
}

/* 中心線から横にoffsetした帯状ジオメトリ（UV: u=横, v=距離/uvScale） */
function ribbon(frames, i0, i1, offset, width, lift, uvScale) {
  const pos = [], uv = [], idx = [];
  let n = 0;
  for (let i = i0; i <= i1; i++) {
    const f = frames[i];
    const c = f.p.clone().addScaledVector(f.left, offset);
    const l = c.clone().addScaledVector(f.left, width / 2);
    const r = c.clone().addScaledVector(f.left, -width / 2);
    pos.push(l.x, l.y + lift, l.z, r.x, r.y + lift, r.z);
    const v = (i * 5) / uvScale;
    uv.push(0, v, 1, v);
    if (i > i0) {
      const a = n - 2, b = n - 1, c2 = n, d = n + 1;
      idx.push(a, c2, b, b, c2, d);
    }
    n += 2;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/* ---- canvasテクスチャいろいろ ---- */
function canvasTex(w, h, draw, repeatY) {
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  draw(cv.getContext('2d'), w, h);
  const tex = new THREE.CanvasTexture(cv);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 4;
  if (repeatY) tex.repeat.set(1, repeatY);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

const texBallast = (dark) => canvasTex(64, 128, (c) => {
  c.fillStyle = dark ? '#3c3a38' : '#5a564f';
  c.fillRect(0, 0, 64, 128);
  for (let i = 0; i < 260; i++) {
    c.fillStyle = `rgba(${120 + Math.random() * 60},${115 + Math.random() * 55},${105 + Math.random() * 50},${dark ? 0.25 : 0.5})`;
    c.fillRect(Math.random() * 64, Math.random() * 128, 2.5, 2);
  }
  /* まくらぎ */
  c.fillStyle = dark ? '#2e2c2a' : '#4a453e';
  c.fillRect(4, 4, 56, 18);
  c.fillRect(4, 68, 56, 18);
});

const texBuilding = (hue) => canvasTex(128, 256, (c) => {
  c.fillStyle = hue;
  c.fillRect(0, 0, 128, 256);
  for (let y = 10; y < 250; y += 22) {
    for (let x = 8; x < 120; x += 20) {
      c.fillStyle = Math.random() < 0.72 ? 'rgba(210,225,240,0.9)' : 'rgba(40,55,70,0.9)';
      c.fillRect(x, y, 12, 13);
    }
  }
});

const texHouse = () => canvasTex(64, 64, (c) => {
  c.fillStyle = '#d8d2c6';
  c.fillRect(0, 0, 64, 64);
  c.fillStyle = 'rgba(70,85,100,0.85)';
  c.fillRect(10, 22, 14, 16); c.fillRect(40, 22, 14, 16);
});

function boardTexture(lines, opts = {}) {
  return canvasTex(opts.w || 256, opts.h || 128, (c, w, h) => {
    c.fillStyle = opts.bg || '#ffffff';
    c.fillRect(0, 0, w, h);
    if (opts.border) { c.strokeStyle = opts.border; c.lineWidth = 8; c.strokeRect(4, 4, w - 8, h - 8); }
    c.fillStyle = opts.fg || '#111';
    c.textAlign = 'center'; c.textBaseline = 'middle';
    lines.forEach(([text, y, size, weight]) => {
      c.font = `${weight || 'bold'} ${size}px "Zen Kaku Gothic New", "Hiragino Sans", Meiryo, sans-serif`;
      c.fillText(text, w / 2, y);
    });
  });
}

export class RailScene {
  constructor(canvas, line, sim) {
    this.line = line;
    this.sim = sim;
    this.step = line.meta.step;
    this.frames = buildFrames(line);

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 1.6));
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(58, 16 / 9, 0.3, 2600);
    this.clockT = 0;

    this.setWeather(sim.weather);

    const hemi = new THREE.HemisphereLight(0xcfe4f5, 0x51524c, 1.05);
    this.scene.add(hemi);
    const sun = new THREE.DirectionalLight(0xfff4de, 1.5);
    sun.position.set(-700, 900, -400);
    this.scene.add(sun);

    this._buildTrack();
    this._buildLineside();
    this._buildStations();
    this._buildSignals();
    this._buildBoards();
    this._buildTown();
    this._buildTunnel();
    this._buildRiver();
    this._buildAiTrain();
  }

  setWeather(w) {
    this.weather = w;
    const sky = w === 'rain' ? 0x8b95a0 : 0xbcd8ee;
    const fog = w === 'rain' ? 0x8b95a0 : 0xc4d9ea;
    this.scene.background = new THREE.Color(sky);
    this.scene.fog = new THREE.Fog(fog, 250, w === 'rain' ? 900 : 1500);
  }

  /* ---------- 軌道 ---------- */
  _buildTrack() {
    const F = this.frames, N = F.length - 1;
    const DS = THREE.DoubleSide;
    const matBallast = new THREE.MeshLambertMaterial({ map: texBallast(false), side: DS });
    matBallast.map.repeat.set(1, 1);
    const matRail = new THREE.MeshBasicMaterial({ color: 0x9aa2a8, side: DS });
    const matRailDark = new THREE.MeshBasicMaterial({ color: 0x555a5e, side: DS });

    const addTrack = (offset) => {
      /* 道床 */
      this.scene.add(new THREE.Mesh(ribbon(F, 0, N, offset, 4.2, 0, 2.5), matBallast));
      /* レール2本（頭面+側面の2枚で成立させる） */
      [-0.7175, 0.7175].forEach((o) => {
        this.scene.add(new THREE.Mesh(ribbon(F, 0, N, offset + o, 0.065, 0.19, 8), matRail));
        this.scene.add(new THREE.Mesh(ribbon(F, 0, N, offset + o + 0.05, 0.05, 0.115, 8), matRailDark));
      });
    };
    addTrack(0);       // 自列車（下り）
    addTrack(-3.8);    // 上り線
    /* 複々線区間: 急行線2本を追加 */
    const q = this.line.sections.quad;
    const qi0 = Math.floor(q.from / this.step), qi1 = Math.ceil(q.to / this.step);
    [[3.8], [7.6]].forEach(([off]) => {
      this.scene.add(new THREE.Mesh(ribbon(F, qi0, qi1, off, 4.2, 0, 2.5), matBallast));
      [-0.7175, 0.7175].forEach((o) => {
        this.scene.add(new THREE.Mesh(ribbon(F, qi0, qi1, off + o, 0.065, 0.19, 8), matRail));
      });
    });

    /* 軌道間の埋め（複線間・肩） */
    const matSub = new THREE.MeshLambertMaterial({ color: 0x63605a, side: DS });
    this.scene.add(new THREE.Mesh(ribbon(F, 0, N, -1.9, 3.0, -0.18, 40), matSub));
    /* 保守通路 */
    const matApron = new THREE.MeshLambertMaterial({ color: 0x74766e, side: DS });
    this.scene.add(new THREE.Mesh(ribbon(F, 0, N, 3.6, 3.0, -0.12, 40), matApron));
    this.scene.add(new THREE.Mesh(ribbon(F, 0, N, -7.2, 3.0, -0.12, 40), matApron));
    /* 地形（線路に沿った広い帯。標高に追従するので遠くまで地面がある）
     * 多摩川の区間だけは水面が見えるように帯を切る */
    const matGnd = new THREE.MeshLambertMaterial({ color: 0x8e9a80, side: DS });
    const matGnd2 = new THREE.MeshLambertMaterial({ color: 0x86927c, side: DS });
    const cuts = this.line.sections.river.map((r) => [r.from - 240, r.to + 240]);
    let segStart = 0;
    const addGround = (i0, i1) => {
      if (i1 - i0 < 4) return;
      this.scene.add(new THREE.Mesh(ribbon(F, i0, i1, 154, 300, -0.5, 200), matGnd));
      this.scene.add(new THREE.Mesh(ribbon(F, i0, i1, -154, 300, -0.5, 200), matGnd2));
    };
    cuts.sort((a, b) => a[0] - b[0]).forEach(([cf, ct]) => {
      addGround(Math.floor(segStart / this.step), Math.floor(cf / this.step));
      segStart = ct;
    });
    addGround(Math.floor(segStart / this.step), N);
  }

  /* ---------- 架線柱と架線 ---------- */
  _buildLineside() {
    const F = this.frames;
    const poleGeo = new THREE.CylinderGeometry(0.14, 0.17, 7.6, 6);
    const armGeo = new THREE.BoxGeometry(6.4, 0.14, 0.14);
    const mat = new THREE.MeshLambertMaterial({ color: 0x6f7d84 });
    const count = Math.floor(this.line.meta.length / 45);
    const poles = new THREE.InstancedMesh(poleGeo, mat, count);
    const arms = new THREE.InstancedMesh(armGeo, mat, count);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3(1, 1, 1);
    let n = 0;
    for (let s = 20; s < this.line.meta.length - 20 && n < count; s += 45) {
      const f = frameAt(F, this.step, s);
      const inTun = this._inTunnel(s);
      if (inTun) continue;
      const side = -6.4;   // 上り線の外側
      const p = f.p.clone().addScaledVector(f.left, side);
      p.y += 3.8;
      q.setFromUnitVectors(new THREE.Vector3(1, 0, 0), f.left);
      m.compose(p, q, sc);
      poles.setMatrixAt(n, m);
      const pa = f.p.clone().addScaledVector(f.left, side / 2 - 0.4);
      pa.y += 6.4;
      m.compose(pa, q, sc);
      arms.setMatrixAt(n, m);
      n++;
    }
    poles.count = n; arms.count = n;
    this.scene.add(poles, arms);

    /* トロリ線（自線と上り線の上） */
    const wireMat = new THREE.LineBasicMaterial({ color: 0x30363a });
    [0, -3.8].forEach((off) => {
      const pos = [];
      for (let i = 0; i < F.length; i += 2) {
        const f = F[i];
        const p = f.p.clone().addScaledVector(f.left, off);
        pos.push(p.x, p.y + 5.1, p.z);
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      this.scene.add(new THREE.Line(g, wireMat));
    });
  }

  _inTunnel(s) {
    return this.line.sections.tunnel.some((t) => s > t.from && s < t.to);
  }

  /* ---------- 駅 ---------- */
  _buildStations() {
    const F = this.frames;
    const matPlat = new THREE.MeshLambertMaterial({ color: 0xb9b4a8, side: THREE.DoubleSide });
    const matEdge = new THREE.MeshBasicMaterial({ color: 0xe8e2d0, side: THREE.DoubleSide });
    const matRoof = new THREE.MeshLambertMaterial({ color: 0x4d565e, side: THREE.DoubleSide });
    this.line.stations.forEach((st, si) => {
      const i0 = Math.max(0, Math.floor((st.s - 155) / this.step));
      const i1 = Math.min(F.length - 1, Math.ceil((st.s + 15) / this.step));
      const under = this._inTunnel(st.s);
      /* ホーム（自線の左側=島式風・上り線側にも） */
      [[3.05, 1], [-6.85, -1]].forEach(([off]) => {
        this.scene.add(new THREE.Mesh(ribbon(F, i0, i1, off, 2.4, 1.02, 20), matPlat));
        this.scene.add(new THREE.Mesh(ribbon(F, i0, i1, off + (off > 0 ? -1.05 : 1.05), 0.3, 1.03, 20), matEdge));
        if (!under) this.scene.add(new THREE.Mesh(ribbon(F, i0 + 3, i1 - 1, off, 3.2, 4.4, 20), matRoof));
      });
      /* 駅名標 */
      const prev = this.line.stations[si - 1], next = this.line.stations[si + 1];
      const tex = boardTexture([
        [st.name, 46, 42], [st.code, 88, 20, 'normal'],
        [`${prev ? '◀ ' + prev.name : ''}    ${next ? next.name + ' ▶' : ''}`, 112, 15, 'normal'],
      ], { bg: '#f5f8fa', border: '#1b56a7', fg: '#16283a', w: 512, h: 128 });
      const board = new THREE.Mesh(new THREE.PlaneGeometry(3.4, 0.85),
        new THREE.MeshBasicMaterial({ map: tex }));
      const f = frameAt(F, this.step, st.s - 55);
      board.position.copy(f.p).addScaledVector(f.left, 3.0);
      board.position.y += 2.5;
      board.lookAt(board.position.clone().addScaledVector(f.t, -10));
      this.scene.add(board);
      /* 停止位置目標（8両） */
      const stopTex = boardTexture([['8', 60, 72]], { bg: '#111', fg: '#fff', border: '#fff', w: 96, h: 96 });
      const stop = new THREE.Mesh(new THREE.PlaneGeometry(0.42, 0.42),
        new THREE.MeshBasicMaterial({ map: stopTex }));
      const fs = frameAt(F, this.step, st.s + 3);
      stop.position.copy(fs.p).addScaledVector(fs.left, 2.75);
      stop.position.y += 1.85;
      stop.lookAt(stop.position.clone().addScaledVector(fs.t, -10));
      this.scene.add(stop);
    });
  }

  /* ---------- 信号機 ---------- */
  _buildSignals() {
    const F = this.frames;
    this.signalMeshes = [];
    const bodyGeo = new THREE.BoxGeometry(0.42, 1.15, 0.24);
    const poleGeo = new THREE.CylinderGeometry(0.07, 0.09, 4.4, 6);
    const lampGeo = new THREE.CircleGeometry(0.13, 12);
    const matBody = new THREE.MeshLambertMaterial({ color: 0x23282c });
    const matPole = new THREE.MeshLambertMaterial({ color: 0x777f86 });
    this.sim.signals.forEach((sig) => {
      const f = frameAt(F, this.step, sig.s);
      const g = new THREE.Group();
      const pole = new THREE.Mesh(poleGeo, matPole);
      pole.position.y = 2.2;
      g.add(pole);
      const body = new THREE.Mesh(bodyGeo, matBody);
      body.position.y = 4.6;
      g.add(body);
      const lamps = [];
      [['G', 0.36, 0x1fce62], ['Y', 0, 0xffc12b], ['R', -0.36, 0xff4838]].forEach(([k, dy, col]) => {
        const lamp = new THREE.Mesh(lampGeo, new THREE.MeshBasicMaterial({ color: 0x1c1f22 }));
        lamp.position.set(0, 4.6 + dy, 0.13);
        g.add(lamp);
        lamps.push({ k, lamp, col });
      });
      g.position.copy(f.p).addScaledVector(f.left, 2.6);
      g.lookAt(g.position.clone().addScaledVector(f.t, -10));
      this.scene.add(g);
      this.signalMeshes.push({ sig, lamps });
    });
  }

  /* ---------- 制限標識 ---------- */
  _buildBoards() {
    const F = this.frames;
    this.line.limits.forEach((z) => {
      const tex = boardTexture([[String(z.v), 62, 66]], { bg: '#ffd21e', fg: '#111', border: '#111', w: 112, h: 112 });
      const b = new THREE.Mesh(new THREE.PlaneGeometry(0.7, 0.7), new THREE.MeshBasicMaterial({ map: tex }));
      const f = frameAt(F, this.step, Math.max(5, z.from - 15));
      b.position.copy(f.p).addScaledVector(f.left, 2.3);
      b.position.y += 1.6;
      b.lookAt(b.position.clone().addScaledVector(f.t, -10));
      this.scene.add(b);
      /* 解除標 */
      const tex2 = boardTexture([['解', 60, 56]], { bg: '#fff', fg: '#111', border: '#111', w: 96, h: 96 });
      const b2 = new THREE.Mesh(new THREE.PlaneGeometry(0.55, 0.55), new THREE.MeshBasicMaterial({ map: tex2 }));
      const f2 = frameAt(F, this.step, Math.min(this.line.meta.length - 5, z.to + 10));
      b2.position.copy(f2.p).addScaledVector(f2.left, 2.3);
      b2.position.y += 1.5;
      b2.lookAt(b2.position.clone().addScaledVector(f2.t, -10));
      this.scene.add(b2);
    });
  }

  /* ---------- 街並み ---------- */
  _buildTown() {
    const F = this.frames;
    const rng = (() => { let x = 12345; return () => (x = (x * 16807) % 2147483647) / 2147483647; })();
    const mats = [
      new THREE.MeshLambertMaterial({ map: texBuilding('#8d99a5') }),
      new THREE.MeshLambertMaterial({ map: texBuilding('#a89f92') }),
      new THREE.MeshLambertMaterial({ map: texBuilding('#7e8a96') }),
      new THREE.MeshLambertMaterial({ map: texHouse() }),
    ];
    const geo = new THREE.BoxGeometry(1, 1, 1);
    geo.translate(0, 0.5, 0);
    const groups = mats.map((m) => ({ m, list: [] }));
    const urban = this.line.sections.urban;
    const kindAt = (s) => (urban.find((u) => s >= u.from && s < u.to) || { kind: 2 }).kind;
    for (let s = 40; s < this.line.meta.length - 40; s += 26) {
      if (this._inTunnel(s)) continue;
      const inRiver = this.line.sections.river.some((r) => s > r.from - 60 && s < r.to + 60);
      if (inRiver) continue;
      const kind = kindAt(s);
      const f = frameAt(F, this.step, s + rng() * 18);
      for (const side of [1, -1]) {
        const nBld = kind === 0 ? 3 : kind === 1 ? 2 : kind === 2 ? 2 : 1;
        for (let bi = 0; bi < nBld; bi++) {
          if (rng() < (kind === 3 ? 0.45 : 0.25)) continue;
          const dist = 16 + rng() * (kind === 0 ? 90 : 70) + bi * 22;
          const h = kind === 0 ? 22 + rng() * 95
            : kind === 1 ? 8 + rng() * 22
            : kind === 2 ? 5 + rng() * 13
            : 4 + rng() * 5;
          const w = kind === 3 ? 7 + rng() * 4 : 9 + rng() * 16;
          const dpt = kind === 3 ? 7 + rng() * 3 : 9 + rng() * 14;
          const p = f.p.clone().addScaledVector(f.left, side * (dist + (side > 0 ? 0 : 4)));
          const mi = kind === 3 && h < 9 ? 3 : Math.floor(rng() * 3);
          groups[mi].list.push({ p, h, w, dpt, rot: rng() * 0.5 - 0.25 });
        }
      }
    }
    groups.forEach(({ m, list }) => {
      const im = new THREE.InstancedMesh(geo, m, list.length);
      const mat4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler();
      list.forEach((b, i) => {
        e.set(0, b.rot, 0); q.setFromEuler(e);
        mat4.compose(new THREE.Vector3(b.p.x, b.p.y - 1.5, b.p.z), q, new THREE.Vector3(b.w, b.h, b.dpt));
        im.setMatrixAt(i, mat4);
      });
      this.scene.add(im);
    });
  }

  /* ---------- トンネル（下北沢地下区間） ---------- */
  _buildTunnel() {
    const F = this.frames;
    const mat = new THREE.MeshLambertMaterial({ color: 0x3d4348, side: THREE.DoubleSide });
    this.line.sections.tunnel.forEach((t) => {
      const i0 = Math.floor(t.from / this.step), i1 = Math.ceil(t.to / this.step);
      /* 壁2枚+天井 */
      const wall = (off) => {
        const pos = [], idx = [];
        let n = 0;
        for (let i = i0; i <= i1; i++) {
          const f = F[i];
          const b = f.p.clone().addScaledVector(f.left, off);
          pos.push(b.x, b.y - 0.5, b.z, b.x, b.y + 6.2, b.z);
          if (i > i0) idx.push(n - 2, n, n - 1, n - 1, n, n + 1);
          n += 2;
        }
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
        g.setIndex(idx);
        g.computeVertexNormals();
        this.scene.add(new THREE.Mesh(g, mat));
      };
      wall(7.2); wall(-9.5);
      this.scene.add(new THREE.Mesh(ribbon(F, i0, i1, -1.15, 17, 6.2, 40), mat));
      /* 坑口 */
      [t.from, t.to].forEach((s) => {
        const f = frameAt(F, this.step, s);
        const portal = new THREE.Mesh(new THREE.BoxGeometry(19, 9.5, 1.2),
          new THREE.MeshLambertMaterial({ color: 0x8b8f8c }));
        portal.position.copy(f.p).addScaledVector(f.left, -1.15);
        portal.position.y += 3.6;
        portal.lookAt(portal.position.clone().add(f.t));
        this.scene.add(portal);
      });
      /* トンネル照明 */
      const lampGeo = new THREE.BoxGeometry(0.12, 0.12, 1.3);
      const lampMat = new THREE.MeshBasicMaterial({ color: 0xd8e6c8 });
      const count = Math.floor((t.to - t.from) / 18);
      const lamps = new THREE.InstancedMesh(lampGeo, lampMat, count);
      const m4 = new THREE.Matrix4(), q = new THREE.Quaternion();
      for (let i = 0; i < count; i++) {
        const f = frameAt(F, this.step, t.from + i * 18);
        q.setFromUnitVectors(new THREE.Vector3(0, 0, 1), f.t);
        m4.compose(new THREE.Vector3().copy(f.p).addScaledVector(f.left, 3.1).setY(f.p.y + 5.4), q, new THREE.Vector3(1, 1, 1));
        lamps.setMatrixAt(i, m4);
      }
      this.scene.add(lamps);
    });
  }

  /* ---------- 多摩川橋梁 ---------- */
  _buildRiver() {
    const F = this.frames;
    this.line.sections.river.forEach((r) => {
      const i0 = Math.floor((r.from - 130) / this.step), i1r = Math.ceil((r.to + 130) / this.step);
      /* 水面と河川敷は線路に沿った幅広リボンで（橋の角度に自然に追従する） */
      const matWater = new THREE.MeshLambertMaterial({ color: 0x6fa3c0, side: THREE.DoubleSide });
      const matBank = new THREE.MeshLambertMaterial({ color: 0x8fae7e, side: THREE.DoubleSide });
      this.scene.add(new THREE.Mesh(ribbon(F, i0, i1r, 0, 760, -7.5, 200), matWater));
      this.scene.add(new THREE.Mesh(ribbon(F, Math.floor((r.from - 260) / this.step), i0 + 6, 0, 760, -6.7, 200), matBank));
      this.scene.add(new THREE.Mesh(ribbon(F, i1r - 6, Math.ceil((r.to + 260) / this.step), 0, 760, -6.7, 200), matBank));
      /* トラス橋（緑の骨組み） */
      const iA = Math.floor(r.from / this.step), iB = Math.ceil(r.to / this.step);
      const truss = new THREE.MeshLambertMaterial({ color: 0x3f7a5f, side: THREE.DoubleSide });
      [6.2, -8.5].forEach((off) => {
        this.scene.add(new THREE.Mesh(ribbon(F, iA, iB, off, 0.5, 3.2, 20), truss));
        this.scene.add(new THREE.Mesh(ribbon(F, iA, iB, off, 0.5, 0.6, 20), truss));
      });
      for (let s = r.from; s < r.to; s += 14) {
        const f = frameAt(F, this.step, s);
        [6.2, -8.5].forEach((off) => {
          const post = new THREE.Mesh(new THREE.BoxGeometry(0.35, 4.2, 0.35), truss);
          post.position.copy(f.p).addScaledVector(f.left, off);
          post.position.y += 2.2;
          this.scene.add(post);
        });
      }
      /* 橋脚 */
      for (let s = r.from + 30; s < r.to; s += 60) {
        const f = frameAt(F, this.step, s);
        const pier = new THREE.Mesh(new THREE.BoxGeometry(11, 9, 2.4),
          new THREE.MeshLambertMaterial({ color: 0x9a978e }));
        pier.position.copy(f.p).addScaledVector(f.left, -1.2);
        pier.position.y -= 5.2;
        pier.lookAt(pier.position.clone().add(f.t));
        this.scene.add(pier);
      }
    });
  }

  /* ---------- 複々線を走る対向/追い抜き列車（演出） ---------- */
  _buildAiTrain() {
    const g = new THREE.Group();
    const body = new THREE.MeshLambertMaterial({ color: 0xdfe4e8 });
    const band = new THREE.MeshBasicMaterial({ color: 0x2f6fb8 });
    for (let i = 0; i < 4; i++) {
      const car = new THREE.Mesh(new THREE.BoxGeometry(2.8, 3.4, 19.2), body);
      car.position.z = -i * 19.9;
      car.position.y = 2.0;
      g.add(car);
      const stripe = new THREE.Mesh(new THREE.BoxGeometry(2.84, 0.5, 19.2), band);
      stripe.position.set(0, 1.7, -i * 19.9);
      g.add(stripe);
    }
    this.aiTrain = g;
    this.scene.add(g);
  }

  /* AI列車: 複々線区間の急行線を周回 */
  _updateAiTrain(t) {
    const q = this.line.sections.quad;
    const span = q.to - q.from - 200;
    if (span < 500) return;
    const speed = 26;   // m/s ≒ 94km/h
    const cyc = (t * speed) % (span * 2 + 4000);
    let s, dir = 1;
    if (cyc < span) { s = q.to - 100 - cyc; dir = -1; }        // 対向(上り急行線を新宿方面へ)
    else if (cyc < span + 2000) { this.aiTrain.visible = false; return; }
    else if (cyc < span * 2 + 2000) { s = q.from + 100 + (cyc - span - 2000); dir = 1; }
    else { this.aiTrain.visible = false; return; }
    this.aiTrain.visible = true;
    const f = frameAt(this.frames, this.step, Math.max(10, Math.min(this.line.meta.length - 10, s)));
    const off = dir < 0 ? 7.6 : 3.8;
    this.aiTrain.position.copy(f.p).addScaledVector(f.left, off);
    const ahead = f.p.clone().addScaledVector(f.t, dir * 30).addScaledVector(f.left, off);
    this.aiTrain.lookAt(ahead);
  }

  resize(w, h) {
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  /* 毎フレーム: 運転台視点で描画 */
  render(dt) {
    this.clockT += dt;
    const sim = this.sim;
    const s = Math.max(0, Math.min(this.line.meta.length - 2, sim.pos));
    const f = frameAt(this.frames, this.step, s);
    const fAhead = frameAt(this.frames, this.step, Math.min(this.line.meta.length - 2, s + 42));
    /* 運転士の目線（左寄り・レール上3.1m） */
    const eye = f.p.clone().addScaledVector(f.left, 0.85);
    eye.y += 3.05;
    /* 揺れ */
    const sway = Math.sin(this.clockT * 7.3) * 0.012 + Math.sin(this.clockT * 2.1) * 0.02;
    const bob = Math.sin(this.clockT * 9.1) * 0.008;
    const k = Math.min(1, sim.v / 70);
    eye.addScaledVector(f.left, sway * k);
    eye.y += bob * k;
    this.camera.position.copy(eye);
    const look = fAhead.p.clone().addScaledVector(fAhead.left, 0.55);
    look.y += 2.4;
    this.camera.lookAt(look);

    /* 信号現示の更新（近傍600m だけ） */
    this.signalMeshes.forEach((sm) => {
      const d = sm.sig.s - sim.pos;
      if (d < -50 || d > 700) return;
      const asp = sim.signalAspect(sm.sig);
      sm.lamps.forEach((l, i) => {
        const on = (asp === 3 && l.k === 'G') || ((asp === 1) && l.k === 'Y') ||
          (asp === 2 && (l.k === 'Y' || l.k === 'G')) || (asp === 0 && l.k === 'R');
        l.lamp.material.color.setHex(on ? l.col : 0x1c1f22);
      });
    });

    this._updateAiTrain(this.clockT);
    this.renderer.render(this.scene, this.camera);
  }
}
