/* =========================================================
 * scene/cockpit.js — 運転台の窓まわり(3D)
 * カメラの子として置き、画面比率に合わせて「窓枠・ピラー・
 * 運転台の天板・サンバイザー・ワイパー」を配置する。
 * 計器はHTML(#cab)側。ここは"窓から見える運転台のふち"だけを担当。
 * ========================================================= */
import * as THREE from '../vendor/three.module.min.js';

const TAN = Math.tan(THREE.MathUtils.degToRad(29));   // 縦FOV58°の半分

/* 画面上の多角形(ndc座標)を、カメラ前方 z の平面に置くジオメトリにする */
function ndcPoly(pts, z, aspect, cols) {
  const hw = -z * TAN * aspect, hh = -z * TAN;
  const pos = [], col = [], idx = [];
  pts.forEach(([x, y], i) => {
    pos.push(x * hw, y * hh, z);
    const c = cols ? cols[i] : [1, 1, 1];
    col.push(c[0], c[1], c[2]);
  });
  for (let i = 1; i + 1 < pts.length; i++) idx.push(0, i, i + 1);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/* sRGB(見た目)の値をリニアへ(頂点色はリニア解釈) */
const lin = (r, g, b) => [Math.pow(r, 2.2), Math.pow(g, 2.2), Math.pow(b, 2.2)];

export class Cockpit {
  constructor(camera) {
    this.camera = camera;
    this.root = new THREE.Group();
    this.root.renderOrder = 10;
    camera.add(this.root);
    /* 枠・天井は「室内の影」なので基本色を明るさ係数で調整する(Basic+頂点色) */
    this.matFrame = new THREE.MeshBasicMaterial({ vertexColors: true, fog: false, side: THREE.DoubleSide });
    this.matSeal = new THREE.MeshBasicMaterial({ color: 0x050607, fog: false, side: THREE.DoubleSide });
    /* 天板は太陽と環境光を受ける(つや消しの樹脂) */
    this.matDash = new THREE.MeshStandardMaterial({ color: 0x1d2226, roughness: 0.92, metalness: 0.0, fog: false });
    this.matDashEdge = new THREE.MeshStandardMaterial({ color: 0x15191c, roughness: 0.5, metalness: 0.2, fog: false });
    this.matVisor = new THREE.MeshBasicMaterial({ color: 0x10161b, transparent: true, opacity: 0.55, fog: false, depthWrite: false });
    this.matWiper = new THREE.MeshStandardMaterial({ color: 0x0c0d0f, roughness: 0.55, metalness: 0.4, fog: false });
    this.matLamp = new THREE.MeshBasicMaterial({ color: 0x000000, fog: false });
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
    const F = (t) => lin(0.075 + t * 0.06, 0.085 + t * 0.065, 0.095 + t * 0.07);
    /* --- 上枠(天井のふち) --- */
    const top = new THREE.Mesh(ndcPoly([[-1.05, L.top], [1.05, L.top + 0.015], [1.05, 1.05], [-1.05, 1.05]], z, aspect,
      [F(0.55), F(0.55), F(0), F(0)]), this.matFrame);
    /* 窓ゴム(黒い縁取り) */
    const topSeal = new THREE.Mesh(ndcPoly([[-1.05, L.top - 0.012], [1.05, L.top + 0.003], [1.05, L.top + 0.015], [-1.05, L.top]], z + 0.001, aspect), this.matSeal);
    /* --- 左Aピラー(下が太い) --- */
    const ap = L.aPillar;
    const left = new THREE.Mesh(ndcPoly([[-1.05, -1.05], [-1 + ap, -1.05], [-1 + ap * 0.55, 1.05], [-1.05, 1.05]], z, aspect,
      [F(0), F(0.7), F(0.5), F(0)]), this.matFrame);
    const leftSeal = new THREE.Mesh(ndcPoly([[-1 + ap - 0.012, -1.05], [-1 + ap, -1.05], [-1 + ap * 0.55, 1.05], [-1 + ap * 0.55 - 0.01, 1.05]], z + 0.001, aspect), this.matSeal);
    /* --- 中央ピラー(運転士窓と貫通扉窓のあいだ) --- */
    const cx = L.cX, cw = L.cW;
    const center = new THREE.Mesh(ndcPoly([[cx - cw * 0.5, -1.05], [cx + cw * 0.62, -1.05], [cx + cw * 0.5, 1.05], [cx - cw * 0.42, 1.05]], z, aspect,
      [F(0.6), F(0.2), F(0.1), F(0.5)]), this.matFrame);
    const cSealL = new THREE.Mesh(ndcPoly([[cx - cw * 0.5 - 0.008, -1.05], [cx - cw * 0.5, -1.05], [cx - cw * 0.42, 1.05], [cx - cw * 0.42 - 0.008, 1.05]], z + 0.001, aspect), this.matSeal);
    const cSealR = new THREE.Mesh(ndcPoly([[cx + cw * 0.62, -1.05], [cx + cw * 0.62 + 0.008, -1.05], [cx + cw * 0.5 + 0.008, 1.05], [cx + cw * 0.5, 1.05]], z + 0.001, aspect), this.matSeal);
    /* --- サンバイザー(運転士窓の上、半透明のロールスクリーン) --- */
    const visor = new THREE.Mesh(ndcPoly([[-1 + ap * 0.6, L.top - 0.13], [cx - cw * 0.45, L.top - 0.11], [cx - cw * 0.44, L.top], [-1 + ap * 0.56, L.top]], z + 0.002, aspect), this.matVisor);
    visor.renderOrder = 11;
    [top, topSeal, left, leftSeal, center, cSealL, cSealR].forEach((m) => { m.renderOrder = 12; this.root.add(m); });
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
    dashShape.setIndex([0, 2, 1, 0, 3, 2]);
    dashShape.computeVertexNormals();
    const dash = new THREE.Mesh(dashShape, this.matDash);
    dash.renderOrder = 12;
    this.root.add(dash);
    /* 天板の奥の縁(窓下の見切り・デフロスタ吹き出し口) */
    const lip = new THREE.Mesh(new THREE.BoxGeometry(hwFar * 2, 0.035, 0.05), this.matDashEdge);
    lip.position.set(0, yTop + 0.012, zFar - 0.01);
    lip.renderOrder = 12;
    this.root.add(lip);
    /* 天板上の小さな表示灯(夜にほのかに光る) */
    const lampGeo = new THREE.BoxGeometry(0.014, 0.004, 0.008);
    [-0.34, -0.32, -0.30].forEach((x, i) => {
      const l = new THREE.Mesh(lampGeo, this.matLamp);
      l.position.set(x * aspect, yTop - 0.004, zFar + 0.32);
      l.userData.lampIdx = i;
      this.root.add(l);
    });

    /* --- ワイパー(根元は運転士窓の右下。休止位置は窓の下端に沿って寝ている) --- */
    const pivotNdc = [cx - cw * 0.9, L.dash + 0.035];
    const zw = -1.0;
    const hwW = -zw * TAN * aspect, hhW = -zw * TAN;
    this.wiper = new THREE.Group();
    this.wiper.position.set(pivotNdc[0] * hwW, pivotNdc[1] * hhW, zw);
    const armLen = hhW * 1.2;
    const arm = new THREE.Mesh(new THREE.BoxGeometry(armLen * 0.95, 0.009, 0.006), this.matWiper);
    arm.position.x = -armLen * 0.475;
    const blade = new THREE.Mesh(new THREE.BoxGeometry(armLen * 0.78, 0.006, 0.012), this.matWiper);
    blade.position.set(-armLen * 0.52, 0.006, 0.004);
    const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.016, 0.016, 0.02, 10), this.matWiper);
    hub.rotation.x = Math.PI / 2;
    this.wiper.add(arm, blade, hub);
    this.wiper.renderOrder = 13;
    this.wiperRest = 0.04;    // 休止角(ほぼ水平・左向き)
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

  /* light: 0..1 室内の明るさ、night: 表示灯を点ける */
  update(dt, { light = 1, night = false, wiper = false } = {}) {
    this.light += (light - this.light) * Math.min(1, dt * 3);
    const k = this.light;
    this.matFrame.color.setScalar(0.35 + 0.65 * k);
    this.matDash.color.setRGB(0.012 + 0.016 * k, 0.015 + 0.018 * k, 0.018 + 0.02 * k);
    this.matDash.envMapIntensity = 0.08 + 0.22 * k;
    this.matLamp.color.setHex(night || k < 0.35 ? 0x3c9a52 : 0x161b1e);
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
