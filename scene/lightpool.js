/* =========================================================
 * scene/lightpool.js — 「光だまり」(にせものの照明)
 * 本物のライト(PointLight等)はiPadで重いので使わない。ホームの屋根の灯り・
 * トンネルの壁の灯りが床や壁を照らしている様子を、加算合成の板で描く。
 * ・霧の中で加算の板に霧の色を「足す」と白く浮くので、霧は「弱める」方向に効かせる
 * ・昼/夜の切り替えは不透明度と material.visible だけ(作り直し・再コンパイルなし)
 * ========================================================= */
import * as THREE from '../vendor/three.module.min.js';

/* 中心が明るく、ふちに向かって消える丸いグラデーション(128px) */
export function poolTexture() {
  const cv = document.createElement('canvas');
  cv.width = cv.height = 128;
  const c = cv.getContext('2d');
  const g = c.createRadialGradient(64, 64, 0, 64, 64, 64);
  g.addColorStop(0, 'rgba(255,236,200,1)');
  g.addColorStop(0.45, 'rgba(255,236,200,0.35)');
  g.addColorStop(1, 'rgba(255,236,200,0)');
  c.fillStyle = g;
  c.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/* ホームの屋根の灯り用の「帯」(64x128)。横(u)は中央が明るい山形、縦(v)は 0.5-0.5cos(2πv) の窓。
 * 縦の長さの半分ずつずらして並べると、重なったところの明るさの和がちょうど1になる(つぎ目のない帯) */
export function poolStripTexture() {
  const W = 64, H = 128;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const c = cv.getContext('2d');
  const img = c.createImageData(W, H);
  for (let y = 0; y < H; y++) {
    const v = (y + 0.5) / H;
    const a1 = 0.5 - 0.5 * Math.cos(2 * Math.PI * v);
    for (let x = 0; x < W; x++) {
      const u = ((x + 0.5) / W - 0.5) * 2;
      const o = (y * W + x) * 4;
      img.data[o] = img.data[o + 1] = img.data[o + 2] = 255;
      img.data[o + 3] = Math.round(255 * a1 * Math.exp(-4 * u * u));
    }
  }
  c.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/* 加算合成の材質の霧: 霧の色を混ぜる代わりに、遠いほど光を弱める */
export function fixAdditiveFog(mat, key) {
  mat.onBeforeCompile = (sh) => {
    sh.fragmentShader = sh.fragmentShader.replace('#include <fog_fragment>', `#ifdef USE_FOG
  #ifdef FOG_EXP2
    gl_FragColor.rgb *= exp( - fogDensity * fogDensity * vFogDepth * vFogDepth );
  #else
    gl_FragColor.rgb *= 1.0 - smoothstep( fogNear, fogFar, vFogDepth );
  #endif
#endif`);
  };
  mat.customProgramCacheKey = () => key;
  return mat;
}

/* 光だまりの材質(加算・深度書き込みなし・床より少し手前に描く) */
export function makePoolMaterial(tex, opts = {}) {
  const m = new THREE.MeshBasicMaterial({
    map: tex, color: opts.color != null ? opts.color : 0xffe6c0,
    transparent: true, opacity: opts.opacity != null ? opts.opacity : 1,
    blending: THREE.AdditiveBlending, depthWrite: false,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
  });
  m.userData.noWeather = true;
  return fixAdditiveFog(m, 'pool');
}

/* 光だまりをまとめて1つの InstancedMesh に。
 * list: [{ p:Vector3(中心), q:Quaternion(向き), sx, sy }] (板は XY 平面・法線+Z)
 * world 直下に足すので、700mマスごとの分割(_splitInstances)が自動でかかる */
const _m4 = new THREE.Matrix4(), _sc = new THREE.Vector3();
export function addPools(rs, list, mat) {
  if (!list.length) return null;
  const geo = new THREE.PlaneGeometry(1, 1);
  const im = new THREE.InstancedMesh(geo, mat, list.length);
  list.forEach((a, i) => {
    _sc.set(a.sx, a.sy, 1);
    _m4.compose(a.p, a.q, _sc);
    im.setMatrixAt(i, _m4);
  });
  im.renderOrder = 2;
  im.userData.st = true;
  im.computeBoundingSphere();
  rs.world.add(im);
  return im;
}
