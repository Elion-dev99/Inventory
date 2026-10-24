/**
 * お知らせ (announcements) の共通ヘルパー。
 * 店舗アプリ (workers) と全体管理コンソール (admin) の両 Worker から使う。
 *
 * - announcements.store_id が NULL のものは全店舗宛。
 * - 掲載中 = starts_at <= now かつ (ends_at IS NULL または ends_at > now)。
 * - 既読は announcement_reads の行の有無で表す (ユーザー単位)。
 */

export interface AnnouncementRow {
  id: number;
  store_id: number | null;
  title: string;
  body: string;
  /** 'normal' | 'important' */
  priority: string;
  starts_at: number;
  ends_at: number | null;
  push: number;
  push_sent_at: number | null;
  created_by: number | null;
  created_at: number;
  updated_at: number;
}

export interface AnnouncementJson {
  id: number;
  storeId: number | null;
  title: string;
  body: string;
  priority: string;
  startsAt: number;
  endsAt: number | null;
  push: boolean;
  pushSentAt: number | null;
  createdBy: number | null;
  createdAt: number;
  updatedAt: number;
  /** 閲覧系でのみ付く: 自分が既読か */
  read?: boolean;
  /** 管理系でのみ付く: 既読ユーザー数 */
  readCount?: number;
  /** 管理系でのみ付く: 対象ユーザー数 */
  targetUsers?: number;
}

export function announcementJson(
  row: AnnouncementRow,
  extras: { read?: boolean; readCount?: number; targetUsers?: number } = {},
): AnnouncementJson {
  const json: AnnouncementJson = {
    id: row.id,
    storeId: row.store_id,
    title: row.title,
    body: row.body,
    priority: row.priority,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    push: row.push === 1,
    pushSentAt: row.push_sent_at,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  if (extras.read !== undefined) json.read = extras.read;
  if (extras.readCount !== undefined) json.readCount = extras.readCount;
  if (extras.targetUsers !== undefined) json.targetUsers = extras.targetUsers;
  return json;
}

export type AnnouncementState = 'scheduled' | 'live' | 'ended';

/** 掲載状態: scheduled (掲載前) / live (掲載中) / ended (終了) */
export function announcementState(row: AnnouncementRow, now: number): AnnouncementState {
  if (row.starts_at > now) return 'scheduled';
  if (row.ends_at !== null && row.ends_at <= now) return 'ended';
  return 'live';
}

export function isLiveAnnouncement(row: AnnouncementRow, now: number): boolean {
  return announcementState(row, now) === 'live';
}

/**
 * 対象ユーザー数。全店舗宛は有効な全ユーザー数、
 * 店舗宛はその店舗に割当のある有効ユーザー数。
 */
export async function countTargetUsers(db: D1Database, storeId: number | null): Promise<number> {
  const row =
    storeId === null
      ? await db
          .prepare(`SELECT COUNT(*) AS n FROM users WHERE status = 'active'`)
          .first<{ n: number }>()
      : await db
          .prepare(
            `SELECT COUNT(DISTINCT ur.user_id) AS n
               FROM user_roles ur JOIN users u ON u.id = ur.user_id AND u.status = 'active'
              WHERE ur.store_id = ?1`,
          )
          .bind(storeId)
          .first<{ n: number }>();
  return row?.n ?? 0;
}

/** プッシュ送信・既読集計の母数となる対象ユーザー ID 一覧 */
export async function targetUserIds(db: D1Database, storeId: number | null): Promise<number[]> {
  const rows =
    storeId === null
      ? await db
          .prepare(`SELECT id FROM users WHERE status = 'active' ORDER BY id`)
          .all<{ id: number }>()
      : await db
          .prepare(
            `SELECT DISTINCT ur.user_id AS id
               FROM user_roles ur JOIN users u ON u.id = ur.user_id AND u.status = 'active'
              WHERE ur.store_id = ?1 ORDER BY ur.user_id`,
          )
          .bind(storeId)
          .all<{ id: number }>();
  return rows.results.map((r) => r.id);
}

export async function countAnnouncementReads(
  db: D1Database,
  announcementId: number,
): Promise<number> {
  const row = await db
    .prepare('SELECT COUNT(*) AS n FROM announcement_reads WHERE announcement_id = ?1')
    .bind(announcementId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

interface VisibleRow extends AnnouncementRow {
  read_at: number | null;
}

const VISIBLE_WHERE = `(a.store_id IS NULL OR a.store_id = ?1)
  AND a.starts_at <= ?2 AND (a.ends_at IS NULL OR a.ends_at > ?2)`;

/** 現在の店舗で見える掲載中のお知らせ (新しい順) と自分の未読数 */
export async function listVisibleAnnouncements(
  db: D1Database,
  storeId: number,
  userId: number,
  now: number,
): Promise<{ items: AnnouncementJson[]; unreadCount: number }> {
  const rows = await db
    .prepare(
      `SELECT a.*, ar.read_at AS read_at
         FROM announcements a
         LEFT JOIN announcement_reads ar
           ON ar.announcement_id = a.id AND ar.user_id = ?3
        WHERE ${VISIBLE_WHERE}
        ORDER BY a.starts_at DESC, a.id DESC`,
    )
    .bind(storeId, now, userId)
    .all<VisibleRow>();
  const items = rows.results.map((row) =>
    announcementJson(row, { read: row.read_at !== null }),
  );
  return { items, unreadCount: items.filter((i) => !i.read).length };
}

/** 見える範囲の 1 件 (掲載期間外・他店舗宛は null) */
export async function getVisibleAnnouncement(
  db: D1Database,
  storeId: number,
  userId: number,
  id: number,
  now: number,
): Promise<AnnouncementJson | null> {
  const row = await db
    .prepare(
      `SELECT a.*, ar.read_at AS read_at
         FROM announcements a
         LEFT JOIN announcement_reads ar
           ON ar.announcement_id = a.id AND ar.user_id = ?3
        WHERE a.id = ?4 AND ${VISIBLE_WHERE}`,
    )
    .bind(storeId, now, userId, id)
    .first<VisibleRow>();
  if (!row) return null;
  return announcementJson(row, { read: row.read_at !== null });
}

/** 既読化 (冪等) */
export async function markAnnouncementRead(
  db: D1Database,
  announcementId: number,
  userId: number,
  now: number,
): Promise<void> {
  await db
    .prepare(
      `INSERT OR IGNORE INTO announcement_reads (announcement_id, user_id, read_at)
       VALUES (?1, ?2, ?3)`,
    )
    .bind(announcementId, userId, now)
    .run();
}

/** 管理一覧 1 件分に readCount / targetUsers を付けた JSON を作る */
export async function announcementAdminJson(
  db: D1Database,
  row: AnnouncementRow,
): Promise<AnnouncementJson> {
  const [readCount, targetUsers] = await Promise.all([
    countAnnouncementReads(db, row.id),
    countTargetUsers(db, row.store_id),
  ]);
  return announcementJson(row, { readCount, targetUsers });
}
