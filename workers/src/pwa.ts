/**
 * PWA 対応: ホーム画面に追加するとブラウザのバー (×ボタン・URLバー・ツールバー)
 * の無いフルスクリーン (standalone) で起動できるようにする。
 * HTML 側は PWA_HEAD のメタ/リンクを <head> に入れる。
 */
import { ICON_192, ICON_512, ICON_APPLE } from './pwa-icons';

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
 * Web Push 用 Service Worker (/sw.js)。
 * push イベントで通知を表示し、クリックで /app を開く (既に開いていれば前面化)。
 * ペイロードは lib/push.ts が送る JSON ({ title, body, url, announcementId })。
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
