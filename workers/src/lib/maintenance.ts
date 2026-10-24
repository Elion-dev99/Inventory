/**
 * メンテナンスモード (全体管理が制御する)。
 *
 * 2 系統を合算して判定する:
 * 1. maintenance_windows (migration 0011): 全体管理が登録する枠。
 *    - kind='once': starts_at〜ends_at (ms) の単発枠。ends_at NULL は終了未定。
 *    - kind='weekly': JST の weekday (0=日..6=土) と start_minute/end_minute
 *      (JST 0時からの分、end は 1440 超で翌日跨ぎ) の毎週枠。
 *    - level: 'read_only' (書き込み全停止) / 'features' (機能別停止) /
 *      'full' (全面停止)。store_id NULL は全店舗、指定時はその店舗だけ。
 *    - cancelled_at が入った枠は無効。
 * 2. platform_settings 'maintenance' (従来の即時オン/オフ): on の間は
 *    「全店舗・read_only・無期限」の仮想 window として合算する (後方互換)。
 *
 * テーブルが無い DB では該当系統を無しとして扱い、既存動作を壊さない。
 * 行の読み取りはモジュール内に 30 秒キャッシュし、時刻判定は毎回行う
 * (全体管理側の変更は最大 30 秒遅れて反映される)。
 */

export type MaintenanceLevel = 'read_only' | 'features' | 'full';
export type MaintenanceWindowKind = 'once' | 'weekly';

export const MAINTENANCE_SETTING_KEY = 'maintenance';
export const DEFAULT_MAINTENANCE_MESSAGE =
  'メンテナンス中です。しばらくしてから再度お試しください。';
const CACHE_TTL_MS = 30_000;
const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;
const JST_OFFSET_MS = 9 * 60 * MINUTE_MS;

/** features レベルで停止できる機能キーと表示名 (admin コンソールと共通) */
export const MAINTENANCE_FEATURES: readonly { key: string; label: string }[] = [
  { key: 'movements', label: '入庫・消費' },
  { key: 'transfers', label: '移動' },
  { key: 'stocktakes', label: '棚卸し' },
  { key: 'purchase_orders', label: '発注' },
  { key: 'csv', label: 'CSV' },
  { key: 'master', label: 'マスタ編集' },
  { key: 'analytics', label: '分析' },
];
export const MAINTENANCE_FEATURE_KEYS: ReadonlySet<string> = new Set(
  MAINTENANCE_FEATURES.map((f) => f.key),
);
export const MAINTENANCE_FEATURE_LABELS: Record<string, string> = Object.fromEntries(
  MAINTENANCE_FEATURES.map((f) => [f.key, f.label]),
);

const LEVEL_SEVERITY: Record<MaintenanceLevel, number> = {
  features: 1,
  read_only: 2,
  full: 3,
};

export function isMaintenanceLevel(v: unknown): v is MaintenanceLevel {
  return v === 'read_only' || v === 'features' || v === 'full';
}

/** maintenance_windows の DB 行 */
export interface MaintenanceWindowRow {
  id: number;
  kind: string;
  starts_at: number | null;
  ends_at: number | null;
  weekday: number | null;
  start_minute: number | null;
  end_minute: number | null;
  level: string;
  features: string | null;
  store_id: number | null;
  message: string | null;
  created_by: number | null;
  created_at: number;
  cancelled_at: number | null;
}

/** 判定用に正規化した window (features は配列、level は検証済み) */
export interface MaintenanceWindow {
  id: number;
  kind: MaintenanceWindowKind;
  startsAt: number | null;
  endsAt: number | null;
  weekday: number | null;
  startMinute: number | null;
  endMinute: number | null;
  level: MaintenanceLevel;
  features: string[];
  storeId: number | null;
  message: string | null;
  createdBy: number | null;
  createdAt: number;
  cancelledAt: number | null;
}

export function parseWindowFeatures(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (v): v is string => typeof v === 'string' && MAINTENANCE_FEATURE_KEYS.has(v),
    );
  } catch {
    return [];
  }
}

/** DB 行を正規化する。不正な level/kind の行は null (判定から除外) */
export function normalizeWindow(row: MaintenanceWindowRow): MaintenanceWindow | null {
  if (row.kind !== 'once' && row.kind !== 'weekly') return null;
  if (!isMaintenanceLevel(row.level)) return null;
  return {
    id: row.id,
    kind: row.kind,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    weekday: row.weekday,
    startMinute: row.start_minute,
    endMinute: row.end_minute,
    level: row.level,
    features: parseWindowFeatures(row.features),
    storeId: row.store_id,
    message: row.message && row.message.length > 0 ? row.message : null,
    createdBy: row.created_by,
    createdAt: row.created_at,
    cancelledAt: row.cancelled_at,
  };
}

/** 評価済みの occurrence (weekly は今回の開始・終了に展開したもの) */
export interface WindowOccurrence {
  startsAt: number;
  /** 終了時刻。once で ends_at が無い場合は null (終了未定) */
  endsAt: number | null;
}

/**
 * JST の「その日の 0 時」を表すシフト済み時刻 (now + 9h を日に丸めた値)。
 * 実時刻に戻すには JST_OFFSET_MS を引く。
 */
function jstDayStartShifted(now: number): number {
  return Math.floor((now + JST_OFFSET_MS) / DAY_MS) * DAY_MS;
}

function jstWeekdayOfShiftedDay(shiftedDayStart: number): number {
  return new Date(shiftedDayStart).getUTCDay();
}

/**
 * window が now 時点で有効なら、その occurrence を返す。
 * weekly は「開始した曜日」に属するので、前日開始・翌日跨ぎも拾う。
 */
export function activeOccurrence(w: MaintenanceWindow, now: number): WindowOccurrence | null {
  if (w.cancelledAt !== null) return null;
  if (w.kind === 'once') {
    if (w.startsAt === null) return null;
    if (w.startsAt <= now && (w.endsAt === null || now < w.endsAt)) {
      return { startsAt: w.startsAt, endsAt: w.endsAt };
    }
    return null;
  }
  // weekly
  if (w.weekday === null || w.startMinute === null || w.endMinute === null) return null;
  const todayShifted = jstDayStartShifted(now);
  for (const offset of [0, -1]) {
    const dayShifted = todayShifted + offset * DAY_MS;
    if (jstWeekdayOfShiftedDay(dayShifted) !== w.weekday) continue;
    const occStart = dayShifted - JST_OFFSET_MS + w.startMinute * MINUTE_MS;
    const occEnd = dayShifted - JST_OFFSET_MS + w.endMinute * MINUTE_MS;
    if (occStart <= now && now < occEnd) return { startsAt: occStart, endsAt: occEnd };
  }
  return null;
}

/** now より後に始まる直近の occurrence (なければ null) */
export function nextOccurrence(w: MaintenanceWindow, now: number): WindowOccurrence | null {
  if (w.cancelledAt !== null) return null;
  if (w.kind === 'once') {
    if (w.startsAt === null || w.startsAt <= now) return null;
    return { startsAt: w.startsAt, endsAt: w.endsAt };
  }
  if (w.weekday === null || w.startMinute === null || w.endMinute === null) return null;
  const todayShifted = jstDayStartShifted(now);
  for (let offset = 0; offset <= 7; offset++) {
    const dayShifted = todayShifted + offset * DAY_MS;
    if (jstWeekdayOfShiftedDay(dayShifted) !== w.weekday) continue;
    const occStart = dayShifted - JST_OFFSET_MS + w.startMinute * MINUTE_MS;
    if (occStart > now) {
      return { startsAt: occStart, endsAt: dayShifted - JST_OFFSET_MS + w.endMinute * MINUTE_MS };
    }
  }
  return null;
}

/** 有効中の window (occurrence 展開済み) */
export interface ActiveMaintenanceWindow {
  id: number;
  kind: MaintenanceWindowKind | 'legacy';
  level: MaintenanceLevel;
  features: string[];
  storeId: number | null;
  message: string | null;
  startsAt: number;
  endsAt: number | null;
}

export interface UpcomingMaintenance {
  id: number;
  kind: MaintenanceWindowKind;
  level: MaintenanceLevel;
  features: string[];
  storeId: number | null;
  message: string | null;
  startsAt: number;
  endsAt: number | null;
}

export interface MaintenanceResolution {
  active: {
    level: MaintenanceLevel;
    /** features レベルの合併集合 */
    features: string[];
    /** 寄与 window のうち最も早い有限の終了時刻。無ければ null (終了未定) */
    endsAt: number | null;
    /** 最も重い window のメッセージ (無ければ null) */
    message: string | null;
    windows: ActiveMaintenanceWindow[];
  } | null;
  upcoming: UpcomingMaintenance | null;
}

// ------------------------------------------------------------ データ読み取り

export interface MaintenanceState {
  on: boolean;
  /** 管理者が設定した告知文。未設定なら null (表示側が既定文言を使う) */
  message: string | null;
}

interface RawData {
  windows: MaintenanceWindow[];
  legacy: MaintenanceState;
  legacyUpdatedAt: number | null;
}

let cache: { at: number; data: RawData } | null = null;

/** テスト用: キャッシュを破棄して次回読み直させる */
export function clearMaintenanceCache(): void {
  cache = null;
}

/** maintenance_windows の全行 (キャッシュなし)。テーブルが無ければ空配列 */
export async function loadMaintenanceWindows(db: D1Database): Promise<MaintenanceWindow[]> {
  try {
    const { results } = await db
      .prepare('SELECT * FROM maintenance_windows ORDER BY id ASC')
      .all<MaintenanceWindowRow>();
    const out: MaintenanceWindow[] = [];
    for (const row of results) {
      const w = normalizeWindow(row);
      if (w) out.push(w);
    }
    return out;
  } catch {
    return [];
  }
}

async function loadLegacy(db: D1Database): Promise<{ state: MaintenanceState; updatedAt: number | null }> {
  try {
    const row = await db
      .prepare('SELECT value, updated_at FROM platform_settings WHERE key = ?1')
      .bind(MAINTENANCE_SETTING_KEY)
      .first<{ value: string | null; updated_at: string | null }>();
    if (row?.value) {
      const parsed = JSON.parse(row.value) as { on?: unknown; message?: unknown };
      const state: MaintenanceState = {
        on: parsed.on === true,
        message:
          typeof parsed.message === 'string' && parsed.message.length > 0 ? parsed.message : null,
      };
      const updatedAt = row.updated_at ? Date.parse(row.updated_at) : NaN;
      return { state, updatedAt: Number.isFinite(updatedAt) ? updatedAt : null };
    }
  } catch {
    // テーブル未作成・値が壊れている場合は OFF として扱う
  }
  return { state: { on: false, message: null }, updatedAt: null };
}

async function loadRaw(db: D1Database): Promise<RawData> {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_TTL_MS) return cache.data;
  const [windows, legacy] = await Promise.all([loadMaintenanceWindows(db), loadLegacy(db)]);
  const data: RawData = { windows, legacy: legacy.state, legacyUpdatedAt: legacy.updatedAt };
  cache = { at: now, data };
  return data;
}

/** 従来互換: platform_settings の即時設定だけを読む */
export async function getMaintenance(db: D1Database): Promise<MaintenanceState> {
  const data = await loadRaw(db);
  return data.legacy;
}

/** 純粋関数版の解決 (テスト・admin 側の集計から使う) */
export function evaluateMaintenance(
  windows: readonly MaintenanceWindow[],
  legacy: MaintenanceState,
  legacyUpdatedAt: number | null,
  storeId: number | null,
  now: number,
): MaintenanceResolution {
  const applicable = windows.filter((w) => w.storeId === null || w.storeId === storeId);
  const activeWindows: ActiveMaintenanceWindow[] = [];
  for (const w of applicable) {
    const occ = activeOccurrence(w, now);
    if (occ) {
      activeWindows.push({
        id: w.id,
        kind: w.kind,
        level: w.level,
        features: w.features,
        storeId: w.storeId,
        message: w.message,
        startsAt: occ.startsAt,
        endsAt: occ.endsAt,
      });
    }
  }
  if (legacy.on) {
    activeWindows.push({
      id: 0,
      kind: 'legacy',
      level: 'read_only',
      features: [],
      storeId: null,
      message: legacy.message,
      startsAt: legacyUpdatedAt ?? 0,
      endsAt: null,
    });
  }

  let active: MaintenanceResolution['active'] = null;
  if (activeWindows.length > 0) {
    let level: MaintenanceLevel = 'features';
    for (const w of activeWindows) {
      if (LEVEL_SEVERITY[w.level] > LEVEL_SEVERITY[level]) level = w.level;
    }
    const heaviest = activeWindows
      .filter((w) => w.level === level)
      .sort((a, b) => a.id - b.id)[0];
    const features = [...new Set(activeWindows.flatMap((w) => w.features))];
    const finiteEnds = activeWindows
      .map((w) => w.endsAt)
      .filter((v): v is number => v !== null);
    active = {
      level,
      features,
      endsAt: finiteEnds.length > 0 ? Math.min(...finiteEnds) : null,
      message: heaviest?.message ?? null,
      windows: activeWindows,
    };
  }

  let upcoming: UpcomingMaintenance | null = null;
  for (const w of applicable) {
    const next = nextOccurrence(w, now);
    if (!next) continue;
    if (next.startsAt - now > DAY_MS) continue;
    if (!upcoming || next.startsAt < upcoming.startsAt) {
      upcoming = {
        id: w.id,
        kind: w.kind,
        level: w.level,
        features: w.features,
        storeId: w.storeId,
        message: w.message,
        startsAt: next.startsAt,
        endsAt: next.endsAt,
      };
    }
  }

  return { active, upcoming };
}

/**
 * 店舗に対する現在のメンテナンス解決結果を返す。
 * storeId は対象店舗 (null のときは全店舗対象の枠だけが効く)。
 */
export async function resolveMaintenance(
  db: D1Database,
  storeId: number | null,
  now: number = Date.now(),
): Promise<MaintenanceResolution> {
  const data = await loadRaw(db);
  return evaluateMaintenance(data.windows, data.legacy, data.legacyUpdatedAt, storeId, now);
}

/** 表示・エラー応答に使う実効メッセージ (カスタム文が無ければ既定文言) */
export function maintenanceMessage(state: MaintenanceState): string {
  return state.message ?? DEFAULT_MAINTENANCE_MESSAGE;
}

/** 解決結果に対する実効メッセージ */
export function resolvedMaintenanceMessage(
  active: MaintenanceResolution['active'],
): string {
  return active?.message ?? DEFAULT_MAINTENANCE_MESSAGE;
}
