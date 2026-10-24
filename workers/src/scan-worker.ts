/**
 * バーコードスキャン用 Web Worker のスクリプト (/assets/scan/worker.js で配信)。
 *
 * モジュールワーカーとして起動され、zxing-wasm の reader glue を相対 import する
 * (./es/reader/index.js → ../share.js)。wasm バイナリは Cache Storage に
 * キャッシュしてから wasmBinary として渡すため、2 回目以降は即時に初期化できる。
 * メインスレッドとは { type: 'init' } / { type: 'decode', id, buffer, width, height }
 * のメッセージでやり取りし、デコード結果は { type: 'result', id, results } で返す。
 *
 * テンプレート文字列として埋め込むため、本文ではバッククォート・補間記法・
 * バックスラッシュ付きエスケープを使わない (文字列連結で書く)。
 */
export const SCAN_WORKER_JS = `'use strict';
import { readBarcodes, prepareZXingModule } from './es/reader/index.js';

var SCAN_FORMATS = ['EAN13', 'EAN8', 'UPCA', 'UPCE', 'Code128', 'Code39', 'QRCode'];
var WASM_URL = '/assets/scan/zxing_reader.wasm';
var CACHE_NAME = 'scan-engine-3.1.6';
var readyPromise = null;

function loadWasmBinary() {
  function fetchFresh() {
    return fetch(WASM_URL).then(function (res) {
      if (!res.ok) throw new Error('wasm fetch failed: ' + res.status);
      return res.arrayBuffer();
    });
  }
  if (typeof caches === 'undefined') return fetchFresh();
  return caches.open(CACHE_NAME).then(function (cache) {
    return cache.match(WASM_URL).then(function (hit) {
      if (hit) return hit.arrayBuffer();
      return fetch(WASM_URL).then(function (res) {
        if (!res.ok) throw new Error('wasm fetch failed: ' + res.status);
        return cache.put(WASM_URL, res.clone()).catch(function () {}).then(function () {
          return res.arrayBuffer();
        });
      });
    });
  }).catch(function () { return fetchFresh(); });
}

function ensureReady() {
  if (!readyPromise) {
    readyPromise = loadWasmBinary().then(function (buf) {
      return prepareZXingModule({ overrides: { wasmBinary: buf }, fireImmediately: true });
    }).then(function () {
      self.postMessage({ type: 'ready' });
    }).catch(function (e) {
      readyPromise = null;
      self.postMessage({ type: 'error', message: String((e && e.message) || e) });
    });
  }
  return readyPromise;
}

self.onmessage = function (ev) {
  var msg = ev.data || {};
  if (msg.type === 'init') {
    ensureReady();
    return;
  }
  if (msg.type === 'decode') {
    if (!readyPromise) {
      self.postMessage({ type: 'result', id: msg.id, results: [] });
      return;
    }
    readyPromise.then(function () {
      var img = new ImageData(new Uint8ClampedArray(msg.buffer), msg.width, msg.height);
      return readBarcodes(img, {
        formats: SCAN_FORMATS,
        maxNumberOfSymbols: 1,
        tryHarder: false
      });
    }).then(function (results) {
      var out = [];
      for (var i = 0; i < results.length; i++) {
        if (results[i].text) out.push({ text: results[i].text, format: results[i].format });
      }
      self.postMessage({ type: 'result', id: msg.id, results: out });
    }).catch(function () {
      self.postMessage({ type: 'result', id: msg.id, results: [] });
    });
  }
};
`;
