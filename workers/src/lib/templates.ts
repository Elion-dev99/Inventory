import { ensureReasonCodesSeeded, type ReasonKind } from './store-masters';

/**
 * 業種別初期データテンプレート (導入の汎用化)。
 *
 * 新規店舗の立ち上げ時に、商品カテゴリ・部門・返品/廃棄の理由コード追加分・
 * 最初の保管場所を業種ごとの初期値で投入する。テンプレートはコード定義が正で
 * (プランカタログと同じ考え方)、DB には投入済みデータだけが残るため、
 * 投入後の編集は通常のマスタ編集 (店舗設定画面) で自由に行える。
 * 理由コードの基本 4 種は ensureReasonCodesSeeded が常に投入し、テンプレートは
 * 業種固有の追加分だけを持つ。
 */

export interface IndustryTemplate {
  key: string;
  name: string;
  description: string;
  categories: string[];
  departments: string[];
  /** 返品理由の追加分 (基本 4 種に足す) */
  returnReasons: { code: string; label: string }[];
  /** 廃棄理由の追加分 (基本 4 種に足す) */
  disposalReasons: { code: string; label: string }[];
  /** 最初に作る保管場所 (倉庫は別途 WH-01 を作る) */
  firstLocation: { code: string; name: string } | null;
}

export const INDUSTRY_TEMPLATES: readonly IndustryTemplate[] = [
  {
    key: 'general',
    name: '汎用',
    description: '業種を問わない最小構成です。',
    categories: ['消耗品', '備品', '食品', 'その他'],
    departments: ['総務', '営業', '現場'],
    returnReasons: [],
    disposalReasons: [],
    firstLocation: { code: 'MAIN', name: '保管庫' },
  },
  {
    key: 'retail',
    name: '小売・店舗',
    description: '売場とバックヤードで在庫を持つ店舗向けです。',
    categories: ['食品', '飲料', '日用品', '消耗品', '備品'],
    departments: ['売場', 'バックヤード', 'レジ'],
    returnReasons: [{ code: 'customer_return', label: 'お客様返品' }],
    disposalReasons: [{ code: 'unsold', label: '売れ残り' }],
    firstLocation: { code: 'FLOOR', name: '売場' },
  },
  {
    key: 'food',
    name: '飲食店',
    description: '食材と消耗品をキッチン中心に管理する店舗向けです。',
    categories: ['食材', '飲料', '調味料', '消耗品', '備品'],
    departments: ['キッチン', 'ホール', 'バー'],
    returnReasons: [{ code: 'wrong_delivery', label: '誤配達' }],
    disposalReasons: [
      { code: 'quality', label: '品質劣化' },
      { code: 'over_prep', label: '仕込み過多' },
    ],
    firstLocation: { code: 'KITCHEN', name: 'キッチン' },
  },
  {
    key: 'office',
    name: 'オフィス',
    description: '文具や IT 備品などの備品管理向けです。',
    categories: ['文具', 'IT備品', '清掃用品', '消耗品'],
    departments: ['総務', '営業', '開発', '人事'],
    returnReasons: [],
    disposalReasons: [{ code: 'obsolete', label: '陳腐化' }],
    firstLocation: { code: 'STOCK', name: '備品庫' },
  },
  {
    key: 'warehouse',
    name: '倉庫・物流',
    description: '資材と梱包材を工程ごとに管理する倉庫向けです。',
    categories: ['資材', '梱包材', '工具', '消耗品'],
    departments: ['入庫', '出庫', '検品'],
    returnReasons: [{ code: 'wrong_delivery', label: '誤配達' }],
    disposalReasons: [{ code: 'water_damage', label: '水濡れ' }],
    firstLocation: { code: 'ZONE-A', name: 'ゾーンA' },
  },
];

export function findTemplate(key: string | undefined | null): IndustryTemplate {
  const found = INDUSTRY_TEMPLATES.find((t) => t.key === key);
  return found ?? (INDUSTRY_TEMPLATES[0] as IndustryTemplate);
}

export function isTemplateKey(key: string): boolean {
  return INDUSTRY_TEMPLATES.some((t) => t.key === key);
}

/** サインアップ画面と全体管理コンソールに出すカタログ表現 */
export function templateCatalogJson(): Record<string, unknown>[] {
  return INDUSTRY_TEMPLATES.map((t) => ({
    key: t.key,
    name: t.name,
    description: t.description,
    categoryCount: t.categories.length,
    departmentCount: t.departments.length,
  }));
}

export interface AppliedTemplateSummary {
  categories: number;
  departments: number;
  reasonCodes: number;
  locations: number;
}

/**
 * テンプレートを店舗へ投入する。各マスタは個別に冪等 (同一店舗・同一名称/コードの
 * 未削除行があれば作らない) で、テーブル未適用の環境ではその分だけ静かに飛ばす。
 * 最初の保管場所は warehouseId が必要なので、倉庫を先に作った呼び出し側から渡す。
 */
export async function applyIndustryTemplate(
  db: D1Database,
  storeId: number,
  templateKey: string,
  opts: { warehouseId?: number | null } = {},
): Promise<AppliedTemplateSummary> {
  const template = findTemplate(templateKey);
  const now = Date.now();
  const applied: AppliedTemplateSummary = { categories: 0, departments: 0, reasonCodes: 0, locations: 0 };

  // 理由コードの基本 4 種を先に投入し、テンプレートの追加分を後ろに足す
  await ensureReasonCodesSeeded(db, storeId);

  try {
    for (let i = 0; i < template.categories.length; i++) {
      const res = await db
        .prepare(
          `INSERT INTO product_categories (store_id, name, sort_order, created_at, updated_at)
           SELECT ?1, ?2, ?3, ?4, ?4
            WHERE NOT EXISTS (SELECT 1 FROM product_categories WHERE store_id = ?1 AND name = ?2 AND deleted_at IS NULL)`,
        )
        .bind(storeId, template.categories[i], i + 1, now)
        .run();
      applied.categories += res.meta.changes ?? 0;
    }
  } catch {
    // カテゴリ未適用の環境では飛ばす
  }

  try {
    for (let i = 0; i < template.departments.length; i++) {
      const res = await db
        .prepare(
          `INSERT INTO departments (store_id, name, sort_order, is_active, created_at, updated_at)
           SELECT ?1, ?2, ?3, 1, ?4, ?4
            WHERE NOT EXISTS (SELECT 1 FROM departments WHERE store_id = ?1 AND name = ?2 AND deleted_at IS NULL)`,
        )
        .bind(storeId, template.departments[i], i + 1, now)
        .run();
      applied.departments += res.meta.changes ?? 0;
    }
  } catch {
    // 部門未適用の環境では飛ばす
  }

  const extraReasons: { kind: ReasonKind; code: string; label: string }[] = [
    ...template.returnReasons.map((r) => ({ kind: 'return' as ReasonKind, ...r })),
    ...template.disposalReasons.map((r) => ({ kind: 'disposal' as ReasonKind, ...r })),
  ];
  for (const r of extraReasons) {
    try {
      const res = await db
        .prepare(
          `INSERT INTO movement_reason_codes (store_id, kind, code, label, sort_order, is_active, created_at, updated_at)
           SELECT ?1, ?2, ?3, ?4, 100, 1, ?5, ?5
            WHERE NOT EXISTS (SELECT 1 FROM movement_reason_codes WHERE store_id = ?1 AND kind = ?2 AND code = ?3 AND deleted_at IS NULL)`,
        )
        .bind(storeId, r.kind, r.code, r.label, now)
        .run();
      applied.reasonCodes += res.meta.changes ?? 0;
    } catch {
      // 理由コード未適用の環境では飛ばす
    }
  }

  if (template.firstLocation && opts.warehouseId) {
    try {
      const res = await db
        .prepare(
          `INSERT INTO locations (warehouse_id, code, name, created_at, updated_at)
           SELECT ?1, ?2, ?3, ?4, ?4
            WHERE NOT EXISTS (SELECT 1 FROM locations WHERE warehouse_id = ?1 AND code = ?2 AND deleted_at IS NULL)`,
        )
        .bind(opts.warehouseId, template.firstLocation.code, template.firstLocation.name, now)
        .run();
      applied.locations += res.meta.changes ?? 0;
    } catch {
      // 保管場所を作れない環境では飛ばす
    }
  }

  return applied;
}
