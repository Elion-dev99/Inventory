/**
 * バーコードスキャンエンジン (zxing-wasm) の配信アセットを生成する。
 *
 * 実行: npm run gen:scan-assets
 *
 * 本番デプロイは Worker 本体 (index.js) の単一モジュールアップロードのため、
 * CDN 等の外部配信に頼らず、エンジンの glue JS と wasm バイナリを
 * src/scan-assets.ts に文字列 / base64 として埋め込んで Worker 自身が配信する。
 * - glue JS: zxing-wasm/dist/es/{share.js, reader/index.js} (ESM、相対 import を保持)
 * - wasm:    zxing-wasm/dist/reader/zxing_reader.wasm (base64、実行時に復元)
 *
 * バージョンを上げる場合は zxing-wasm を更新してこのスクリプトを再実行し、
 * src/scan-worker.ts の Cache Storage 名 (scan-engine-<version>) も合わせること。
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkgDir = join(root, 'node_modules', 'zxing-wasm');
const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));

const shareJs = readFileSync(join(pkgDir, 'dist', 'es', 'share.js'), 'utf8');
const readerJs = readFileSync(join(pkgDir, 'dist', 'es', 'reader', 'index.js'), 'utf8');
const wasmBytes = readFileSync(join(pkgDir, 'dist', 'reader', 'zxing_reader.wasm'));

const sha256 = createHash('sha256').update(wasmBytes).digest('hex');
const declared = /"([0-9a-f]{64})"/.exec(readerJs)?.[1];
if (declared !== sha256) {
  throw new Error(`wasm SHA-256 mismatch: file=${sha256} glue=${declared ?? '(not found)'}`);
}

const b64 = wasmBytes.toString('base64');
const CHUNK = 32768;
const parts = [];
for (let i = 0; i < b64.length; i += CHUNK) parts.push(b64.slice(i, i + CHUNK));

const out = `/**
 * バーコードスキャンエンジンの配信アセット (生成ファイル — 直接編集しない)。
 * 生成: npm run gen:scan-assets (scripts/gen-scan-assets.mjs)
 *
 * zxing-wasm ${pkg.version} (ZXing-C++ の WebAssembly 移植、Apache-2.0)。
 * 本番デプロイが単一モジュール (index.js) の API アップロードのため、
 * エンジンを外部 CDN に置かず Worker 自身が /assets/scan/* で配信する。
 * wasm は base64 で内包し、初回アクセス時に復元してモジュール内にキャッシュする。
 */
export const SCAN_ENGINE_NAME = 'zxing-wasm';
export const SCAN_ENGINE_VERSION = '${pkg.version}';
/** zxing_reader.wasm の SHA-256 (glue 側の ZXING_WASM_SHA256 と一致を生成時に検証) */
export const SCAN_WASM_SHA256 = '${sha256}';
export const SCAN_WASM_BYTE_LENGTH = ${wasmBytes.length};

/** zxing-wasm/dist/es/share.js (reader glue の共有チャンク) */
export const SCAN_SHARE_JS = ${JSON.stringify(shareJs)};

/** zxing-wasm/dist/es/reader/index.js (../share.js を相対 import する) */
export const SCAN_READER_JS = ${JSON.stringify(readerJs)};

const SCAN_WASM_BASE64_PARTS: readonly string[] = [
${parts.map((p) => `  ${JSON.stringify(p)},`).join('\n')}
];

let cachedWasmBytes: Uint8Array | null = null;

/** 内包した base64 から wasm バイナリを復元する (初回のみ復元し以後は再利用) */
export function scanWasmBytes(): Uint8Array {
  if (cachedWasmBytes) return cachedWasmBytes;
  const b64 = SCAN_WASM_BASE64_PARTS.join('');
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  if (bytes.length !== SCAN_WASM_BYTE_LENGTH) {
    throw new Error('scan wasm size mismatch: ' + bytes.length);
  }
  cachedWasmBytes = bytes;
  return bytes;
}
`;

writeFileSync(join(root, 'src', 'scan-assets.ts'), out);
console.log(
  `scan-assets.ts generated: zxing-wasm ${pkg.version}, wasm ${wasmBytes.length} bytes, sha256 ${sha256}`,
);
