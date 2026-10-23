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
