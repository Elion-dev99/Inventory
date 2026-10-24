import { env, SELF } from 'cloudflare:test';
import { exportJWK, generateKeyPair, SignJWT, type KeyLike } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
import initSql from '../migrations/0001_init.sql?raw';
import seedSql from '../migrations/0002_seed_roles.sql?raw';
import permissionsSql from '../migrations/0003_permissions.sql?raw';
import sessionsSql from '../migrations/0004_sessions.sql?raw';
import businessSql from '../migrations/0005_business_completion.sql?raw';
import featuresSql from '../migrations/0006_feature_flags.sql?raw';
import purchasingSql from '../migrations/0007_purchasing_analytics.sql?raw';
import multiStoreSql from '../migrations/0008_multi_store.sql?raw';
import sessionScopeSql from '../migrations/0009_session_scope.sql?raw';
import platformSettingsSql from '../migrations/0010_platform_settings.sql?raw';
import maintenanceWindowsSql from '../migrations/0011_maintenance_windows.sql?raw';
import maintenanceExtrasSql from '../migrations/0012_maintenance_extras.sql?raw';
import announcementsSql from '../migrations/0013_announcements.sql?raw';
import practicalSql from '../migrations/0014_practical.sql?raw';
import { SCAN_WASM_BYTE_LENGTH } from '../src/scan-assets';

/**
 * バーコードスキャン作り替えの結合テスト:
 * - エンジンアセット (/assets/scan/*) が正しい Content-Type で 200 を返す
 *   (miniflare 環境でも本番と同じ経路で配信されること)
 * - スキャンカウントが使う読み取り・書き込みパターン:
 *   マスタにバーコードが含まれること、明細にロット選択の材料
 *   (productId / locationId / expiryDate) があること、実数の絶対値 PUT が
 *   連続スキャンの加算どおりに積み上がること
 */

const ISSUER = 'https://accounts.google.com';
const AUDIENCE = '1099201950238-iq41o4dmf63nnitj43ifnfojqvtbip8s.apps.googleusercontent.com';

interface TestEnv {
  DB: D1Database;
}
const testEnv = env as unknown as TestEnv;

let managerToken = '';
let idemSeq = 0;

async function mintToken(sub: string, email: string, privateKey: KeyLike): Promise<string> {
  return new SignJWT({ email, name: sub })
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key-1' })
    .setSubject(sub)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(privateKey);
}

interface ApiResult {
  status: number;
  headers: Headers;
  text: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
}

async function api(
  path: string,
  token: string,
  init: { method?: string; body?: unknown } = {},
): Promise<ApiResult> {
  idemSeq += 1;
  const headers: Record<string, string> = { 'Idempotency-Key': `scan-${idemSeq}` };
  if (token) headers.Authorization = `Bearer ${token}`;
  let body: BodyInit | undefined;
  if (init.body !== undefined) {
    body = JSON.stringify(init.body);
    headers['Content-Type'] = 'application/json';
  }
  const res = await SELF.fetch(`https://example.com${path}`, {
    method: init.method ?? 'GET',
    headers,
    body,
  });
  const text = await res.text();
  let parsed: unknown = {};
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = {};
  }
  return { status: res.status, headers: res.headers, text, body: parsed };
}

function statementsOf(sql: string): string[] {
  return sql
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n')
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

beforeAll(async () => {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = await exportJWK(publicKey);
  jwk.kid = 'test-key-1';
  jwk.alg = 'RS256';
  jwk.use = 'sig';
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (url === 'https://www.googleapis.com/oauth2/v3/certs') {
      return new Response(JSON.stringify({ keys: [jwk] }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return realFetch(input, init);
  }) as typeof fetch;

  for (const stmt of [
    ...statementsOf(initSql),
    ...statementsOf(seedSql),
    ...statementsOf(permissionsSql),
    ...statementsOf(sessionsSql),
    ...statementsOf(businessSql),
    ...statementsOf(featuresSql),
    ...statementsOf(purchasingSql),
    ...statementsOf(multiStoreSql),
    ...statementsOf(sessionScopeSql),
    ...statementsOf(platformSettingsSql),
    ...statementsOf(maintenanceWindowsSql),
    ...statementsOf(maintenanceExtrasSql),
    ...statementsOf(announcementsSql),
    ...statementsOf(practicalSql),
  ]) {
    await testEnv.DB.prepare(stmt).run();
  }
  const now = Date.now();
  await testEnv.DB.batch([
    testEnv.DB.prepare(
      `INSERT INTO users (id, external_id, email, display_name, status, created_at, updated_at)
       VALUES (2, 'sub-manager', 'manager@example.com', 'Manager', 'active', ?1, ?1)`,
    ).bind(now),
    testEnv.DB.prepare(
      `INSERT INTO warehouses (id, code, name, created_at, updated_at)
       VALUES (1, 'WH1', '本社倉庫', ?1, ?1)`,
    ).bind(now),
    testEnv.DB.prepare(
      `INSERT INTO user_roles (user_id, role_code, warehouse_id, store_id)
       VALUES (2, 'INVENTORY_MANAGER', NULL, 1)`,
    ),
    testEnv.DB.prepare(
      `INSERT INTO locations (id, warehouse_id, code, name, created_at, updated_at)
       VALUES (1, 1, 'A-1', '棚A-1', ?1, ?1)`,
    ).bind(now),
    testEnv.DB.prepare(
      `INSERT INTO products (id, sku, name, unit, barcode, safety_stock, requires_expiry, created_at, updated_at)
       VALUES (1, 'SKU-SCAN', 'スキャン検証品', '個', '4901234567894', 0, 1, ?1, ?1),
              (2, 'SKU-SCAN2', 'スキャン検証品2', '個', 'CODE128-TEST-123', 0, 0, ?1, ?1)`,
    ).bind(now),
  ]);
  managerToken = await mintToken('sub-manager', 'manager@example.com', privateKey);
});

describe('スキャンエンジンのアセット配信', () => {
  it('ワーカースクリプトが text/javascript で返り、エンジン初期化を含む', async () => {
    const res = await SELF.fetch('https://example.com/assets/scan/worker.js');
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/javascript');
    const text = await res.text();
    expect(text).toContain('readBarcodes');
    expect(text).toContain('zxing_reader.wasm');
    expect(text).toContain('scan-engine-');
  });

  it('glue JS (share / reader) が相対 import を保ったまま返る', async () => {
    const share = await SELF.fetch('https://example.com/assets/scan/es/share.js');
    expect(share.status).toBe(200);
    expect(share.headers.get('Content-Type')).toContain('text/javascript');

    const reader = await SELF.fetch('https://example.com/assets/scan/es/reader/index.js');
    expect(reader.status).toBe(200);
    expect(reader.headers.get('Content-Type')).toContain('text/javascript');
    const text = await reader.text();
    expect(text).toContain('../share.js');
    expect(text).toContain('zxing_reader.wasm');
  });

  it('wasm が application/wasm で返り、サイズとマジックが一致する', async () => {
    const res = await SELF.fetch('https://example.com/assets/scan/zxing_reader.wasm');
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('application/wasm');
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(bytes.length).toBe(SCAN_WASM_BYTE_LENGTH);
    expect(Array.from(bytes.slice(0, 4))).toEqual([0x00, 0x61, 0x73, 0x6d]);
  });
});

describe('スキャンカウントの読み書きパターン', () => {
  it('マスタ商品にバーコードが含まれ、スキャンで商品を解決できる材料が揃う', async () => {
    const list = await api('/api/v1/master/products?take=200', managerToken);
    expect(list.status).toBe(200);
    const rows = list.body as Record<string, unknown>[];
    expect(rows.find((p) => p.id === 1)?.barcode).toBe('4901234567894');
    expect(rows.find((p) => p.id === 2)?.barcode).toBe('CODE128-TEST-123');
  });

  it('明細にロット選択の材料があり、実数の絶対値 PUT が加算どおりに積み上がる', async () => {
    const inA = await api('/api/v1/movements/inbound', managerToken, {
      method: 'POST',
      body: { locationId: 1, productId: 1, lotCode: 'SCAN-A', quantity: 5, expiryDate: '2026-06-01' },
    });
    expect(inA.status).toBe(201);
    const inB = await api('/api/v1/movements/inbound', managerToken, {
      method: 'POST',
      body: { locationId: 1, productId: 1, lotCode: 'SCAN-B', quantity: 5, expiryDate: '2027-01-01' },
    });
    expect(inB.status).toBe(201);

    const start = await api('/api/v1/stocktakes', managerToken, { method: 'POST', body: {} });
    expect(start.status).toBe(201);
    const stocktakeId = start.body.id as number;

    const detail = await api(`/api/v1/stocktakes/${stocktakeId}`, managerToken);
    expect(detail.status).toBe(200);
    const lines = (detail.body.lines as Record<string, unknown>[]).filter(
      (ln) => ln.productId === 1 && ln.locationId === 1,
    );
    expect(lines.length).toBe(2);
    const earliest = lines.find((ln) => ln.lotCode === 'SCAN-A');
    const later = lines.find((ln) => ln.lotCode === 'SCAN-B');
    expect(earliest?.expiryDate).toBe('2026-06-01');
    expect(later?.expiryDate).toBe('2027-01-01');
    expect(earliest?.countedQuantity).toBeNull();

    // 連続スキャンの加算は絶対値 PUT の連鎖になる (1 → 2 → 3)
    for (const value of [1, 2, 3]) {
      const put = await api(
        `/api/v1/stocktakes/${stocktakeId}/lines/${earliest?.id}`,
        managerToken,
        { method: 'PUT', body: { countedQuantity: value } },
      );
      expect(put.status).toBe(200);
      expect(put.body.countedQuantity).toBe(value);
    }
    const after = await api(`/api/v1/stocktakes/${stocktakeId}`, managerToken);
    const linesAfter = (after.body.lines as Record<string, unknown>[]).filter(
      (ln) => ln.productId === 1 && ln.locationId === 1,
    );
    expect(linesAfter.find((ln) => ln.lotCode === 'SCAN-A')?.countedQuantity).toBe(3);
    // 期限の遅い行はスキャン加算の対象にならず未入力のまま
    expect(linesAfter.find((ln) => ln.lotCode === 'SCAN-B')?.countedQuantity).toBeNull();
  });
});
