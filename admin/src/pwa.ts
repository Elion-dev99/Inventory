/**
 * 全体管理コンソールの PWA 対応: ホーム画面に追加したときに
 * standalone で起動できるようにする。店舗アプリ (workers/src/pwa.ts) と
 * 同じ構成で、アイコンは admin 専用のもの (pwa-icons.ts) を使う。
 * コンソール側に Service Worker は無い (プッシュ購読は店舗アプリ側)。
 */
import { ICON_192, ICON_512, ICON_APPLE } from './pwa-icons';

export const PWA_HEAD = `
<link rel="manifest" href="/manifest.webmanifest">
<meta name="theme-color" content="#f5f5f7">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="default">
<meta name="apple-mobile-web-app-title" content="全体管理">
<link rel="apple-touch-icon" href="/icons/apple-touch-icon.png">
<link rel="icon" type="image/png" sizes="192x192" href="/icons/icon-192.png">
<link rel="icon" type="image/png" sizes="512x512" href="/icons/icon-512.png">`;

export const MANIFEST = {
  name: '在庫管理システム 全体管理',
  short_name: '全体管理',
  description: '在庫管理システムの全体管理コンソール',
  lang: 'ja',
  start_url: '/',
  scope: '/',
  display: 'standalone',
  background_color: '#12121a',
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
