/* =========================================================
 * tools/train-viewer.js — 車両キット(scene/trains.js)の見た目確認ビューア
 * 本番シーンと同じHDRI・ACESトーンマップで、まっすぐな線路に8両編成を置く。
 * URL: ?view=front|front2|side|rear|chase|top|bogie  &night=1  &q=high|mid|low
 *      &cars=8  &b=0(となりの編成を消す)  &shot=1(文字を隠す)
 *      &cam=x,y,z,tx,ty,tz(カメラ直接指定)  &fov=40
 * ドラッグで回転・ホイールで寄る。window.__stats() で両ごとの描画数を返す。
 * ========================================================= */
/* importmapは使わない(古いiPadのSafari対策: 相対パスで読み込む) */
import * as THREE from '../vendor/three.module.min.js';
import { RGBELoader } from '../vendor/RGBELoader.js';
import { TrainKit, CAR_LEN } from '../scene/trains.js';

const qs = new URLSearchParams(location.search);
const NIGHT = qs.get('night') === '1';
const QUALITY = qs.get('q') || 'high';
const NCARS = Math.max(1, parseInt(qs.get('cars') || '8', 10));
const VIEW = qs.get('view') || 'front';
const GAUGE = 1.067;
if (qs.get('shot') === '1') document.body.classList.add('shot');

const canvas = document.getElementById('c');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = NIGHT ? 0.9 : 1.08;
renderer.shadowMap.enabled = QUALITY !== 'low';
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();
scene.background = new THREE.Color(NIGHT ? 0x0a0f16 : 0xa8c4dd);
scene.fog = NIGHT ? new THREE.Fog(0x0c1119, 180, 1050) : new THREE.Fog(0xcfd9e2, 300, 1500);
const camera = new THREE.PerspectiveCamera(40, 16 / 9, 0.1, 3000);

/* ---- 光(scene.jsと同じ値) ---- */
const hemi = new THREE.HemisphereLight(0xbfd0e0, 0x6a6f64, NIGHT ? 0.14 : 0.45);
scene.add(hemi);
const sun = new THREE.DirectionalLight(NIGHT ? 0xa8bcd8 : 0xfff0da, NIGHT ? 0.32 : 2.8);
const sunDir = new THREE.Vector3(0.85, 0.55, -0.1).normalize();
sun.castShadow = renderer.shadowMap.enabled;
sun.shadow.mapSize.set(4096, 4096);
const sc = sun.shadow.camera;
sc.left = -70; sc.right = 70; sc.top = 70; sc.bottom = -70; sc.near = 10; sc.far = 600;
sun.shadow.bias = -0.00015;
sun.shadow.normalBias = 0.05;
scene.add(sun, sun.target);

/* ---- HDRI ---- */
const pmrem = new THREE.PMREMGenerator(renderer);
let envReady = false;
/* 夜の空のHDRIは本体と同じく使わない(夜空は手続き生成)。夜は背景を濃紺にする */
new RGBELoader().load('../assets/sky/sky_clear.hdr', (t) => {
  t.mapping = THREE.EquirectangularReflectionMapping;
  scene.background = NIGHT ? new THREE.Color(0x0b1424) : t;
  /* r160 には scene.environmentIntensity がないので、夜は環境光を付けない */
  scene.environment = NIGHT ? null : pmrem.fromEquirectangular(t).texture;
  envReady = true;
}, undefined, (e) => { console.error('HDR load failed', e); envReady = true; });

/* ---- 地面・線路 ---- */
const tl = new THREE.TextureLoader();
const tex = (url, rx, ry, srgb = true) => {
  const t = tl.load(url);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(rx, ry);
  t.anisotropy = 8;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  return t;
};
const ground = new THREE.Mesh(new THREE.PlaneGeometry(1200, 1200),
  new THREE.MeshStandardMaterial({ map: tex('../assets/tex/grass_c.jpg', 160, 160), color: 0x9a9a88, roughness: 1 }));
ground.rotation.x = -Math.PI / 2;
ground.position.y = -0.62;
ground.receiveShadow = true;
scene.add(ground);

const ballastMat = new THREE.MeshStandardMaterial({
  map: tex('../assets/tex/gravel_c.jpg', 2, 120), normalMap: tex('../assets/tex/gravel_n.jpg', 2, 120, false),
  color: 0xaaa59b, roughness: 1,
});
const sleeperMat = new THREE.MeshStandardMaterial({ color: 0x7a766e, roughness: 0.95 });
const railHead = new THREE.MeshStandardMaterial({ color: 0xd8dadd, metalness: 1, roughness: 0.3 });
const railWeb = new THREE.MeshStandardMaterial({ color: 0x6b5c4d, metalness: 0.35, roughness: 0.9 });
const TRACK_LEN = 420, TRACK_Z = -150;
function addTrack(x) {
  const bed = new THREE.Mesh(new THREE.BoxGeometry(3.4, 0.4, TRACK_LEN), ballastMat);
  bed.position.set(x, -0.42, TRACK_Z);
  bed.receiveShadow = true;
  scene.add(bed);
  const n = Math.floor(TRACK_LEN / 0.6);
  const sl = new THREE.InstancedMesh(new THREE.BoxGeometry(2.0, 0.14, 0.22), sleeperMat, n);
  const m = new THREE.Matrix4();
  for (let i = 0; i < n; i++) { m.makeTranslation(x, -0.215, TRACK_Z - TRACK_LEN / 2 + i * 0.6); sl.setMatrixAt(i, m); }
  sl.receiveShadow = true;
  scene.add(sl);
  [-1, 1].forEach((sd) => {
    const rx = x + sd * (GAUGE / 2 + 0.032);
    const head = new THREE.Mesh(new THREE.BoxGeometry(0.065, 0.045, TRACK_LEN), railHead);
    head.position.set(rx, -0.0225, TRACK_Z); head.receiveShadow = true; scene.add(head);
    const web = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.1, TRACK_LEN), railWeb);
    web.position.set(rx, -0.095, TRACK_Z); scene.add(web);
    const foot = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.02, TRACK_LEN), railWeb);
    foot.position.set(rx, -0.14, TRACK_Z); scene.add(foot);
  });
}
addTrack(0);
addTrack(-3.8);

/* ---- 電車 ---- */
const t0 = performance.now();
const kit = new TrainKit({ quality: QUALITY, gauge: GAUGE });
const tKit = performance.now() - t0;
kit.setNight(NIGHT);
const train = kit.makeTrain(NCARS, { dest: qs.get('dest') || '各停 新百合ヶ丘', kind: qs.get('kind') || 'local', numberBase: 1101 });
scene.add(train.group);
kit.setLights(train, { head: true, tail: true });

let trainB = null;
if (qs.get('b') !== '0') {
  /* となりの線: 逆向きに置いた6両(手前に尾灯、奥に前照灯が見える) */
  trainB = kit.makeTrain(6, { dest: '急行 小田原', kind: 'exp', numberBase: 3151 });
  trainB.group.position.set(-3.8, 0, -135);
  trainB.group.rotation.y = Math.PI;
  scene.add(trainB.group);
  kit.setLights(trainB, { head: true, tail: true });
}
const tBuild = performance.now() - t0;

/* ---- カメラ ---- */
const tailZ = -(NCARS - 1) * CAR_LEN;
const VIEWS = {
  front:  { p: [7.5, 2.6, 22], t: [0, 2.0, 3], fov: 40 },
  front2: { p: [0.4, 2.3, 30], t: [0, 2.0, 0], fov: 30 },
  side:   { p: [17, 2.0, -26], t: [0, 2.0, -26], fov: 40 },
  rear:   { p: [-7.5, 2.8, tailZ - 32], t: [0, 2.0, tailZ - 10], fov: 40 },
  chase:  { p: [3.5, 9.0, -36], t: [0, 2.5, 14], fov: 55 },
  chase2: { p: [-4.5, 8.5, tailZ - 34], t: [0, 2.2, tailZ + 6], fov: 55 },
  top:    { p: [14, 24, -52], t: [0, 2, -30], fov: 40 },
  bogie:  { p: [4.6, 1.1, 1.5], t: [0, 0.8, 7.0], fov: 45 },
  roof:   { p: [5.5, 7.5, -1], t: [0, 3.6, -16], fov: 45 },
};
const v = VIEWS[VIEW] || VIEWS.front;
const target = new THREE.Vector3(...v.t);
camera.position.set(...v.p);
camera.fov = parseFloat(qs.get('fov') || v.fov);
if (qs.get('cam')) {
  const c = qs.get('cam').split(',').map(Number);
  camera.position.set(c[0], c[1], c[2]);
  target.set(c[3], c[4], c[5]);
}
camera.lookAt(target);

/* かんたんなドラッグ回転・ホイール */
const sph = new THREE.Spherical().setFromVector3(camera.position.clone().sub(target));
let drag = null;
canvas.addEventListener('pointerdown', (e) => { drag = { x: e.clientX, y: e.clientY }; canvas.setPointerCapture(e.pointerId); });
canvas.addEventListener('pointermove', (e) => {
  if (!drag) return;
  sph.theta -= (e.clientX - drag.x) * 0.005;
  sph.phi = Math.min(Math.PI * 0.49, Math.max(0.05, sph.phi - (e.clientY - drag.y) * 0.005));
  drag = { x: e.clientX, y: e.clientY };
  camera.position.copy(target).add(new THREE.Vector3().setFromSpherical(sph));
  camera.lookAt(target);
});
canvas.addEventListener('pointerup', () => { drag = null; });
canvas.addEventListener('wheel', (e) => {
  sph.radius = Math.max(2, sph.radius * (e.deltaY > 0 ? 1.1 : 0.9));
  camera.position.copy(target).add(new THREE.Vector3().setFromSpherical(sph));
  camera.lookAt(target);
  e.preventDefault();
}, { passive: false });

/* 画面上の切替リンク */
const bar = document.getElementById('bar');
Object.keys(VIEWS).forEach((k) => {
  const a = document.createElement('a');
  const p = new URLSearchParams(qs); p.set('view', k); p.delete('cam');
  a.href = `?${p}`; a.textContent = k; bar.appendChild(a);
});
{
  const a = document.createElement('a');
  const p = new URLSearchParams(qs); p.set('night', NIGHT ? '0' : '1');
  a.href = `?${p}`; a.textContent = NIGHT ? 'day' : 'night'; bar.appendChild(a);
}

function resize() {
  const w = innerWidth, h = innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
addEventListener('resize', resize);
resize();

/* ---- 検証用 ---- */
window.__stats = () => ({
  quality: QUALITY,
  kitMs: Math.round(tKit), buildMs: Math.round(tBuild),
  cars: train.cars.map((c) => ({ n: c.userData.number, lead: c.userData.lead, tail: c.userData.tail, ...TrainKit.stats(c) })),
  frame: { calls: renderer.info.render.calls, tris: renderer.info.render.triangles },
  memory: { ...renderer.info.memory },
});
window.__kit = kit;
window.__train = train;

let frames = 0;
const info = document.getElementById('info');
function loop() {
  sun.target.position.copy(target);
  sun.position.copy(target).addScaledVector(sunDir, 300);
  renderer.render(scene, camera);
  frames++;
  if (frames === 3 || frames % 60 === 0) {
    const s = window.__stats();
    info.textContent = `q=${QUALITY} view=${VIEW}${NIGHT ? ' night' : ''}  kit ${s.kitMs}ms build ${s.buildMs}ms\n` +
      `frame: ${s.frame.calls} calls, ${s.frame.tris} tris\n` +
      s.cars.map((c) => `#${c.n}${c.lead ? ' lead' : ''}${c.tail ? ' tail' : ''}: ${c.calls} calls, ${c.tris} tris`).join('\n');
  }
  if (envReady && frames > 4) window.__ready = true;
  requestAnimationFrame(loop);
}
loop();
