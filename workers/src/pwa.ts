/**
 * PWA 対応: ホーム画面に追加するとブラウザのバー (×ボタン・URLバー・ツールバー)
 * の無いフルスクリーン (standalone) で起動できるようにする。
 * HTML 側は PWA_HEAD のメタ/リンクを <head> に入れる。
 */
import { ICON_192, ICON_512, ICON_APPLE } from './pwa-icons';
import { APP_SHELL_CACHE } from './app/assets';

export const PWA_HEAD = `
<link rel="manifest" href="/manifest.webmanifest">
<meta name="theme-color" content="#f5f5f7">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="default">
<meta name="apple-mobile-web-app-title" content="在庫管理">
<link rel="apple-touch-icon" href="/icons/apple-touch-icon.png">
<link rel="icon" type="image/png" sizes="192x192" href="/icons/icon-192.png">
<link rel="icon" type="image/png" sizes="512x512" href="/icons/icon-512.png">`;

export const MANIFEST = {
  name: '在庫管理システム',
  short_name: '在庫管理',
  description: '社内向け在庫管理システム (入庫・消費・移動・棚卸し)',
  lang: 'ja',
  start_url: '/app',
  scope: '/',
  display: 'standalone',
  background_color: '#f5f5f7',
  theme_color: '#f5f5f7',
  icons: [
    { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
    { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
    { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
  ],
};

function pngResponse(b64: string): Response {
  const bytes = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
  return new Response(bytes, {
    headers: {
      'Content-Type': 'image/png',
      'Cache-Control': 'public, max-age=86400',
    },
  });
}

export function manifestResponse(): Response {
  return new Response(JSON.stringify(MANIFEST), {
    headers: {
      'Content-Type': 'application/manifest+json; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
    },
  });
}

export function iconResponse(name: string): Response | null {
  if (name === 'icon-192.png') return pngResponse(ICON_192);
  if (name === 'icon-512.png') return pngResponse(ICON_512);
  if (name === 'apple-touch-icon.png') return pngResponse(ICON_APPLE);
  return null;
}

/**
 * Service Worker (/sw.js)。
 * - push: 通知を表示し、クリックで /app を開く (既に開いていれば前面化)。
 *   ペイロードは lib/push.ts が送る JSON ({ title, body, url, announcementId })。
 * - fetch: アプリシェル (/app HTML とハッシュ付きアセット、アイコン) を
 *   キャッシュして起動を速くする。API はキャッシュしない。
 */
export const SERVICE_WORKER_JS = `self.addEventListener('push', function (event) {
  var data = {};
  if (event.data) {
    try { data = event.data.json(); } catch (e) { data = { title: 'お知らせ', body: event.data.text() }; }
  }
  var title = data.title || 'お知らせ';
  var options = {
    body: data.body || '',
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    tag: data.announcementId ? 'announcement-' + data.announcementId : 'announcement',
    data: { url: data.url || '/app', announcementId: data.announcementId || null }
  };
  event.waitUntil(self.registration.showNotification(title, options));
});
var SHELL_CACHE = '${APP_SHELL_CACHE}';
self.addEventListener('install', function (event) {
  self.skipWaiting();
});
self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) {
        return k.indexOf('app-shell-') === 0 && k !== SHELL_CACHE ? caches.delete(k) : Promise.resolve();
      }));
    }).then(function () { return self.clients.claim(); })
  );
});
self.addEventListener('fetch', function (event) {
  var req = event.request;
  if (req.method !== 'GET') return;
  var url;
  try { url = new URL(req.url); } catch (e) { return; }
  if (url.origin !== self.location.origin) return;
  var isAsset = url.pathname.indexOf('/assets/app.') === 0 || url.pathname.indexOf('/icons/') === 0;
  if (isAsset) {
    /* ハッシュ付きアセットとアイコンはキャッシュ優先 (無ければ取得して保存) */
    event.respondWith(
      caches.open(SHELL_CACHE).then(function (cache) {
        return cache.match(req).then(function (hit) {
          if (hit) return hit;
          return fetch(req).then(function (res) {
            if (res.ok) cache.put(req, res.clone());
            return res;
          });
        });
      })
    );
    return;
  }
  if (url.pathname === '/app') {
    /* シェル HTML はキャッシュを即返し、裏で最新を取り直す (次回起動に反映) */
    event.respondWith(
      caches.open(SHELL_CACHE).then(function (cache) {
        var network = fetch(req).then(function (res) {
          if (res.ok) cache.put(req, res.clone());
          return res;
        });
        event.waitUntil(network.catch(function () {}));
        return cache.match(req).then(function (hit) { return hit || network; });
      })
    );
  }
  /* API などそれ以外は通常どおりネットワーク (キャッシュしない) */
});
self.addEventListener('notificationclick', function (event) {
  event.notification.close();
  var target = (event.notification.data && event.notification.data.url) || '/app';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
      for (var i = 0; i < list.length; i++) {
        if (list[i].url.indexOf('/app') !== -1 && 'focus' in list[i]) return list[i].focus();
      }
      if (clients.openWindow) return clients.openWindow(target);
      return undefined;
    })
  );
});
`;

export function serviceWorkerResponse(): Response {
  return new Response(SERVICE_WORKER_JS, {
    headers: {
      'Content-Type': 'text/javascript; charset=utf-8',
      'Cache-Control': 'no-cache',
    },
  });
}
