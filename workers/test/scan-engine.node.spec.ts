import { beforeAll, describe, expect, it } from 'vitest';
import { prepareZXingModule, readBarcodes, ZXING_WASM_SHA256 } from 'zxing-wasm/reader';
import { writeBarcode } from 'zxing-wasm/writer';
import { APP_JS } from '../src/app/client';
import { SCAN_WASM_BYTE_LENGTH, SCAN_WASM_SHA256, scanWasmBytes } from '../src/scan-assets';
import { SCAN_WORKER_JS } from '../src/scan-worker';
import {
  barcodeCandidates,
  createScanCounter,
  createScanGate,
  createUnknownLatch,
  pickScanCountLine,
  type ScanCountLine,
} from '../src/lib/scan-core';

/**
 * バーコードスキャンの検証 (Node 環境):
 * - 内包した wasm バイナリ (src/scan-assets.ts) が正品で、実際にデコードできる
 * - 生成した EAN-13 (JAN) / EAN-8 / Code128 / Code39 / QR / UPC-A 画像の静的デコード
 * - 検証ゲート・対象行選択・集計 (src/lib/scan-core.ts) のロジック
 * - APP_JS の構文 (new Function) と旧デコーダ撤去の確認
 */

const FORMATS = ['EAN13', 'EAN8', 'UPCA', 'UPCE', 'Code128', 'Code39', 'QRCode'] as const;

beforeAll(async () => {
  const bytes = scanWasmBytes();
  const binary = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  // 配信する wasm そのものでエンジンを初期化する (CDN や node_modules の
  // バイナリへ差し替わっていたら、この時点でデコードが失敗して検出できる)
  await prepareZXingModule({ overrides: { wasmBinary: binary }, fireImmediately: true });
});

describe('内包 wasm アセットの完全性', () => {
  it('SHA-256 が zxing-wasm 公式定数と一致する', async () => {
    const hash = await crypto.subtle.digest('SHA-256', scanWasmBytes());
    const digest = Array.from(new Uint8Array(hash))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    expect(digest).toBe(SCAN_WASM_SHA256);
    expect(digest).toBe(ZXING_WASM_SHA256);
    expect(scanWasmBytes().length).toBe(SCAN_WASM_BYTE_LENGTH);
    // wasm マジックナンバー
    expect(Array.from(scanWasmBytes().slice(0, 4))).toEqual([0x00, 0x61, 0x73, 0x6d]);
  });

  it('ワーカースクリプトが正しいアセットとキャッシュ名を参照する', () => {
    expect(SCAN_WORKER_JS).toContain('zxing_reader.wasm');
    expect(SCAN_WORKER_JS).toContain('scan-engine-3.1.6');
    expect(SCAN_WORKER_JS).toContain('readBarcodes');
  });
});

describe('エンジンの静的デコード (生成画像 → 期待値)', () => {
  const cases: Array<{ text: string; format: string; wantFormat: string; wantText?: string }> = [
    { text: '4901234567894', format: 'EAN13', wantFormat: 'EAN13' },
    { text: '12345670', format: 'EAN8', wantFormat: 'EAN8' },
    { text: 'CODE128-TEST-123', format: 'Code128', wantFormat: 'Code128' },
    { text: 'CODE39-TEST', format: 'Code39', wantFormat: 'Code39' },
    { text: 'https://example.com/QR-TEST', format: 'QRCode', wantFormat: 'QRCode' },
    // UPC-A は ZXing が EAN-13 (先頭 0) として返す
    { text: '012345678905', format: 'UPCA', wantFormat: 'EAN13', wantText: '0012345678905' },
  ];
  for (const c of cases) {
    it(`${c.format} をデコードできる`, async () => {
      const out = await writeBarcode(c.text, {
        format: c.format as never,
      });
      expect(out.error).toBe('');
      expect(out.image).not.toBeNull();
      const results = await readBarcodes(out.image as Blob, {
        formats: [...FORMATS],
        tryHarder: true,
      });
      expect(results.length).toBe(1);
      expect(results[0]?.text).toBe(c.wantText ?? c.text);
      expect(results[0]?.format).toBe(c.wantFormat);
      expect(results[0]?.isValid).toBe(true);
    });
  }
});

describe('検証ゲート (createScanGate)', () => {
  it('高精度モードは同じ値の連続 2 回で受理する', () => {
    const gate = createScanGate('accurate');
    expect(gate.consider('A', 0)).toBe(false);
    expect(gate.consider('B', 40)).toBe(false); // 値が変わると数え直し
    expect(gate.consider('B', 80)).toBe(true);
  });

  it('受理後 900ms は同一コードを抑制し、別コードは即座に数えられる', () => {
    const gate = createScanGate('accurate');
    expect(gate.consider('A', 0)).toBe(false);
    expect(gate.consider('A', 50)).toBe(true); // 受理 (t=50)
    expect(gate.consider('A', 500)).toBe(false); // 抑制中 (検証も進まない)
    expect(gate.consider('B', 600)).toBe(false); // 別コードは検証 1 回目
    expect(gate.consider('B', 650)).toBe(true); // 別コードは抑制対象外で受理
    expect(gate.consider('A', 1000)).toBe(false); // A は前回受理から 950ms 経過 → 再検証 1 回目
    expect(gate.consider('A', 1050)).toBe(true);
  });

  it('高速モードは 1 回で受理し、抑制は同じ', () => {
    const gate = createScanGate('fast');
    expect(gate.consider('A', 0)).toBe(true);
    expect(gate.consider('A', 100)).toBe(false);
    expect(gate.consider('B', 100)).toBe(true);
    expect(gate.consider('A', 950)).toBe(true);
  });

  it('モード切替で検証の途中経過はリセットされる', () => {
    const gate = createScanGate('accurate');
    expect(gate.consider('A', 0)).toBe(false);
    gate.setMode('fast');
    expect(gate.consider('A', 10)).toBe(true);
    gate.setMode('accurate');
    expect(gate.consider('B', 2000)).toBe(false);
  });
});

describe('バーコード候補 (UPC-A ⇔ EAN-13)', () => {
  it('JAN (EAN-13) はそのままのみ', () => {
    expect(barcodeCandidates('4901234567894')).toEqual(['4901234567894']);
  });
  it('EAN-13 (先頭 0) から UPC-A 形式を候補に足す', () => {
    expect(barcodeCandidates('0012345678905')).toEqual(['0012345678905', '012345678905']);
  });
  it('UPC-A (12 桁) から EAN-13 形式を候補に足す', () => {
    expect(barcodeCandidates('012345678905')).toEqual(['012345678905', '0012345678905']);
  });
  it('英数字コードはそのまま', () => {
    expect(barcodeCandidates('SKU-001')).toEqual(['SKU-001']);
  });
});

describe('棚卸しスキャンカウントの対象行選択 (pickScanCountLine)', () => {
  const lines: ScanCountLine[] = [
    { id: 10, productId: 1, locationId: 1, expiryDate: '2027-01-01', countedQuantity: null },
    { id: 11, productId: 1, locationId: 1, expiryDate: '2026-06-01', countedQuantity: null },
    { id: 12, productId: 1, locationId: 1, expiryDate: null, countedQuantity: null },
    { id: 13, productId: 1, locationId: 2, expiryDate: '2025-01-01', countedQuantity: null },
    { id: 14, productId: 2, locationId: 1, expiryDate: '2025-06-01', countedQuantity: null },
  ];
  it('複数ロットでは最も期限が早い行を選ぶ (期限なしは最後)', () => {
    expect(pickScanCountLine(lines, 1, 1)?.id).toBe(11);
  });
  it('場所が違えばその場所の行を選ぶ', () => {
    expect(pickScanCountLine(lines, 1, 2)?.id).toBe(13);
  });
  it('対象外の商品 × 場所は null (加算しない)', () => {
    expect(pickScanCountLine(lines, 2, 2)).toBeNull();
    expect(pickScanCountLine(lines, 99, 1)).toBeNull();
  });
  it('同期限では行 ID の小さい方', () => {
    const tie: ScanCountLine[] = [
      { id: 22, productId: 1, locationId: 1, expiryDate: '2026-01-01', countedQuantity: null },
      { id: 21, productId: 1, locationId: 1, expiryDate: '2026-01-01', countedQuantity: null },
    ];
    expect(pickScanCountLine(tie, 1, 1)?.id).toBe(21);
  });
});

describe('スキャンカウントの集計 (createScanCounter)', () => {
  const lines: ScanCountLine[] = [
    { id: 1, productId: 1, locationId: 1, expiryDate: '2026-06-01', countedQuantity: null },
    { id: 2, productId: 1, locationId: 1, expiryDate: '2027-01-01', countedQuantity: 5 },
    { id: 3, productId: 2, locationId: 1, expiryDate: null, countedQuantity: 2 },
  ];
  it('+1 加算は期限の早い行へ入り、合計と未保存分が追える', () => {
    const counter = createScanCounter(lines);
    expect(counter.increment(1, 1)?.line.id).toBe(1);
    expect(counter.increment(1, 1)?.counted).toBe(2);
    expect(counter.increment(2, 1)?.counted).toBe(3); // 既存実数 2 + 1
    expect(counter.totalsByProduct().get(1)).toBe(2);
    expect(counter.totalsByProduct().get(2)).toBe(1);
    expect(counter.totalCount()).toBe(3);
    const pending = counter.pendingValues();
    expect(pending.get(1)).toBe(2);
    expect(pending.get(3)).toBe(3);
    counter.markSaved(1, 2);
    expect(counter.pendingValues().has(1)).toBe(false);
    expect(counter.pendingValues().get(3)).toBe(3);
  });
  it('対象外は加算されず null が返る', () => {
    const counter = createScanCounter(lines);
    expect(counter.increment(1, 2)).toBeNull();
    expect(counter.increment(99, 1)).toBeNull();
    expect(counter.totalCount()).toBe(0);
    expect(counter.pendingValues().size).toBe(0);
  });
  it('未入力の行への加算を取り消すと未入力へ戻る (未保存の場合)', () => {
    const counter = createScanCounter(lines);
    counter.increment(1, 1);
    expect(counter.decrement(1)).toBeNull();
    expect(counter.countedOf(1)).toBeNull();
    expect(counter.pendingValues().size).toBe(0);
    expect(counter.totalCount()).toBe(0);
  });
  it('保存済みの行の取り消しは 0 まで戻して未保存として残る', () => {
    const counter = createScanCounter(lines);
    counter.increment(1, 1);
    counter.markSaved(1, 1);
    expect(counter.decrement(1)).toBe(0);
    expect(counter.pendingValues().get(1)).toBe(0);
  });
});

describe('未登録コード通知のラッチ (createUnknownLatch)', () => {
  it('未登録は表示し、同じコードの再通知は抑制する', () => {
    const latch = createUnknownLatch();
    expect(latch.notify('4901330407247', 'unknown')).toBe('show');
    expect(latch.latchedCode()).toBe('4901330407247');
    // カメラが同じコードを繰り返しデコードしても再通知しない
    expect(latch.notify('4901330407247', 'unknown')).toBe('suppress');
    expect(latch.notify('4901330407247', 'unknown')).toBe('suppress');
    expect(latch.latchedCode()).toBe('4901330407247');
  });

  it('別の未登録コードは表示し直し、ラッチを差し替える', () => {
    const latch = createUnknownLatch();
    expect(latch.notify('111', 'unknown')).toBe('show');
    expect(latch.notify('222', 'unknown')).toBe('show');
    expect(latch.latchedCode()).toBe('222');
    expect(latch.notify('222', 'unknown')).toBe('suppress');
  });

  it('次の受理 (ok / out) でラッチが解除され、同じコードも再び通知できる', () => {
    const latch = createUnknownLatch();
    expect(latch.notify('111', 'unknown')).toBe('show');
    expect(latch.notify('999', 'ok')).toBe('clear');
    expect(latch.latchedCode()).toBeNull();
    expect(latch.notify('111', 'unknown')).toBe('show');
    expect(latch.notify('999', 'out')).toBe('clear');
    // ラッチが無い状態の受理では何もしない
    expect(latch.notify('999', 'ok')).toBe('none');
    expect(latch.notify('999', 'out')).toBe('none');
  });

  it('reset でラッチが消える', () => {
    const latch = createUnknownLatch();
    latch.notify('111', 'unknown');
    latch.reset();
    expect(latch.latchedCode()).toBeNull();
    expect(latch.notify('111', 'unknown')).toBe('show');
  });
});

describe('APP_JS (スキャナー作り替えの確認)', () => {
  it('構文が正しく、旧デコーダ経路が撤去されている', () => {
    expect(() => new Function(APP_JS)).not.toThrow();
    expect(APP_JS).not.toContain('BarcodeDetector');
    expect(APP_JS).not.toContain('detector.detect');
    expect(APP_JS).toContain('/assets/scan/worker.js');
    expect(APP_JS).toContain('function scanHandleDecoded');
    expect(APP_JS).toContain('function openStocktakeScanner');
    expect(APP_JS).toContain('function openSheetScanner');
  });

  it('未登録の通知はラッチで保持し、フレームごとに消さない', () => {
    expect(APP_JS).toContain('function scanUnknownLatchCreate');
    expect(APP_JS).toContain('unknownLatch: scanUnknownLatchCreate()');
    const start = APP_JS.indexOf('function scanHandleDecoded');
    const body = APP_JS.slice(start, APP_JS.indexOf('function stopScanStream', start));
    // ゲート判定より前に通知を消していたのがフリッカーの原因だった
    expect(body).not.toContain('hideScanUnknown();\n  if (!session.gate.consider');
    expect(body).toContain('session.gate.consider');
    expect(body).toContain('session.unknownLatch.notify');
    // 通知の表示はラッチの 'show' のときだけ、'suppress' では何もしない
    expect(body).toContain("act === 'show'");
    expect(body).toContain("act !== 'suppress'");
  });

  it('登録ボタンが復帰文脈を保存し、各文脈が registerReturn を渡す', () => {
    expect(APP_JS).toContain('pendingProductReturn = session.opts.registerReturn || null');
    expect(APP_JS).toContain("registerReturn: viewName ? { view: viewName } : null");
    expect(APP_JS).toContain("registerReturn: returnView ? { view: returnView } : null");
    expect(APP_JS).toContain("openStockCheckScanner('stocks')");
    expect(APP_JS).toContain("openStockCheckScanner('dashboard')");
    expect(APP_JS).toContain("registerReturn: { view: 'stocktakes' }");
    expect(APP_JS).toContain("openSheetScanner('inProduct', 'inQty', 'inbound')");
    expect(APP_JS).toContain("openSheetScanner('coProduct', 'coQty', 'consume')");
    expect(APP_JS).toContain("openSheetScanner('trProduct', 'trQty', 'transfer')");
  });

  it('商品作成後の復帰 (プリセットで記録シートへ、検索は SKU 絞り込み) が配線されている', () => {
    expect(APP_JS).toContain('productReturn = pendingProductReturn');
    expect(APP_JS).toContain('saveFormPreset(ret.view, { productId: res.id })');
    expect(APP_JS).toContain("sessionStorage.setItem('pendingStockQuery', res.sku || '')");
    expect(APP_JS).toContain("showView('stocktakes')");
  });

  it('パネルの空表示が未登録ラッチと矛盾しない文言に切り替わる', () => {
    expect(APP_JS).toContain('function scanEmptyHtml');
    expect(APP_JS).toContain('session.opts.renderPanel(session)');
    expect(APP_JS).toContain('return scanEmptyHtml(sess);');
  });
});
