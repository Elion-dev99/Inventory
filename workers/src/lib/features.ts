/**
 * 機能フラグ (管理者が機能単位でオン/オフする仕組み)。
 * カタログ (このファイル) が正で、feature_flags テーブルには「切り替え済みの
 * キー」だけが行として存在する。実効値は 行の enabled ?? カタログの既定値。
 * テーブル未適用 (migration 0006 未実施) の環境ではすべて既定値に解決する。
 * サーバー側の強制は各エンドポイントで requireFeature を通して行い、
 * /app は /api/v1/me の features で表示を出し分ける (二重に守る)。
 */

export interface FeatureDef {
  key: string;
  label: string;
  /** 既定値。既存運用を壊さないため、導入時はすべて true */
  default: boolean;
}

export const FEATURE_CATALOG: readonly FeatureDef[] = [
  { key: 'transfers', label: '在庫移動', default: true },
  { key: 'negative_stock', label: 'マイナス在庫', default: true },
  { key: 'stocktakes', label: '棚卸し', default: true },
  { key: 'alerts', label: 'アラート', default: true },
  { key: 'csv', label: 'CSV 入出力', default: true },
  { key: 'purchase_orders', label: '発注・仕入先', default: true },
  { key: 'analytics', label: '分析レポート', default: true },
  { key: 'barcode_scan', label: 'バーコードスキャン', default: true },
];

export const FEATURE_KEYS: ReadonlySet<string> = new Set(FEATURE_CATALOG.map((f) => f.key));

export type FeatureKey = (typeof FEATURE_CATALOG)[number]['key'];

export type FeatureMap = Record<string, boolean>;

export function defaultFeatures(): FeatureMap {
  const out: FeatureMap = {};
  for (const f of FEATURE_CATALOG) out[f.key] = f.default;
  return out;
}

/**
 * feature_flags を読み、カタログ既定値に上書きして解決済みフラグを返す。
 * フラグは店舗ごとに解決する (feature_flags は (store_id, key) が主キー)。
 */
export async function getFeatures(db: D1Database, storeId: number): Promise<FeatureMap> {
  const out = defaultFeatures();
  try {
    const { results } = await db
      .prepare('SELECT key, enabled FROM feature_flags WHERE store_id = ?1')
      .bind(storeId)
      .all<{ key: string; enabled: number }>();
    for (const row of results) {
      if (FEATURE_KEYS.has(row.key)) out[row.key] = row.enabled === 1;
    }
  } catch {
    // テーブル未適用の環境では既定値のまま
  }
  return out;
}

export async function isFeatureEnabled(db: D1Database, key: string, storeId: number): Promise<boolean> {
  const features = await getFeatures(db, storeId);
  return features[key] === true;
}
