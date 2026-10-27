import { APP_CSS } from './styles';
import { APP_JS } from './client';

/**
 * /app の CSS / JS を個別アセットとして配信するための URL とバージョン。
 * 内容から決まるハッシュをクエリに付け、変わらない限りブラウザと
 * Service Worker のキャッシュから即座に返るようにする (読み込み高速化)。
 * ハッシュはキャッシュバスティング専用で、暗号用途ではない。
 */
function contentHash(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(16).padStart(8, '0') + (h1 >>> 0).toString(16).padStart(8, '0');
}

export const APP_CSS_HASH = contentHash(APP_CSS);
export const APP_JS_HASH = contentHash(APP_JS);
export const APP_CSS_URL = '/assets/app.css?v=' + APP_CSS_HASH;
export const APP_JS_URL = '/assets/app.js?v=' + APP_JS_HASH;

/** Service Worker のアプリシェル用キャッシュ名 (アセットが変われば自動で切り替わる) */
export const APP_SHELL_CACHE = 'app-shell-' + APP_JS_HASH + '-' + APP_CSS_HASH;
