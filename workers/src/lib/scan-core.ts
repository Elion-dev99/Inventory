/**
 * バーコードスキャンの中核ロジック (純粋関数 — テスト対象)。
 *
 * ブラウザ側 (src/app/client.ts の APP_JS) は TS モジュールを import できないため
 * 同じ規則を ES5 で実装している。規則を変える場合は両方を揃えること:
 * - createScanGate ⇔ scanGateCreate (検証モードと重複抑制)
 * - createUnknownLatch ⇔ scanUnknownLatchCreate (未登録通知のラッチと再通知抑制)
 * - pickScanCountLine ⇔ scanPickLine (棚卸しスキャンカウントの対象行選択)
 * - barcodeCandidates ⇔ productByBarcode の候補展開 (UPC-A ⇔ EAN-13)
 */

/** 検証モード: accurate = 同じ値が連続 2 回一致したら受理 / fast = 1 回で受理 */
export type ScanVerifyMode = 'accurate' | 'fast';

/** 受理直後に同じコードを再受理しない抑制時間 (ms)。別コードは抑制対象外 */
export const SCAN_DUPLICATE_SUPPRESS_MS = 900;

export interface ScanGate {
  /** デコード結果を 1 件渡し、受理したら true を返す */
  consider: (code: string, nowMs: number) => boolean;
  setMode: (mode: ScanVerifyMode) => void;
  mode: () => ScanVerifyMode;
  reset: () => void;
}

export function createScanGate(initialMode: ScanVerifyMode): ScanGate {
  let mode = initialMode;
  let pendingCode: string | null = null;
  let pendingCount = 0;
  let lastCode: string | null = null;
  let lastAt = 0;

  function accept(code: string, nowMs: number): boolean {
    lastCode = code;
    lastAt = nowMs;
    pendingCode = null;
    pendingCount = 0;
    return true;
  }

  return {
    consider(code, nowMs) {
      if (!code) return false;
      // 受理直後の同一コードは抑制する (同じ商品を構えたまま二重に数えない)。
      // 抑制中は検証カウントも進めない。
      if (code === lastCode && nowMs - lastAt < SCAN_DUPLICATE_SUPPRESS_MS) return false;
      if (mode === 'fast') return accept(code, nowMs);
      if (code === pendingCode) pendingCount += 1;
      else {
        pendingCode = code;
        pendingCount = 1;
      }
      if (pendingCount >= 2) return accept(code, nowMs);
      return false;
    },
    setMode(next) {
      mode = next;
      pendingCode = null;
      pendingCount = 0;
    },
    mode: () => mode,
    reset() {
      pendingCode = null;
      pendingCount = 0;
      lastCode = null;
      lastAt = 0;
    },
  };
}

/** スキャン 1 件の受理結果 */
export type ScanOutcome = 'ok' | 'unknown' | 'out';

/**
 * 未登録コード通知のラッチ (保持) 状態。
 * カメラは同じコードをフレームごとに繰り返しデコードするため、通知は
 * 「次の受理 (別コード) かユーザーの操作」まで保持し、同じコードの
 * 再通知 (再表示・再フィードバック) は抑制する。
 * - notify(code, 'unknown'): ラッチ中と同コードなら 'suppress' (何もしない)、
 *   それ以外はコードをラッチして 'show' (通知を出す)。
 * - notify(code, 'ok' | 'out'): ラッチがあれば解除して 'clear' (通知を消す)、
 *   無ければ 'none'。
 */
export interface ScanUnknownLatch {
  latchedCode: () => string | null;
  notify: (code: string, outcome: ScanOutcome) => 'show' | 'suppress' | 'clear' | 'none';
  reset: () => void;
}

export function createUnknownLatch(): ScanUnknownLatch {
  let latched: string | null = null;
  return {
    latchedCode: () => latched,
    notify(code, outcome) {
      if (outcome === 'unknown') {
        if (latched === code) return 'suppress';
        latched = code;
        return 'show';
      }
      if (latched !== null) {
        latched = null;
        return 'clear';
      }
      return 'none';
    },
    reset() {
      latched = null;
    },
  };
}

/**
 * 読み取り値を商品マスタのバーコード/SKU と照合するための候補列。
 * ZXing は UPC-A を EAN-13 (先頭 0) として返すため、両方向を候補に入れる。
 */
export function barcodeCandidates(code: string): string[] {
  const out = [code];
  if (/^0\d{12}$/.test(code)) out.push(code.slice(1));
  if (/^\d{12}$/.test(code)) out.push('0' + code);
  return out;
}

/** 棚卸し明細行のうちスキャンカウントに関係する部分 */
export interface ScanCountLine {
  id: number;
  productId: number;
  locationId: number;
  /** 有効期限 (YYYY-MM-DD)。null = 期限なし (FEFO と同じく期限ありの後ろ) */
  expiryDate: string | null;
  countedQuantity: number | null;
}

/**
 * その商品 × 保管場所の明細行のうち、スキャンで加算する行を選ぶ。
 * ロットが複数ある場合は最も期限が早い行 (期限なしは最後、同期限は行 ID 昇順)。
 * 対象の行が無ければ null (= 対象外)。
 */
export function pickScanCountLine(
  lines: readonly ScanCountLine[],
  productId: number,
  locationId: number,
): ScanCountLine | null {
  let best: ScanCountLine | null = null;
  for (const line of lines) {
    if (line.productId !== productId || line.locationId !== locationId) continue;
    if (best === null) {
      best = line;
      continue;
    }
    const a = line.expiryDate;
    const b = best.expiryDate;
    if (a !== null && b === null) best = line;
    else if (a !== null && b !== null && a < b) best = line;
    else if (a === b && line.id < best.id) best = line;
  }
  return best;
}

/**
 * スキャンカウントの集計状態。行ごとの実数を絶対値で保持し、
 * 未入力 (null) の行は 0 から数え始める (スキャンした = 実地で数えた、の意味論)。
 * base は画面を開いた時点の countedQuantity、counted は現在の値、
 * saved は最後にサーバーへ保存できた値 (未保存の変更があるか = counted !== saved)。
 */
export interface ScanCounter {
  /** 加算する。対象行が無ければ null */
  increment: (
    productId: number,
    locationId: number,
  ) => { line: ScanCountLine; counted: number } | null;
  /** 指定行を 1 減らす (取り消し用)。現在値を返す */
  decrement: (lineId: number) => number | null;
  /** 現在の実数 (数えていない行は null) */
  countedOf: (lineId: number) => number | null;
  /** 未保存の行 (lineId → 送るべき絶対値) */
  pendingValues: () => Map<number, number>;
  markSaved: (lineId: number, value: number) => void;
  /** 商品ごとの合計カウント (最近リスト表示用) */
  totalsByProduct: () => Map<number, number>;
  totalCount: () => number;
}

export function createScanCounter(lines: readonly ScanCountLine[]): ScanCounter {
  const byId = new Map<number, ScanCountLine>();
  for (const line of lines) byId.set(line.id, line);
  const counted = new Map<number, number>();
  const saved = new Map<number, number>();

  function currentOf(line: ScanCountLine): number {
    const v = counted.get(line.id);
    return v !== undefined ? v : (line.countedQuantity ?? 0);
  }

  return {
    increment(productId, locationId) {
      const line = pickScanCountLine(lines, productId, locationId);
      if (!line) return null;
      const next = currentOf(line) + 1;
      counted.set(line.id, next);
      return { line, counted: next };
    },
    decrement(lineId) {
      const line = byId.get(lineId);
      if (!line) return null;
      const next = Math.max(0, currentOf(line) - 1);
      // 未入力だった行を未保存のまま 0 へ戻す取り消しは「数えていない」状態へ戻す
      // (実数 API は null を受け付けないため、一度保存した行は 0 を送って戻す)。
      if (next === 0 && line.countedQuantity === null && !saved.has(lineId)) {
        counted.delete(lineId);
        return null;
      }
      counted.set(lineId, next);
      return next;
    },
    countedOf(lineId) {
      const v = counted.get(lineId);
      if (v !== undefined) return v;
      const line = byId.get(lineId);
      return line ? line.countedQuantity : null;
    },
    pendingValues() {
      const out = new Map<number, number>();
      for (const [lineId, value] of counted) {
        const line = byId.get(lineId);
        const base = saved.has(lineId) ? saved.get(lineId)! : (line?.countedQuantity ?? null);
        if (base !== value) out.set(lineId, value);
      }
      return out;
    },
    markSaved(lineId, value) {
      saved.set(lineId, value);
    },
    totalsByProduct() {
      const out = new Map<number, number>();
      for (const [lineId, value] of counted) {
        const line = byId.get(lineId);
        if (!line) continue;
        const base = line.countedQuantity ?? 0;
        const delta = value - base;
        if (delta !== 0) out.set(line.productId, (out.get(line.productId) ?? 0) + delta);
      }
      return out;
    },
    totalCount() {
      let total = 0;
      for (const v of this.totalsByProduct().values()) total += v;
      return total;
    },
  };
}
