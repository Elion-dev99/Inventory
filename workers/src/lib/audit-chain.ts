/**
 * 監査ログのハッシュチェーン (改ざん検知、migration 0017)。
 *
 * - 以後の監査 INSERT はすべてこのモジュール経由にする。各行は
 *   row_hash = SHA-256(prev_hash + '|' + 正規化した行内容) を持ち、
 *   prev_hash は直近のハッシュ付き行の row_hash (無ければ 'GENESIS')。
 * - 行の内容を後から書き換えると row_hash の再計算が一致しなくなり、
 *   ハッシュ付き行を削除すると次の行の prev_hash が繋がらなくなるため、
 *   verifyAuditChain で検出できる。
 * - 0017 未適用の環境 (prev_hash 列が無い) では従来形式の INSERT に
 *   フォールバックする (列の有無は DB ごとにキャッシュする)。
 * - 0017 以前に書かれた行と、全体管理 Worker (別パッケージ) が書く行は
 *   row_hash が NULL であり、検証では「チェーン開始前」として読み飛ばす。
 * - 店舗側の直接 INSERT は最新行を読んで計算する方式のため、同時実行で
 *   prev_hash が重複しうる。その場合も各行の row_hash 自体は内容と
 *   整合しており、検証は「prev が過去のいずれかのハッシュ付き行に
 *   繋がること」まで許容する (重複は prev_hash の出現回数で検出可能)。
 */

export const AUDIT_GENESIS_HASH = 'GENESIS';

export interface AuditEntry {
  actorId: number | null;
  action: string;
  targetType: string;
  targetId: string;
  /** 保存する payload。文字列はそのまま、それ以外は JSON 化する。null は NULL */
  payload?: unknown;
  storeId: number | null;
  createdAt?: number;
}

export function auditPayloadText(payload: unknown): string | null {
  if (payload === undefined || payload === null) return null;
  if (typeof payload === 'string') return payload;
  return JSON.stringify(payload);
}

/** ハッシュ対象の正規化文字列 (保存される列値そのものから組み立てる) */
export function auditRowContent(entry: {
  actorId: number | null;
  action: string;
  targetType: string;
  targetId: string;
  payloadText: string | null;
  storeId: number | null;
  createdAt: number;
}): string {
  return JSON.stringify([
    entry.actorId,
    entry.action,
    entry.targetType,
    entry.targetId,
    entry.payloadText,
    entry.storeId,
    entry.createdAt,
  ]);
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function computeAuditRowHash(
  prevHash: string,
  entry: Parameters<typeof auditRowContent>[0],
): Promise<string> {
  return sha256Hex(`${prevHash}|${auditRowContent(entry)}`);
}

// 列の有無を DB バインディングごとにキャッシュする (coordinator と同じ方式)
const chainColumnCache = new WeakMap<D1Database, Promise<boolean>>();

export function auditChainAvailable(db: D1Database): Promise<boolean> {
  let cached = chainColumnCache.get(db);
  if (!cached) {
    cached = (async () => {
      try {
        const { results } = await db.prepare('PRAGMA table_info(audit_logs)').all<{ name: string }>();
        return results.some((r) => r.name === 'row_hash');
      } catch {
        return false;
      }
    })();
    chainColumnCache.set(db, cached);
  }
  return cached;
}

/** テスト・診断用: 列キャッシュを捨てる */
export function resetAuditChainCache(db: D1Database): void {
  chainColumnCache.delete(db);
}

interface ResolvedEntry {
  actorId: number | null;
  action: string;
  targetType: string;
  targetId: string;
  payloadText: string | null;
  storeId: number | null;
  createdAt: number;
}

function resolveEntry(entry: AuditEntry): ResolvedEntry {
  return {
    actorId: entry.actorId,
    action: entry.action,
    targetType: entry.targetType,
    targetId: entry.targetId,
    payloadText: auditPayloadText(entry.payload),
    storeId: entry.storeId,
    createdAt: entry.createdAt ?? Date.now(),
  };
}

/** 直近のハッシュ付き行の row_hash (無ければ GENESIS) */
export async function latestAuditHash(db: D1Database): Promise<string> {
  const row = await db
    .prepare('SELECT row_hash FROM audit_logs WHERE row_hash IS NOT NULL ORDER BY id DESC LIMIT 1')
    .first<{ row_hash: string }>();
  return row?.row_hash ?? AUDIT_GENESIS_HASH;
}

/**
 * 監査 INSERT 文を組み立てる。バッチに混ぜる場合はこちらを使い、
 * 単発なら insertAudit を使う。
 */
export async function buildAuditInsert(
  db: D1Database,
  entry: AuditEntry,
): Promise<D1PreparedStatement> {
  const e = resolveEntry(entry);
  if (await auditChainAvailable(db)) {
    const prevHash = await latestAuditHash(db);
    const rowHash = await computeAuditRowHash(prevHash, e);
    return db
      .prepare(
        `INSERT INTO audit_logs (actor_id, action, target_type, target_id, payload, store_id, created_at, prev_hash, row_hash)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
      )
      .bind(e.actorId, e.action, e.targetType, e.targetId, e.payloadText, e.storeId, e.createdAt, prevHash, rowHash);
  }
  return db
    .prepare(
      `INSERT INTO audit_logs (actor_id, action, target_type, target_id, payload, store_id, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
    )
    .bind(e.actorId, e.action, e.targetType, e.targetId, e.payloadText, e.storeId, e.createdAt);
}

/** 監査を 1 件記録する */
export async function insertAudit(db: D1Database, entry: AuditEntry): Promise<void> {
  await (await buildAuditInsert(db, entry)).run();
}

export interface AuditChainVerification {
  ok: boolean;
  /** 検証したハッシュ付き行の数 */
  checked: number;
  /** 最初に不整合が見つかった行の ID。正常なら null */
  brokenAtId: number | null;
}

interface AuditChainRow {
  id: number;
  actor_id: number | null;
  action: string;
  target_type: string;
  target_id: string;
  payload: string | null;
  store_id: number | null;
  created_at: number;
  prev_hash: string | null;
  row_hash: string | null;
}

/**
 * チェーンを先頭から検証する。row_hash が NULL の行 (チェーン開始前、
 * および全体管理 Worker が書いた行) は読み飛ばす。ハッシュ付き行は
 * - prev_hash が直前のハッシュ付き行の row_hash と一致する (標準形)、
 *   または過去のハッシュ付き行のいずれかに一致する (同時実行で
 *   prev が重複した行) こと
 * - row_hash が prev_hash と行内容から再計算した値と一致すること
 * を満たす必要がある。
 */
export async function verifyAuditChain(db: D1Database): Promise<AuditChainVerification> {
  if (!(await auditChainAvailable(db))) {
    return { ok: true, checked: 0, brokenAtId: null };
  }
  const { results } = await db
    .prepare(
      `SELECT id, actor_id, action, target_type, target_id, payload, store_id,
              created_at, prev_hash, row_hash
         FROM audit_logs ORDER BY id ASC`,
    )
    .all<AuditChainRow>();
  const seen = new Set<string>();
  let expectedPrev = AUDIT_GENESIS_HASH;
  let checked = 0;
  for (const row of results) {
    if (row.row_hash === null || row.prev_hash === null) continue;
    checked += 1;
    const linkOk = row.prev_hash === expectedPrev || seen.has(row.prev_hash);
    const recomputed = await computeAuditRowHash(row.prev_hash, {
      actorId: row.actor_id,
      action: row.action,
      targetType: row.target_type,
      targetId: row.target_id,
      payloadText: row.payload,
      storeId: row.store_id,
      createdAt: row.created_at,
    });
    if (!linkOk || recomputed !== row.row_hash) {
      return { ok: false, checked, brokenAtId: row.id };
    }
    seen.add(row.row_hash);
    expectedPrev = row.row_hash;
  }
  return { ok: true, checked, brokenAtId: null };
}
