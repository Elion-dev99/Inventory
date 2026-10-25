import { FEATURE_CATALOG } from './features';
import { ApiError } from './errors';

/**
 * プラン制 (0018)。契約単位は「組織 (organizations)」で、店舗は組織に属する。
 * プランカタログ (このファイル) が正で、DB には組織の plan_key だけを持つ。
 * プランの付与・変更は全体管理コンソールから運営者が行う (決済は持たない)。
 *
 * 互換ルール: stores.organization_id が NULL の店舗は「レガシー扱い」で
 * プラン制限なし (owner 相当)。organizations テーブル自体が無い環境
 * (0018 未適用) でも同じ扱いに倒し、従来動作を壊さない。
 *
 * 執行の考え方:
 * - 機能フラグ: 実効値 = 店舗フラグ ON かつ プラン許可。店舗フラグがオフなら
 *   従来どおり FEATURE_DISABLED、フラグがオンでもプランが許可しなければ
 *   PLAN_FEATURE_NOT_AVAILABLE (どちらも 403)。
 * - モジュール (引当・ピッキング等): プランに無ければ PLAN_FEATURE_NOT_AVAILABLE。
 * - 上限 (店舗数・ユーザー数・SKU 数): 超過する作成は PLAN_LIMIT_REACHED。
 *   上限の null は無制限。
 * - 全体管理者も、組織に所属する店舗での操作はプランに従う (DGOSK は
 *   owner プランのため実質無制限)。コンソール側の店舗作成で上限に当たる
 *   場合も作成をブロックするのが正規手順 (先にプランを上げる)。
 */

export type PlanKey = 'free' | 'starter' | 'standard' | 'pro' | 'enterprise' | 'owner';

export type ModuleKey =
  | 'reservations'
  | 'picking'
  | 'bundles'
  | 'returns_disposals'
  | 'po_templates'
  | 'bulk_edit';

export const MODULE_CATALOG: readonly { key: ModuleKey; label: string }[] = [
  { key: 'reservations', label: '引当' },
  { key: 'picking', label: 'ピッキング・検品' },
  { key: 'bundles', label: 'セット品' },
  { key: 'returns_disposals', label: '返品・廃棄' },
  { key: 'po_templates', label: '発注テンプレート・定期発注' },
  { key: 'bulk_edit', label: '商品一括編集' },
];

export const ALL_MODULES: readonly ModuleKey[] = MODULE_CATALOG.map((m) => m.key);

const ALL_FEATURES: readonly string[] = FEATURE_CATALOG.map((f) => f.key);

const STARTER_FEATURES: readonly string[] = [
  'announcements',
  'barcode_scan',
  'stocktakes',
  'alerts',
  'csv',
  'negative_stock',
];

export interface PlanLimits {
  stores: number | null;
  users: number | null;
  skus: number | null;
}

export interface PlanDef {
  key: PlanKey;
  name: string;
  /** 月額 (円・税別)。null は個別見積 (enterprise)、owner は特別プラン */
  price: number | null;
  limits: PlanLimits;
  features: readonly string[];
  modules: readonly ModuleKey[];
}

const NO_LIMITS: PlanLimits = { stores: null, users: null, skus: null };

export const PLAN_CATALOG: readonly PlanDef[] = [
  {
    key: 'free',
    name: 'フリー',
    price: 0,
    limits: { stores: 1, users: 3, skus: 200 },
    features: ['announcements'],
    modules: [],
  },
  {
    key: 'starter',
    name: 'スターター',
    price: 4980,
    limits: { stores: 1, users: 10, skus: 3000 },
    features: STARTER_FEATURES,
    modules: [],
  },
  {
    key: 'standard',
    name: 'スタンダード',
    price: 12800,
    limits: { stores: 3, users: 30, skus: null },
    features: ALL_FEATURES,
    modules: ['returns_disposals'],
  },
  {
    key: 'pro',
    name: 'プロ',
    price: 29800,
    limits: { stores: null, users: 100, skus: null },
    features: ALL_FEATURES,
    modules: ['returns_disposals', 'reservations', 'picking', 'bundles', 'po_templates', 'bulk_edit'],
  },
  {
    key: 'enterprise',
    name: 'エンタープライズ',
    price: null,
    limits: NO_LIMITS,
    features: ALL_FEATURES,
    modules: ALL_MODULES,
  },
  {
    key: 'owner',
    name: 'オーナー',
    price: 0,
    limits: NO_LIMITS,
    features: ALL_FEATURES,
    modules: ALL_MODULES,
  },
];

export const PLAN_DEFS: ReadonlyMap<string, PlanDef> = new Map(PLAN_CATALOG.map((p) => [p.key, p]));

export const OWNER_PLAN: PlanDef = PLAN_DEFS.get('owner') as PlanDef;

/** plan_key からカタログを引く。未知のキーは最も制限の強い free に倒す */
export function planDef(planKey: string | null | undefined): PlanDef {
  if (planKey && PLAN_DEFS.has(planKey)) return PLAN_DEFS.get(planKey) as PlanDef;
  return PLAN_DEFS.get('free') as PlanDef;
}

export function isPlanKey(value: string): boolean {
  return PLAN_DEFS.has(value);
}

export function planAllowsFeature(def: PlanDef, featureKey: string): boolean {
  return def.features.includes(featureKey);
}

export function planAllowsModule(def: PlanDef, moduleKey: ModuleKey): boolean {
  return def.modules.includes(moduleKey);
}

// ------------------------------------------------------------ 解決と集計

export interface OrganizationInfo {
  id: number;
  name: string;
  planKey: string;
}

export interface StorePlan {
  /** null はレガシー扱い (組織なし = 制限なし) */
  organization: OrganizationInfo | null;
  def: PlanDef;
}

interface StorePlanRow {
  organizationId: number | null;
  orgName: string | null;
  planKey: string | null;
}

/** 店舗の所属組織と実効プランを解決する。0018 未適用の環境ではレガシー扱い */
export async function resolveStorePlan(db: D1Database, storeId: number): Promise<StorePlan> {
  try {
    const row = await db
      .prepare(
        `SELECT s.organization_id AS organizationId, o.name AS orgName, o.plan_key AS planKey
           FROM stores s
           LEFT JOIN organizations o ON o.id = s.organization_id
          WHERE s.id = ?1`,
      )
      .bind(storeId)
      .first<StorePlanRow>();
    if (!row || row.organizationId === null) return { organization: null, def: OWNER_PLAN };
    return {
      organization: {
        id: row.organizationId,
        name: row.orgName ?? '',
        planKey: row.planKey ?? 'free',
      },
      def: planDef(row.planKey),
    };
  } catch {
    return { organization: null, def: OWNER_PLAN };
  }
}

/** 組織を id で引く。0018 未適用や不存在では null */
export async function getOrganization(
  db: D1Database,
  organizationId: number,
): Promise<(OrganizationInfo & { createdAt: number; updatedAt: number }) | null> {
  try {
    const row = await db
      .prepare(
        'SELECT id, name, plan_key AS planKey, created_at AS createdAt, updated_at AS updatedAt FROM organizations WHERE id = ?1',
      )
      .bind(organizationId)
      .first<{ id: number; name: string; planKey: string; createdAt: number; updatedAt: number }>();
    if (!row) return null;
    return { id: row.id, name: row.name, planKey: row.planKey, createdAt: row.createdAt, updatedAt: row.updatedAt };
  } catch {
    return null;
  }
}

/** organizations テーブルが存在するか (0018 適用済みか) */
export async function hasOrganizationsTable(db: D1Database): Promise<boolean> {
  try {
    const row = await db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'organizations'")
      .first<{ name: string }>();
    return row !== null;
  } catch {
    return false;
  }
}

export interface PlanUsage {
  stores: number;
  users: number;
  skus: number;
}

/**
 * 組織の利用状況。ユーザー数は組織の全店舗に割当のあるユーザーの
 * distinct 数、SKU 数は組織の全店舗の商品数 (削除済みを除く)。
 */
export async function organizationUsage(db: D1Database, organizationId: number): Promise<PlanUsage> {
  const row = await db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM stores WHERE organization_id = ?1) AS stores,
         (SELECT COUNT(DISTINCT user_id) FROM user_roles
           WHERE store_id IN (SELECT id FROM stores WHERE organization_id = ?1)) AS users,
         (SELECT COUNT(*) FROM products
           WHERE deleted_at IS NULL
             AND store_id IN (SELECT id FROM stores WHERE organization_id = ?1)) AS skus`,
    )
    .bind(organizationId)
    .first<PlanUsage>();
  return { stores: row?.stores ?? 0, users: row?.users ?? 0, skus: row?.skus ?? 0 };
}

/** 単一店舗分の利用状況 (レガシー店舗の /me 表示用) */
export async function singleStoreUsage(db: D1Database, storeId: number): Promise<PlanUsage> {
  const row = await db
    .prepare(
      `SELECT
         (SELECT COUNT(DISTINCT user_id) FROM user_roles WHERE store_id = ?1) AS users,
         (SELECT COUNT(*) FROM products WHERE deleted_at IS NULL AND store_id = ?1) AS skus`,
    )
    .bind(storeId)
    .first<{ users: number; skus: number }>();
  return { stores: 1, users: row?.users ?? 0, skus: row?.skus ?? 0 };
}

// ------------------------------------------------------------ エラー生成

/** プランが許可しない機能・モジュールへのアクセス (403) */
export function planFeatureError(planKey: string, what: string): ApiError {
  return new ApiError(403, 'PLAN_FEATURE_NOT_AVAILABLE', `Not available on the current plan: ${what}`, {
    plan: planKey,
  });
}

/** プラン上限への到達 (403)。内訳をボディに含める */
export function planLimitError(
  planKey: string,
  resource: 'stores' | 'users' | 'skus',
  limit: number,
  current: number,
): ApiError {
  return new ApiError(403, 'PLAN_LIMIT_REACHED', `Plan limit reached: ${resource} (${current}/${limit})`, {
    plan: planKey,
    limit,
    current,
    resource,
  });
}

/**
 * 上限チェックの共通判定。limit が null (無制限) なら常に可。
 * current は「追加前の現在数」、adding は今回増える数。
 */
export function exceedsLimit(limit: number | null, current: number, adding = 1): boolean {
  return limit !== null && current + adding > limit;
}
