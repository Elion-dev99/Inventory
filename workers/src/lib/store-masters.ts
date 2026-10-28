import { ApiError } from './errors';

/**
 * 店舗ごとの設定と運用マスタ (0020、設定の汎用化)。
 * - 店舗設定 (store_settings): 通貨・タイムゾーン。行が無ければ既定値。
 * - 理由コード (movement_reason_codes): 返品・廃棄の理由を店舗ごとに編集可能に。
 *   テーブルが無い/未投入の環境では従来の固定 4 コードにフォールバックする。
 */

export interface StoreSettings {
  currency: string;
  timezone: string;
  /** 繁忙期の月 (1-12)。未設定なら null (履歴データ側の月別上位から推定) */
  busyMonths: number[] | null;
  /** 閑散期の月 (1-12)。未設定なら null */
  slowMonths: number[] | null;
}

export const DEFAULT_STORE_SETTINGS: StoreSettings = {
  currency: 'JPY',
  timezone: 'Asia/Tokyo',
  busyMonths: null,
  slowMonths: null,
};

/** '1,5,7,8,12' 形式を検証して月の配列にする。不正・空は null */
export function parseMonthList(value: string | null | undefined): number[] | null {
  if (!value) return null;
  const months: number[] = [];
  for (const part of value.split(',')) {
    const n = Number(part.trim());
    if (!Number.isInteger(n) || n < 1 || n > 12) return null;
    if (!months.includes(n)) months.push(n);
  }
  if (months.length === 0) return null;
  return months.sort((a, b) => a - b);
}

export function formatMonthList(months: number[] | null): string {
  return months && months.length ? months.join(',') : '';
}

export const SUPPORTED_CURRENCIES = [
  'JPY',
  'USD',
  'EUR',
  'GBP',
  'AUD',
  'CAD',
  'CNY',
  'KRW',
  'TWD',
  'HKD',
  'SGD',
] as const;

export async function getStoreSettings(db: D1Database, storeId: number): Promise<StoreSettings> {
  const out: StoreSettings = { ...DEFAULT_STORE_SETTINGS };
  try {
    const { results } = await db
      .prepare('SELECT key, value FROM store_settings WHERE store_id = ?1')
      .bind(storeId)
      .all<{ key: string; value: string }>();
    for (const row of results) {
      if (row.key === 'currency' && row.value) out.currency = row.value;
      if (row.key === 'timezone' && row.value) out.timezone = row.value;
      if (row.key === 'season_busy_months') out.busyMonths = parseMonthList(row.value);
      if (row.key === 'season_slow_months') out.slowMonths = parseMonthList(row.value);
    }
  } catch {
    // store_settings 未適用の環境では既定値のまま
  }
  return out;
}

export async function setStoreSettings(
  db: D1Database,
  storeId: number,
  patch: Partial<StoreSettings>,
): Promise<StoreSettings> {
  const now = Date.now();
  const entries: [string, string][] = [];
  if (patch.currency !== undefined) entries.push(['currency', patch.currency]);
  if (patch.timezone !== undefined) entries.push(['timezone', patch.timezone]);
  if (patch.busyMonths !== undefined) entries.push(['season_busy_months', formatMonthList(patch.busyMonths)]);
  if (patch.slowMonths !== undefined) entries.push(['season_slow_months', formatMonthList(patch.slowMonths)]);
  for (const [key, value] of entries) {
    await db
      .prepare(
        `INSERT INTO store_settings (store_id, key, value, updated_at) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT (store_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .bind(storeId, key, value, now)
      .run();
  }
  return getStoreSettings(db, storeId);
}

/** タイムゾーン名が Intl で解釈できるか (保存前の検証) */
export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- 理由コード

export type ReasonKind = 'return' | 'disposal';

export interface ReasonCodeRow {
  id: number;
  kind: ReasonKind;
  code: string;
  label: string;
  sortOrder: number;
  isActive: boolean;
}

/** 0020 以前の固定コード。未投入環境と初期投入の正本 */
export const LEGACY_REASON_CODES: { code: string; label: string }[] = [
  { code: 'damaged', label: '破損' },
  { code: 'expired', label: '期限切れ' },
  { code: 'defective', label: '不良' },
  { code: 'other', label: 'その他' },
];

interface ReasonCodeDbRow {
  id: number;
  kind: string;
  code: string;
  label: string;
  sort_order: number;
  is_active: number;
}

function toReasonCode(row: ReasonCodeDbRow): ReasonCodeRow {
  return {
    id: row.id,
    kind: row.kind as ReasonKind,
    code: row.code,
    label: row.label,
    sortOrder: row.sort_order,
    isActive: row.is_active === 1,
  };
}

/** 店舗の理由コード一覧。テーブルが無い環境では従来の固定コードを返す */
export async function listReasonCodes(
  db: D1Database,
  storeId: number,
  kind: ReasonKind,
  includeInactive = false,
): Promise<ReasonCodeRow[]> {
  try {
    const { results } = await db
      .prepare(
        `SELECT id, kind, code, label, sort_order, is_active FROM movement_reason_codes
          WHERE store_id = ?1 AND kind = ?2 AND deleted_at IS NULL
          ORDER BY sort_order ASC, id ASC`,
      )
      .bind(storeId, kind)
      .all<ReasonCodeDbRow>();
    const rows = results.map(toReasonCode);
    return includeInactive ? rows : rows.filter((r) => r.isActive);
  } catch {
    return LEGACY_REASON_CODES.map((r, i) => ({
      id: 0,
      kind,
      code: r.code,
      label: r.label,
      sortOrder: i + 1,
      isActive: true,
    }));
  }
}

/**
 * 店舗に理由コードが 1 件も無ければ初期値を投入する
 * (0020 の後に作られた店舗向け)。テーブルが無い環境では何もしない。
 */
export async function ensureReasonCodesSeeded(db: D1Database, storeId: number): Promise<void> {
  try {
    const row = await db
      .prepare('SELECT COUNT(*) AS n FROM movement_reason_codes WHERE store_id = ?1')
      .bind(storeId)
      .first<{ n: number }>();
    if ((row?.n ?? 0) > 0) return;
    const now = Date.now();
    const stmts = (['return', 'disposal'] as ReasonKind[]).flatMap((kind) =>
      LEGACY_REASON_CODES.map((r, i) =>
        db
          .prepare(
            `INSERT INTO movement_reason_codes (store_id, kind, code, label, sort_order, is_active, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, 1, ?6, ?6)`,
          )
          .bind(storeId, kind, r.code, r.label, i + 1, now),
      ),
    );
    await db.batch(stmts);
  } catch {
    // 未適用環境では検証側が固定コードにフォールバックする
  }
}

/**
 * 返品・廃棄で使える理由コードか検証する。
 * 店舗に有効なコードがある場合はその中から、有効コードが 0 件の場合は
 * 従来の固定コードの中から選ぶ (全て無効化された店舗でも業務を止めない)。
 */
export async function assertReasonCodeUsable(
  db: D1Database,
  storeId: number,
  kind: ReasonKind,
  code: string,
): Promise<void> {
  await ensureReasonCodesSeeded(db, storeId);
  const active = await listReasonCodes(db, storeId, kind);
  const usable = active.length > 0 ? active : null;
  if (usable) {
    if (!usable.some((r) => r.code === code)) {
      throw new ApiError(400, 'INVALID_REASON_CODE', `reasonCode is not an active ${kind} reason code`);
    }
    return;
  }
  if (!LEGACY_REASON_CODES.some((r) => r.code === code)) {
    throw new ApiError(400, 'INVALID_REASON_CODE', `reasonCode is not an active ${kind} reason code`);
  }
}
