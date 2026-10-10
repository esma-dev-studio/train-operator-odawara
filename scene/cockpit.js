/* =========================================================
 * scene/cockpit.js — 運転台の窓まわり(3D)
 * カメラの子として置き、画面比率に合わせて「窓枠・ピラー・
 * 運転台の天板・サンバイザー・ワイパー」を配置する。
 * 計器はHTML(#cab)側。ここは"窓から見える運転台のふち"だけを担当。
 * 天板の色味は #cab パネル上端(--console-hi)とつながるように合わせてある。
 * ========================================================= */
import * as THREE from '../vendor/three.module.min.js';

const TAN = Math.tan(THREE.MathUtils.degToRad(29));   // 縦FOV58°の半分

/* 画面上の多角形(ndc座標)の頂点・色・面を buf に追記する(カメラ前方 z の平面) */
function pushPoly(buf, pts, z, aspect, cols) {
  const hw = -z * TAN * aspect, hh = -z * TAN;
  const base = buf.pos.length / 3;
  pts.forEach(([x, y], i) => {
    buf.pos.push(x * hw, y * hh, z);
    const c = cols ? cols[i] : [1, 1, 1];
    buf.col.push(c[0], c[1], c[2]);
  });
  for (let i = 1; i + 1 < pts.length; i++) buf.idx.push(base, base + i, base + i + 1);
}
const newBuf = () => ({ pos: [], col: [], idx: [] });
function bufGeo(buf) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(buf.pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(buf.col, 3));
  g.setIndex(buf.idx);
  g.computeVertexNormals();
  return g;
}

/* 同じ材質の小さな部品(箱・円柱)を1つのジオメトリにまとめる(描画回数を減らす) */
function mergeParts(parts) {
  const pos = [], nrm = [], idx = [];
  const v = new THREE.Vector3(), nm = new THREE.Matrix3();
  parts.forEach(({ geo, m }) => {
    const base = pos.length / 3;
    nm.getNormalMatrix(m);
    const p = geo.attributes.position, n = geo.attributes.normal;
    for (let i = 0; i < p.count; i++) {
      v.fromBufferAttribute(p, i).applyMatrix4(m); pos.push(v.x, v.y, v.z);
      v.fromBufferAttribute(n, i).applyMatrix3(nm).normalize(); nrm.push(v.x, v.y, v.z);
    }
    const ix = geo.index;
    for (let i = 0; i < ix.count; i++) idx.push(base + ix.getX(i));
    geo.dispose();
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setIndex(idx);
  return g;
}
const mat4 = (x, y, z, rx = 0) => new THREE.Matrix4().makeRotationX(rx).setPosition(x, y, z);

/* sRGB(見た目)の値をリニアへ(頂点色はリニア解釈) */
const lin = (r, g, b) => [Math.pow(r, 2.2), Math.pow(g, 2.2), Math.pow(b, 2.2)];
/* 内装(FRPの化粧板)の色: 上ほど20%暗く、窓ぎわ(ゴムの近く)は25%暗く */
const TRIM = [0.24, 0.26, 0.28];
const trim = (y, edge) => {
  const k = (1 - 0.2 * Math.min(1, Math.max(0, (y + 1) / 2))) * (edge ? 0.75 : 1);
  return lin(TRIM[0] * k, TRIM[1] * k, TRIM[2] * k);
};

/* 天板の表面(しぼ加工の樹脂・奥の縁にデフロスタの吹き出し口)を一度だけ描く 512x128 */
function dashTexture() {
  const cv = document.createElement('canvas');
  cv.width = 512; cv.height = 128;
  const c = cv.getContext('2d');
  c.fillStyle = '#2a2e31';
  c.fillRect(0, 0, 512, 128);
  /* しぼ(細かい凹凸)は乱数の点で */
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 4000; i++) {
    c.fillStyle = i & 1 ? 'rgba(255,255,255,0.035)' : 'rgba(0,0,0,0.06)';
    c.fillRect((rnd() * 512) | 0, (rnd() * 128) | 0, 1, 1);
  }
  /* 奥の縁(画像の上側 = 窓の下): デフロスタの吹き出し口 36本 */
  for (let i = 0; i < 36; i++) {
    const x = 8 + i * (496 / 36);
    c.fillStyle = '#0a0b0c';
    c.fillRect(x, 8, 9, 3);
    c.fillStyle = 'rgba(255,255,255,0.08)';
    c.fillRect(x, 11, 9, 1);
  }
  /* 奥の見切りの影と、手前のふちのハイライト */
  c.fillStyle = 'rgba(0,0,0,0.35)';
  c.fillRect(0, 0, 512, 4);
  c.fillStyle = 'rgba(255,255,255,0.10)';
  c.fillRect(0, 125, 512, 2);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

export class Cockpit {
  constructor(camera) {
    this.camera = camera;
    this.root = new THREE.Group();
    this.root.renderOrder = 10;
    camera.add(this.root);
    /* 枠・天井は「室内の影」なので基本色を明るさ係数で調整する(Basic+頂点色) */
    this.matFrame = new THREE.MeshBasicMaterial({ vertexColors: true, fog: false, side: THREE.DoubleSide });
    this.matSeal = new THREE.MeshBasicMaterial({ color: 0x050607, fog: false, side: THREE.DoubleSide });
    /* 天板は太陽と環境光を受ける(つや消しの樹脂・しぼ加工のテクスチャ) */
    this.matDash = new THREE.MeshStandardMaterial({ map: dashTexture(), color: 0xffffff, roughness: 0.92, metalness: 0.0, fog: false });
    this.matDashEdge = new THREE.MeshStandardMaterial({ color: 0x15191c, roughness: 0.5, metalness: 0.2, fog: false });
    this.matVisor = new THREE.MeshBasicMaterial({ color: 0x10161b, transparent: true, opacity: 0.55, fog: false, depthWrite: false });
    /* ワイパー: 黒い腕・ブレード / ゴム / 根元のメッキ */
    this.matWiper = new THREE.MeshStandardMaterial({ color: 0x0c0d0f, roughness: 0.55, metalness: 0.4, fog: false });
    this.matRubber = new THREE.MeshStandardMaterial({ color: 0x050505, roughness: 0.9, metalness: 0, fog: false });
    this.matChrome = new THREE.MeshStandardMaterial({ color: 0x7d858b, roughness: 0.3, metalness: 0.8, fog: false });
    this.light = 1;          // 室内の明るさ(昼1・夜/トンネル小)
    this.wiperOn = false;
    this.wiperT = 0;
    this.wiperAng = 0;
    this.layout = null;
    this.aspect = 0;
  }

  setVisible(v) { this.root.visible = v; }

  /* 画面比率が変わったら作り直す(要素は少ないので軽い) */
  layoutFor(aspect) {
    if (Math.abs(aspect - this.aspect) < 1e-3 && this.layout) return;
    this.aspect = aspect;
    this.root.children.slice().forEach((c) => {
      this.root.remove(c);
      c.traverse((o) => { if (o.geometry) o.geometry.dispose(); });   // ワイパー(グループ)の中も
    });
    /* 縦長(ポートレート)ほど枠を細くして視界を確保する */
    const narrow = aspect < 1.25;
    const L = {
      aPillar: narrow ? 0.06 : 0.075,         // 左ピラーの幅(ndc,下端)
      cX: narrow ? 0.66 : 0.52,               // 中央ピラーの位置(ndc x)
      cW: narrow ? 0.045 : 0.05,              // 中央ピラー幅
      top: narrow ? 0.885 : 0.86,             // 窓の上端(ndc y)
      dash: narrow ? -0.86 : -0.82,           // 天板の奥の縁(ndc y)
    };
    this.layout = L;
    const z = -0.9;
    /* ピラー・窓ゴムは天板の奥の縁で止める(天板の帯を横切らない) */
    const yB = L.dash - 0.01;
    const ap = L.aPillar, cx = L.cX, cw = L.cW;
    const T = (pts, edge) => pts.map(([, y], i) => trim(y, edge[i]));

    /* --- 枠(上枠・左Aピラー・中央ピラー)を1つのメッシュに --- */
    const fr = newBuf();
    const topPts = [[-1.05, L.top], [1.05, L.top + 0.015], [1.05, 1.05], [-1.05, 1.05]];
    pushPoly(fr, topPts, z, aspect, T(topPts, [1, 1, 0, 0]));
    const leftPts = [[-1.05, yB], [-1 + ap, yB], [-1 + ap * 0.55, 1.05], [-1.05, 1.05]];
    pushPoly(fr, leftPts, z, aspect, T(leftPts, [0, 1, 1, 0]));
    /* 中央ピラーは左右の半分に分け、まん中を明るく(両側の窓ぎわが暗い) */
    const cL = [[cx - cw * 0.5, yB], [cx + cw * 0.06, yB], [cx + cw * 0.04, 1.05], [cx - cw * 0.42, 1.05]];
    pushPoly(fr, cL, z, aspect, T(cL, [1, 0, 0, 1]));
    const cR = [[cx + cw * 0.06, yB], [cx + cw * 0.62, yB], [cx + cw * 0.5, 1.05], [cx + cw * 0.04, 1.05]];
    pushPoly(fr, cR, z, aspect, T(cR, [0, 1, 1, 0]));
    const frame = new THREE.Mesh(bufGeo(fr), this.matFrame);

    /* --- 窓ゴム(黒い縁取り)+ 窓の下の端から端までのゴム(天板との継ぎ目を隠す) --- */
    const sl = newBuf(), zs = z + 0.001;
    pushPoly(sl, [[-1.05, L.top - 0.012], [1.05, L.top + 0.003], [1.05, L.top + 0.015], [-1.05, L.top]], zs, aspect);
    pushPoly(sl, [[-1 + ap - 0.012, yB], [-1 + ap, yB], [-1 + ap * 0.55, 1.05], [-1 + ap * 0.55 - 0.01, 1.05]], zs, aspect);
    pushPoly(sl, [[cx - cw * 0.5 - 0.008, yB], [cx - cw * 0.5, yB], [cx - cw * 0.42, 1.05], [cx - cw * 0.42 - 0.008, 1.05]], zs, aspect);
    pushPoly(sl, [[cx + cw * 0.62, yB], [cx + cw * 0.62 + 0.008, yB], [cx + cw * 0.5 + 0.008, 1.05], [cx + cw * 0.5, 1.05]], zs, aspect);
    pushPoly(sl, [[-1.05, L.dash - 0.006], [1.05, L.dash - 0.006], [1.05, L.dash + 0.012], [-1.05, L.dash + 0.012]], zs, aspect);
    const seals = new THREE.Mesh(bufGeo(sl), this.matSeal);

    /* --- サンバイザー(運転士窓の上、半透明のロールスクリーン) --- */
    const vb = newBuf();
    pushPoly(vb, [[-1 + ap * 0.6, L.top - 0.13], [cx - cw * 0.45, L.top - 0.11], [cx - cw * 0.44, L.top], [-1 + ap * 0.56, L.top]], z + 0.002, aspect);
    const visor = new THREE.Mesh(bufGeo(vb), this.matVisor);
    visor.renderOrder = 11;
    [frame, seals].forEach((m) => { m.renderOrder = 12; this.root.add(m); });
    this.root.add(visor);

    /* --- 運転台の天板(3D: 奥の縁が L.dash に来るよう配置) --- */
    const zFar = -1.25, zNear = -0.55;
    const yTop = L.dash * TAN * -zFar;
    const hwFar = -zFar * TAN * aspect * 1.12;
    const dashShape = new THREE.BufferGeometry();
    const yN = yTop - 0.03;   // 手前へわずかに下がる
    const hwN = -zNear * TAN * aspect * 1.2;
    const dp = [
      -hwFar, yTop, zFar, hwFar, yTop, zFar, hwN, yN, zNear, -hwN, yN, zNear,
    ];
    dashShape.setAttribute('position', new THREE.Float32BufferAttribute(dp, 3));
    /* UV: 奥の縁(窓の下)が画像の上側。dp の頂点順(奥左・奥右・手前右・手前左)に合わせる */
    dashShape.setAttribute('uv', new THREE.Float32BufferAttribute([0, 1, 1, 1, 1, 0, 0, 0], 2));
    dashShape.setIndex([0, 2, 1, 0, 3, 2]);
    dashShape.computeVertexNormals();
    const dash = new THREE.Mesh(dashShape, this.matDash);
    dash.renderOrder = 12;
    this.root.add(dash);
    /* 天板の奥の縁(窓下の見切り) */
    const lip = new THREE.Mesh(new THREE.BoxGeometry(hwFar * 2, 0.035, 0.05), this.matDashEdge);
    lip.position.set(0, yTop + 0.012, zFar - 0.01);
    lip.renderOrder = 12;
    this.root.add(lip);

    /* --- ワイパー(根元は運転士窓の右下。休止位置は窓の下のゴムに沿って寝ている) --- */
    const pivotNdc = [cx - cw * 0.9, L.dash + 0.024];
    const zw = -1.0;
    const hwW = -zw * TAN * aspect, hhW = -zw * TAN;
    this.wiper = new THREE.Group();
    this.wiper.position.set(pivotNdc[0] * hwW, pivotNdc[1] * hhW, zw);
    const armLen = hhW * 1.2;
    /* 腕(黒い板)とブレードの背骨は同じ材質なので1つに */
    const armGeo = mergeParts([
      { geo: new THREE.BoxGeometry(armLen * 0.95, 0.016, 0.01), m: mat4(-armLen * 0.475, 0, 0) },
      { geo: new THREE.BoxGeometry(armLen * 0.8, 0.008, 0.012), m: mat4(-armLen * 0.52, 0.011, -0.004) },
      { geo: new THREE.CylinderGeometry(0.022, 0.024, 0.02, 12), m: mat4(0, 0, 0, Math.PI / 2) },
    ]);
    const arm = new THREE.Mesh(armGeo, this.matWiper);
    /* ブレードのゴム(窓に当たる黒い帯) */
    const rubber = new THREE.Mesh(new THREE.BoxGeometry(armLen * 0.8, 0.004, 0.006), this.matRubber);
    rubber.position.set(-armLen * 0.52, 0.017, -0.007);
    /* 根元のメッキのキャップ */
    const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.015, 0.03, 12), this.matChrome);
    cap.rotation.x = Math.PI / 2;
    cap.position.z = 0.006;
    this.wiper.add(arm, rubber, cap);
    this.wiper.traverse((o) => { o.renderOrder = 13; });
    this.wiperRest = 0.012;   // 休止角(ほぼ水平・左向き。窓の下のゴムの上に寝かせる)
    this.wiper.rotation.z = -this.wiperRest;
    this.root.add(this.wiper);
    this._wiperLen = armLen;
    this._pivotNdc = pivotNdc;
  }

  /* 雨滴を描く範囲(画面の正規化座標 0..1, 左上原点)と、ワイパーの画面上の位置 */
  windowRects() {
    const L = this.layout;
    if (!L) return null;
    const toU = (x) => (x + 1) / 2, toV = (y) => (1 - y) / 2;
    return [
      { x0: toU(-1 + L.aPillar * 0.6), x1: toU(L.cX - L.cW * 0.5), y0: toV(L.top), y1: toV(L.dash) },
      { x0: toU(L.cX + L.cW * 0.6), x1: 1, y0: toV(L.top), y1: toV(L.dash) },
    ];
  }

  wiperScreen() {
    if (!this.layout) return null;
    const [px, py] = this._pivotNdc;
    /* ndcでの腕の長さ(縦基準) */
    return { px: (px + 1) / 2, py: (1 - py) / 2, len: (this._wiperLen / TAN) / 2, ang: this.wiperAng };
  }

  /* light: 0..1 室内の明るさ(計器盤 #cab の減光にも使う: cab.setLight) */
  update(dt, { light = 1, night = false, wiper = false } = {}) {
    this.light += (light - this.light) * Math.min(1, dt * 3);
    const k = this.light;
    this.matFrame.color.setScalar(0.35 + 0.65 * k);
    /* 天板: 昼の見た目が #262b2f 前後(パネル上端 --console-hi とつながる)になるよう係数を合わせた */
    const kd = 0.18 + 0.5 * k;
    this.matDash.color.setRGB(kd * 0.95, kd * 1.12, kd * 1.3);   // 日なたの暖色をうち消して青みのグレーに
    this.matDash.envMapIntensity = 0.04 + 0.10 * k;
    /* ワイパー: 左右に往復(1往復1.4秒)。止めると休止位置へ戻る */
    if (wiper) this.wiperOn = true;
    if (this.wiperOn) {
      this.wiperT += dt;
      const ph = (this.wiperT % 1.4) / 1.4;
      const swing = 0.5 - 0.5 * Math.cos(ph * Math.PI * 2);
      this.wiperAng = this.wiperRest + swing * 1.55;
      if (!wiper && ph < 0.03) { this.wiperOn = false; this.wiperT = 0; this.wiperAng = this.wiperRest; }
    } else {
      this.wiperAng = this.wiperRest;
    }
    if (this.wiper) this.wiper.rotation.z = -this.wiperAng;
  }
}
