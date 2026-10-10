/* =========================================================
 * sw.js — オフライン対応(ホーム画面に追加したiPadで、電波がなくても遊べる)
 * 初回にゲーム一式(約10MB)を保存し、以後は保存分をすぐ返しつつ裏で更新する。
 * 公開のたびに VERSION を上げると古い保存分は消える。
 * ========================================================= */
const VERSION = 'trainop-v3-001';
const CORE = [
  './', './index.html', './styles.css', './main.js', './manifest.webmanifest',
  './sim/engine.js', './sim/kana.js', './sim/line.js', './sim/autopilot.js',
  './scene/scene.js', './scene/cockpit.js', './scene/traffic.js', './scene/trains.js', './scene/weatherfx.js',
  './scene/look.js', './scene/town.js', './scene/facade.js', './scene/trackbed.js',
  './scene/stations.js', './scene/signage.js', './scene/lightpool.js',
  './cab/cab.js', './audio/audio.js', './audio/announce.js', './audio/vvvf-worklet.js',
  './ui/stamps.js', './ui/rainglass.js', './ui/badges.js', './ui/icons.js',
  './vendor/three.module.min.js', './vendor/RGBELoader.js',
  './vendor/addons/EffectComposer.js', './vendor/addons/RenderPass.js', './vendor/addons/UnrealBloomPass.js',
  './vendor/addons/OutputPass.js', './vendor/addons/ShaderPass.js', './vendor/addons/Pass.js', './vendor/addons/MaskPass.js',
  './vendor/addons/CopyShader.js', './vendor/addons/LuminosityHighPassShader.js', './vendor/addons/OutputShader.js', './vendor/addons/Sky.js',
  './data/line.json', './data/timetable.json',
  './assets/favicon.svg', './assets/icon-180.png', './assets/icon-192.png', './assets/icon-512.png',
  './assets/tex/gravel_c.jpg', './assets/tex/gravel_n.jpg', './assets/tex/grass_c.jpg', './assets/tex/grass_n.jpg',
  './assets/tex/concrete_c.jpg', './assets/tex/concrete_n.jpg',
  './assets/sky/sky_clear.hdr', './assets/sky/sky_overcast.hdr',
];

self.addEventListener('install', (ev) => {
  ev.waitUntil((async () => {
    const c = await caches.open(VERSION);
    /* 1つ失敗しても残りは保存する */
    await Promise.allSettled(CORE.map((u) => c.add(new Request(u, { cache: 'reload' }))));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (ev) => {
  ev.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (ev) => {
  const req = ev.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const sameOrigin = url.origin === self.location.origin;
  const isFont = /fonts\.(googleapis|gstatic)\.com$/.test(url.hostname);
  if (!sameOrigin && !isFont) return;
  /* 保存分をすぐ返し、裏で新しいものを取りに行く(stale-while-revalidate) */
  ev.respondWith((async () => {
    const c = await caches.open(VERSION);
    const hit = await c.match(req, { ignoreSearch: sameOrigin });
    const net = fetch(req).then((res) => {
      if (res && (res.ok || res.type === 'opaque')) c.put(req, res.clone());
      return res;
    }).catch(() => null);
    if (hit) { ev.waitUntil(net); return hit; }
    const res = await net;
    return res || new Response('offline', { status: 503 });
  })());
});
