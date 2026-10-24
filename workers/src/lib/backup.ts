/**
 * バックアップ (migration 0016): 業務データ一式の JSON スナップショットを
 * backups / backup_chunks に保存し、洗い替えで復元する。
 *
 * - スナップショット対象: SNAPSHOT_TABLES (親→子の順)。この順序は外部キー
 *   依存に沿ったもので、復元時の INSERT はこの順、DELETE は逆順で行う。
 * - users / user_roles はスナップショットに含めるが復元対象からは外す
 *   (復元でアカウントや割当まで巻き戻すとロックアウトしうるため)。
 * - sessions / push_subscriptions / write_guards / idempotency_keys /
 *   audit_logs / movement_photos / maintenance_rejections / backups 自身は
 *   対象外。audit_logs は復元の記録先でもあるので巻き戻さない。
 *   movement_photos は実体が R2 で、stock_movements の id は復元後も
 *   保たれるため、行を触らない方が参照が生き続ける。
 * - 生成は店舗アプリの scheduled (Cron) と全体管理 API の双方から呼ばれ、
 *   保持件数は auto 最新 7 件 / manual 最新 3 件 (pre-restore は manual 扱い)。
 */

export const SNAPSHOT_TABLES = [
  'stores',
  'users',
  'platform_settings',
  'maintenance_windows',
  'warehouses',
  'locations',
  'products',
  'product_bundles',
  'lots',
  'suppliers',
  'stocks',
  'stocktakes',
  'stocktake_lines',
  'stock_movements',
  'negative_stock_approvals',
  'purchase_orders',
  'purchase_order_lines',
  'reservations',
  'pick_lists',
  'pick_items',
  'po_templates',
  'po_schedules',
  'announcements',
  'announcement_reads',
  'role_permissions',
  'feature_flags',
  'user_roles',
] as const;

/** 復元で洗い替えるテーブル (users / user_roles は巻き戻さない) */
export const RESTORE_TABLES: readonly string[] = SNAPSHOT_TABLES.filter(
  (t) => t !== 'users' && t !== 'user_roles',
);

/** スナップショット JSON 1 チャンクあたりの文字数 (D1 の行・文サイズに余裕を持たせる) */
const CHUNK_CHARS = 400_000;
/** auto バックアップの間隔 (24 時間) */
export const AUTO_BACKUP_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** 保持件数 */
export const BACKUP_RETENTION = { auto: 7, manual: 3 } as const;

export interface BackupRow {
  id: number;
  kind: string;
  created_at: number;
  created_by: number | null;
  size_bytes: number;
  note: string | null;
}

export interface SnapshotData {
  version: 1;
  createdAt: number;
  tables: Record<string, Record<string, unknown>[]>;
}

/** backups テーブルが存在するか (0016 未適用環境の判定) */
export async function hasBackupsTable(db: D1Database): Promise<boolean> {
  try {
    const row = await db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'backups'")
      .first<{ name: string }>();
    return row !== null;
  } catch {
    return false;
  }
}

async function tableExists(db: D1Database, table: string): Promise<boolean> {
  try {
    const row = await db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?1")
      .bind(table)
      .first<{ name: string }>();
    return row !== null;
  } catch {
    return false;
  }
}

/** 対象テーブル一式を読み取り、スナップショット JSON 文字列を作る */
export async function buildSnapshotJson(db: D1Database, nowMs: number): Promise<string> {
  const tables: Record<string, Record<string, unknown>[]> = {};
  for (const table of SNAPSHOT_TABLES) {
    if (!(await tableExists(db, table))) {
      tables[table] = [];
      continue;
    }
    const { results } = await db
      .prepare(`SELECT * FROM ${table} ORDER BY rowid ASC`)
      .all<Record<string, unknown>>();
    tables[table] = results;
  }
  const snapshot: SnapshotData = { version: 1, createdAt: nowMs, tables };
  return JSON.stringify(snapshot);
}

/** 保持件数を超えたバックアップを chunks ごと削除する */
export async function pruneBackups(db: D1Database): Promise<void> {
  for (const kind of ['auto', 'manual'] as const) {
    const keep = BACKUP_RETENTION[kind];
    const { results } = await db
      .prepare('SELECT id FROM backups WHERE kind = ?1 ORDER BY created_at DESC, id DESC')
      .bind(kind)
      .all<{ id: number }>();
    const stale = results.slice(keep).map((r) => r.id);
    for (const id of stale) {
      await db.batch([
        db.prepare('DELETE FROM backup_chunks WHERE backup_id = ?1').bind(id),
        db.prepare('DELETE FROM backups WHERE id = ?1').bind(id),
      ]);
    }
  }
}

/**
 * バックアップを 1 件作成する。作成後に保持件数で prune する。
 * 戻り値は backups.id。
 */
export async function createBackup(
  db: D1Database,
  args: { kind: 'auto' | 'manual'; createdBy: number | null; note?: string | null; nowMs: number },
): Promise<number> {
  const json = await buildSnapshotJson(db, args.nowMs);
  const res = await db
    .prepare(
      'INSERT INTO backups (kind, created_at, created_by, size_bytes, note) VALUES (?1, ?2, ?3, ?4, ?5)',
    )
    .bind(args.kind, args.nowMs, args.createdBy, new TextEncoder().encode(json).length, args.note ?? null)
    .run();
  const backupId = Number(res.meta.last_row_id);
  const chunkStmts: D1PreparedStatement[] = [];
  for (let seq = 0, offset = 0; offset < json.length; seq += 1, offset += CHUNK_CHARS) {
    chunkStmts.push(
      db
        .prepare('INSERT INTO backup_chunks (backup_id, seq, data) VALUES (?1, ?2, ?3)')
        .bind(backupId, seq, json.slice(offset, offset + CHUNK_CHARS)),
    );
  }
  if (chunkStmts.length > 0) await db.batch(chunkStmts);
  await pruneBackups(db);
  return backupId;
}

/**
 * Cron 用: 最後の auto バックアップから 24 時間以上経っていれば 1 件作る。
 * backups テーブルが無い環境 (0016 未適用) では何もしない。
 * 戻り値は作成したバックアップ id (作らなければ null)。
 */
export async function maybeAutoBackup(db: D1Database, nowMs: number): Promise<number | null> {
  if (!(await hasBackupsTable(db))) return null;
  const last = await db
    .prepare("SELECT created_at FROM backups WHERE kind = 'auto' ORDER BY created_at DESC, id DESC LIMIT 1")
    .first<{ created_at: number }>();
  if (last && nowMs - last.created_at < AUTO_BACKUP_INTERVAL_MS) return null;
  return createBackup(db, { kind: 'auto', createdBy: null, note: null, nowMs });
}

/** バックアップ一覧 (新しい順) */
export async function listBackups(db: D1Database): Promise<BackupRow[]> {
  const { results } = await db
    .prepare('SELECT id, kind, created_at, created_by, size_bytes, note FROM backups ORDER BY created_at DESC, id DESC')
    .all<BackupRow>();
  return results;
}

/** バックアップ 1 件のスナップショット JSON を再構成する。無ければ null */
export async function readBackupJson(db: D1Database, backupId: number): Promise<string | null> {
  const head = await db.prepare('SELECT id FROM backups WHERE id = ?1').bind(backupId).first<{ id: number }>();
  if (!head) return null;
  const { results } = await db
    .prepare('SELECT data FROM backup_chunks WHERE backup_id = ?1 ORDER BY seq ASC')
    .bind(backupId)
    .all<{ data: string }>();
  return results.map((r) => r.data).join('');
}

async function liveColumns(db: D1Database, table: string): Promise<string[]> {
  const { results } = await db.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>();
  return results.map((r) => r.name);
}

export interface RestoreResult {
  /** 復元したテーブルごとの行数 */
  restoredTables: Record<string, number>;
  /** 復元前に自動作成した pre-restore バックアップの id */
  preRestoreBackupId: number;
  /**
   * 復元後にぶら下がる割当 (バックアップ後に作られた店舗・倉庫への割当) を
   * 削除した件数。店舗・倉庫は AUTOINCREMENT のため、バックアップ後の
   * エンティティはスナップショット内の最大 id より大きい id を持つことで
   * 判別できる。全体管理者割当 (store_id / warehouse_id ともに NULL) は対象外。
   */
  droppedAssignments: number;
}

/**
 * バックアップから業務テーブルを洗い替える。
 * 手順: 現在の状態を pre-restore (manual) として保存 → DELETE (子→親) →
 * INSERT (親→子、id 含む全列) を batch で一括適用する。
 * users / user_roles / sessions には触れない。locations の親子 (自己参照) は
 * rowid 順 = 作成順 (親が先に作られる) に挿入するため順序が保たれる。
 */
export async function restoreBackup(
  db: D1Database,
  backupId: number,
  args: { actorId: number; nowMs: number },
): Promise<RestoreResult> {
  const json = await readBackupJson(db, backupId);
  if (json === null) throw new Error(`Backup not found: ${backupId}`);
  let snapshot: SnapshotData;
  try {
    snapshot = JSON.parse(json) as SnapshotData;
  } catch {
    throw new Error(`Backup is corrupted: ${backupId}`);
  }
  if (snapshot.version !== 1 || typeof snapshot.tables !== 'object' || snapshot.tables === null) {
    throw new Error(`Unsupported backup format: ${backupId}`);
  }

  const preRestoreBackupId = await createBackup(db, {
    kind: 'manual',
    createdBy: args.actorId,
    note: 'pre-restore',
    nowMs: args.nowMs,
  });

  // 復元対象外のテーブルから復元対象への参照のうち、復元後に行き先が
  // 無くなるもの (バックアップ後に作られたエンティティへの参照) を先に掃除する。
  // - movement_photos: バックアップ後の移動に付いた写真メタデータ
  // - idempotency_keys: バックアップ後の店舗に対する冪等キー
  // - sessions: バックアップ後の店舗を選択中のセッションは未選択に戻す
  // - user_roles: バックアップ後の店舗・倉庫への割当 (削除件数は結果に含める)
  const maxSnapshotId = (table: string): number => {
    const rows = Array.isArray(snapshot.tables[table]) ? snapshot.tables[table] : [];
    let max = 0;
    for (const row of rows) {
      const v = row.id;
      if (typeof v === 'number' && v > max) max = v;
    }
    return max;
  };
  if (await tableExists(db, 'movement_photos')) {
    await db
      .prepare('DELETE FROM movement_photos WHERE movement_id > ?1')
      .bind(maxSnapshotId('stock_movements'))
      .run();
  }
  await db
    .prepare('DELETE FROM idempotency_keys WHERE store_id > ?1')
    .bind(maxSnapshotId('stores'))
    .run();
  try {
    await db
      .prepare('UPDATE sessions SET store_id = NULL WHERE store_id > ?1')
      .bind(maxSnapshotId('stores'))
      .run();
  } catch {
    // sessions.store_id 列が無い環境では掃除不要
  }
  const dropped = await db
    .prepare('DELETE FROM user_roles WHERE store_id > ?1 OR warehouse_id > ?2')
    .bind(maxSnapshotId('stores'), maxSnapshotId('warehouses'))
    .run();
  const droppedAssignments = dropped.meta.changes ?? 0;

  const insertStmts: D1PreparedStatement[] = [];
  const restoredTables: Record<string, number> = {};
  for (const table of RESTORE_TABLES) {
    if (!(await tableExists(db, table))) continue;
    const rows = Array.isArray(snapshot.tables[table]) ? snapshot.tables[table] : [];
    restoredTables[table] = rows.length;
    if (rows.length === 0) continue;
    const live = await liveColumns(db, table);
    const cols = live.filter((col) =>
      rows.some((r) => Object.prototype.hasOwnProperty.call(r, col)),
    );
    if (cols.length === 0) continue;
    // D1 のバインド変数上限 (100) に収まるよう 1 文あたりの行数を抑える
    const rowsPerStmt = Math.max(1, Math.floor(90 / cols.length));
    for (let i = 0; i < rows.length; i += rowsPerStmt) {
      const chunk = rows.slice(i, i + rowsPerStmt);
      const placeholders = chunk.map(() => `(${cols.map(() => '?').join(',')})`).join(',');
      const params: unknown[] = [];
      for (const row of chunk) {
        for (const col of cols) params.push(row[col] ?? null);
      }
      insertStmts.push(
        db.prepare(`INSERT INTO ${table} (${cols.join(',')}) VALUES ${placeholders}`).bind(...params),
      );
    }
  }

  const deleteStmts = [...RESTORE_TABLES]
    .reverse()
    .map((table) => db.prepare(`DELETE FROM ${table}`));

  // batch (1 トランザクション) の先頭で FK チェックをコミット時まで遅らせる。
  // 洗い替えの途中では「親を消したが子 (復元対象外の user_roles 等) がまだ
  // 参照している」状態が必ず生じるため、順序だけでは FK を満たせない。
  // 最終状態はスナップショット由来で自己整合しており、遅延チェックで通る。
  await db.batch([
    db.prepare('PRAGMA defer_foreign_keys = ON'),
    ...deleteStmts,
    ...insertStmts,
  ]);
  return { restoredTables, preRestoreBackupId, droppedAssignments };
}
