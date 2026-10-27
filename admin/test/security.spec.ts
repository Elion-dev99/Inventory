import { env, SELF } from 'cloudflare:test';
import { exportJWK, generateKeyPair, SignJWT, type KeyLike } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
import initSql from '../../workers/migrations/0001_init.sql?raw';
import seedSql from '../../workers/migrations/0002_seed_roles.sql?raw';
import permissionsSql from '../../workers/migrations/0003_permissions.sql?raw';
import sessionsSql from '../../workers/migrations/0004_sessions.sql?raw';
import businessSql from '../../workers/migrations/0005_business_completion.sql?raw';
import featuresSql from '../../workers/migrations/0006_feature_flags.sql?raw';
import purchasingSql from '../../workers/migrations/0007_purchasing_analytics.sql?raw';
import multiStoreSql from '../../workers/migrations/0008_multi_store.sql?raw';
import sessionScopeSql from '../../workers/migrations/0009_session_scope.sql?raw';
import platformSettingsSql from '../../workers/migrations/0010_platform_settings.sql?raw';
import maintenanceWindowsSql from '../../workers/migrations/0011_maintenance_windows.sql?raw';
import maintenanceExtrasSql from '../../workers/migrations/0012_maintenance_extras.sql?raw';
import announcementsSql from '../../workers/migrations/0013_announcements.sql?raw';
import practicalSql from '../../workers/migrations/0014_practical.sql?raw';
import commercialSql from '../../workers/migrations/0015_commercial.sql?raw';
import operationsSql from '../../workers/migrations/0016_operations.sql?raw';
import securitySql from '../../workers/migrations/0017_security.sql?raw';
import passkeyVerifiedSql from '../../workers/migrations/0019_session_passkey_verified.sql?raw';
import { createSession, hashSessionToken } from '../../workers/src/lib/session';

/**
 * 全体管理 Worker のセキュリティ強化 (0017) 結合テスト:
 * - パスキー (WebAuthn) で platform ログインできる。全体管理者の割当が
 *   無いユーザーは正しい署名でも 403 で、セッションは作られない
 * - パスキーはこのホスト (rpId) で登録したものだけが使える
 * - 監査ハッシュチェーン: admin の監査 INSERT がチェーン経由になり、
 *   整合性チェックで改ざんを検出できる
 * - ステップアップ: 復元・全セッション失効は未実施で 403、パスキー /
 *   Google 再ログインで実施すると通る
 * - セキュリティヘッダと Origin チェック
 * - 自分の platform セッション一覧 / 失効
 *
 * ユーザー: 1 = 全体管理者 (SYSTEM_ADMIN・store_id NULL)、
 *           2 = 店舗1のスタッフ (全体割当なし)。
 * SELF.fetch のホストは example.com のため rpId = 'example.com'。
 */

const ISSUER = 'https://accounts.google.com';
const AUDIENCE = '1099201950238-iq41o4dmf63nnitj43ifnfojqvtbip8s.apps.googleusercontent.com';
const RP_ID = 'example.com';
const ORIGIN = 'https://example.com';
const STEPUP_NONCE = 'nonce-stepup-1';
const IPHONE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

interface TestEnv {
  DB: D1Database;
}
const testEnv = env as unknown as TestEnv;

// ------------------------------------------------------------ 小物ユーティリティ

function b64urlEncode(bytes: Uint8Array): string {
  let s = '';
  bytes.forEach((b) => {
    s += String.fromCharCode(b);
  });
  return btoa(s).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

function b64urlDecodeBytes(text: string): Uint8Array {
  const b64 = text.replaceAll('-', '+').replaceAll('_', '/');
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

function u32be(n: number): Uint8Array {
  return new Uint8Array([(n >>> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]);
}

function u16be(n: number): Uint8Array {
  return new Uint8Array([(n >> 8) & 0xff, n & 0xff]);
}

async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource));
}

// ------------------------------------------------------------ 最小 CBOR エンコーダ

function cborHead(major: number, length: number): number[] {
  const mt = major << 5;
  if (length < 24) return [mt | length];
  if (length < 256) return [mt | 24, length];
  if (length < 65536) return [mt | 25, (length >> 8) & 0xff, length & 0xff];
  return [mt | 26, (length >>> 24) & 0xff, (length >> 16) & 0xff, (length >> 8) & 0xff, length & 0xff];
}

function cborEncode(value: unknown): Uint8Array {
  const bytes: number[] = [];
  const push = (arr: ArrayLike<number>): void => {
    for (let i = 0; i < arr.length; i++) bytes.push(arr[i] as number);
  };
  const encode = (v: unknown): void => {
    if (typeof v === 'number') {
      if (!Number.isInteger(v)) throw new Error('CBOR fixture supports integers only');
      if (v >= 0) push(cborHead(0, v));
      else push(cborHead(1, -1 - v));
    } else if (typeof v === 'string') {
      const u = new TextEncoder().encode(v);
      push(cborHead(3, u.length));
      push(u);
    } else if (v instanceof Uint8Array) {
      push(cborHead(2, v.length));
      push(v);
    } else if (Array.isArray(v)) {
      push(cborHead(4, v.length));
      v.forEach(encode);
    } else if (v instanceof Map) {
      push(cborHead(5, v.size));
      v.forEach((val, key) => {
        encode(key);
        encode(val);
      });
    } else if (v !== null && typeof v === 'object') {
      const entries = Object.entries(v as Record<string, unknown>);
      push(cborHead(5, entries.length));
      entries.forEach(([k, val]) => {
        encode(k);
        encode(val);
      });
    } else {
      throw new Error('unsupported CBOR fixture value');
    }
  };
  encode(value);
  return new Uint8Array(bytes);
}

// ------------------------------------------------------------ DER 変換

function derInteger(b: Uint8Array): Uint8Array {
  let start = 0;
  while (start < b.length - 1 && b[start] === 0) start++;
  const trimmed = b.slice(start);
  const pad = (trimmed[0] as number) >= 0x80 ? 1 : 0;
  const out = new Uint8Array(2 + pad + trimmed.length);
  out[0] = 0x02;
  out[1] = pad + trimmed.length;
  if (pad) out[2] = 0;
  out.set(trimmed, 2 + pad);
  return out;
}

function rawEcdsaToDer(raw: Uint8Array): Uint8Array {
  const r = derInteger(raw.slice(0, 32));
  const s = derInteger(raw.slice(32, 64));
  const out = new Uint8Array(2 + r.length + s.length);
  out[0] = 0x30;
  out[1] = r.length + s.length;
  out.set(r, 2);
  out.set(s, 2 + r.length);
  return out;
}

// ------------------------------------------------------------ テスト用 authenticator

class TestAuthenticator {
  signCount = 0;

  private constructor(
    readonly credentialId: Uint8Array,
    readonly keyPair: CryptoKeyPair,
    readonly jwk: JsonWebKey,
  ) {}

  static async create(): Promise<TestAuthenticator> {
    const keyPair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
      'sign',
      'verify',
    ])) as CryptoKeyPair;
    const jwk = (await crypto.subtle.exportKey('jwk', keyPair.publicKey)) as JsonWebKey;
    return new TestAuthenticator(crypto.getRandomValues(new Uint8Array(16)), keyPair, jwk);
  }

  get credentialIdB64(): string {
    return b64urlEncode(this.credentialId);
  }

  /** DB へ直接クレデンシャルを置くための JWK JSON (x/y のみ) */
  get publicKeyJwkJson(): string {
    return JSON.stringify({ kty: 'EC', crv: 'P-256', x: this.jwk.x, y: this.jwk.y });
  }

  private async rpIdHash(rpId: string = RP_ID): Promise<Uint8Array> {
    return sha256(new TextEncoder().encode(rpId));
  }

  private clientData(type: string, challenge: string): Uint8Array {
    return new TextEncoder().encode(
      JSON.stringify({ type, challenge, origin: ORIGIN, crossOrigin: false }),
    );
  }

  async attestation(challenge: string): Promise<Record<string, unknown>> {
    const rpHash = await this.rpIdHash();
    const cose = cborEncode(
      new Map<number, unknown>([
        [1, 2],
        [3, -7],
        [-1, 1],
        [-2, b64urlDecodeBytes(this.jwk.x ?? '')],
        [-3, b64urlDecodeBytes(this.jwk.y ?? '')],
      ]),
    );
    const authData = concatBytes([
      rpHash,
      new Uint8Array([0x45]), // UP | UV | AT
      u32be(this.signCount),
      new Uint8Array(16),
      u16be(this.credentialId.length),
      this.credentialId,
      cose,
    ]);
    const attestationObject = cborEncode({
      fmt: 'none',
      attStmt: new Map<string, unknown>(),
      authData,
    });
    return {
      credentialId: this.credentialIdB64,
      clientDataJSON: b64urlEncode(this.clientData('webauthn.create', challenge)),
      attestationObject: b64urlEncode(attestationObject),
      transports: ['internal'],
    };
  }

  async assertion(
    challenge: string,
    opts: { count?: number; rpId?: string } = {},
  ): Promise<Record<string, unknown>> {
    const count = opts.count ?? this.signCount + 1;
    this.signCount = count;
    const rpHash = await this.rpIdHash(opts.rpId ?? RP_ID);
    const authData = concatBytes([rpHash, new Uint8Array([0x05]), u32be(count)]); // UP | UV
    const clientData = this.clientData('webauthn.get', challenge);
    const signed = concatBytes([authData, await sha256(clientData)]);
    const rawSig = new Uint8Array(
      await crypto.subtle.sign(
        { name: 'ECDSA', hash: 'SHA-256' },
        this.keyPair.privateKey,
        signed as BufferSource,
      ),
    );
    return {
      credentialId: this.credentialIdB64,
      clientDataJSON: b64urlEncode(clientData),
      authenticatorData: b64urlEncode(authData),
      signature: b64urlEncode(rawEcdsaToDer(rawSig)),
    };
  }
}

// ------------------------------------------------------------ HTTP ヘルパー

interface ApiResult {
  status: number;
  headers: Headers;
  text: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
}

async function api(
  path: string,
  opts: { cookie?: string; method?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<ApiResult> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', ...(opts.headers ?? {}) };
  if (opts.cookie) headers.Cookie = `admin_session=${opts.cookie}`;
  const res = await SELF.fetch(`https://example.com${path}`, {
    method: opts.method ?? 'GET',
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
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

function setCookieOf(res: Response | ApiResult): string {
  const anyHeaders = res.headers as Headers & { getSetCookie?: () => string[] };
  const list = typeof anyHeaders.getSetCookie === 'function' ? anyHeaders.getSetCookie() : [];
  if (list.length > 0) return list.join(', ');
  return res.headers.get('set-cookie') ?? '';
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

async function platformSessionCount(userId: number): Promise<number> {
  const row = await testEnv.DB.prepare(
    "SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?1 AND scope = 'platform'",
  )
    .bind(userId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

let authAdmin: TestAuthenticator;
let authStaff: TestAuthenticator;

beforeAll(async () => {
  // Google の JWKS とトークン交換を差し替える (ステップアップ再ログイン用)
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = await exportJWK(publicKey);
  jwk.kid = 'test-key-1';
  jwk.alg = 'RS256';
  jwk.use = 'sig';
  const adminIdToken = await new SignJWT({
    email: 'platform@example.com',
    name: 'Platform',
    nonce: STEPUP_NONCE,
  })
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key-1' })
    .setSubject('sub-platform-admin')
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(privateKey as KeyLike);
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (url === 'https://www.googleapis.com/oauth2/v3/certs') {
      return new Response(JSON.stringify({ keys: [jwk] }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url === 'https://oauth2.googleapis.com/token') {
      return new Response(JSON.stringify({ id_token: adminIdToken }), {
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
    ...statementsOf(commercialSql),
    ...statementsOf(operationsSql),
    ...statementsOf(securitySql),
    ...statementsOf(passkeyVerifiedSql),
  ]) {
    await testEnv.DB.prepare(stmt).run();
  }
  const now = Date.now();
  await testEnv.DB.batch([
    testEnv.DB.prepare(
      `INSERT INTO users (id, external_id, email, display_name, status, created_at, updated_at)
       VALUES (1, 'sub-platform-admin', 'platform@example.com', 'Platform', 'active', ?1, ?1),
              (2, 'sub-staff', 'staff@example.com', 'Staff', 'active', ?1, ?1)`,
    ).bind(now),
    testEnv.DB.prepare(
      `INSERT INTO user_roles (user_id, role_code, warehouse_id, store_id)
       VALUES (1, 'SYSTEM_ADMIN', NULL, NULL), (2, 'INVENTORY_STAFF', NULL, 1)`,
    ),
    testEnv.DB.prepare(
      `INSERT INTO warehouses (id, code, name, store_id, created_at, updated_at)
       VALUES (1, 'WH1', '本社倉庫', 1, ?1, ?1)`,
    ).bind(now),
  ]);
  authAdmin = await TestAuthenticator.create();
  authStaff = await TestAuthenticator.create();
});

// ------------------------------------------------------- ヘッダ / Origin

describe('セキュリティヘッダと Origin チェック', () => {
  it('コンソールと API レスポンスにセキュリティヘッダが付く', async () => {
    const page = await SELF.fetch('https://example.com/');
    expect(page.status).toBe(200);
    const csp = page.headers.get('content-security-policy') ?? '';
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(page.headers.get('x-content-type-options')).toBe('nosniff');
    expect(page.headers.get('referrer-policy')).toBe('no-referrer');
    const html = await page.text();
    expect(html).toContain('Face IDでログイン');
    expect(html).toContain('auditIntegrityBtn');
    expect(html).toContain('passkeyRegisterBtn');
    expect(html).toContain('stepUpOverlay');

    const unauthorized = await SELF.fetch('https://example.com/api/platform/me');
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.headers.get('content-security-policy')).toContain("default-src 'self'");
  });

  it('他オリジンからの状態変更は 403、自オリジンは通る', async () => {
    const token = await createSession(testEnv.DB, 1, { scope: 'platform' });
    const evil = await api('/api/platform/stores', {
      cookie: token,
      method: 'POST',
      body: { code: 'EVIL', name: '他オリジン' },
      headers: { Origin: 'https://evil.example.com' },
    });
    expect(evil.status).toBe(403);
    expect(evil.body.error).toBe('ORIGIN_MISMATCH');

    const same = await api('/api/platform/stores', {
      cookie: token,
      method: 'POST',
      body: { code: 'ORG1', name: '自オリジン' },
      headers: { Origin: ORIGIN },
    });
    expect(same.status).toBe(201);
  });
});

// ------------------------------------------------------- パスキーログイン

describe('パスキーログイン (platform スコープ)', () => {
  it('このホストで登録したパスキーでログインでき、履歴に残る', async () => {
    const session = await createSession(testEnv.DB, 1, { scope: 'platform' });

    const options = await api('/api/platform/auth/passkey/register/options', {
      cookie: session,
      method: 'POST',
      body: {},
    });
    expect(options.status).toBe(200);
    expect(options.body.rp.id).toBe(RP_ID);

    const attestation = await authAdmin.attestation(options.body.challenge as string);
    const verify = await api('/api/platform/auth/passkey/register/verify', {
      cookie: session,
      method: 'POST',
      body: attestation,
    });
    expect(verify.status).toBe(201);
    expect(verify.body.credentialId).toBe(authAdmin.credentialIdB64);

    // ログイン (未認証で options が取れる)
    const loginOptions = await api('/api/platform/auth/passkey/login/options', {
      method: 'POST',
      body: {},
    });
    expect(loginOptions.status).toBe(200);
    const assertion = await authAdmin.assertion(loginOptions.body.challenge as string);
    const login = await api('/api/platform/auth/passkey/login/verify', {
      method: 'POST',
      body: assertion,
      headers: { 'User-Agent': IPHONE_UA },
    });
    expect(login.status).toBe(200);
    const setCookie = setCookieOf(login);
    expect(setCookie).toContain('admin_session=');
    const newToken = setCookie.match(/admin_session=([^;,]+)/)?.[1] ?? '';
    expect(newToken).not.toBe('');

    const me = await api('/api/platform/me', { cookie: newToken });
    expect(me.status).toBe(200);
    expect(me.body.email).toBe('platform@example.com');
    expect(me.body.isPlatformAdmin).toBe(true);

    // 発行されたセッションは platform スコープで、端末情報が記録されている
    const hash = await hashSessionToken(newToken);
    const row = await testEnv.DB.prepare(
      'SELECT scope, user_agent FROM sessions WHERE token_hash = ?1',
    )
      .bind(hash)
      .first<{ scope: string; user_agent: string | null }>();
    expect(row?.scope).toBe('platform');
    expect(row?.user_agent).toBe(IPHONE_UA);

    // ログイン履歴に passkey の記録が残る
    const event = await testEnv.DB.prepare(
      "SELECT device_label FROM login_events WHERE user_id = 1 AND method = 'passkey'",
    ).first<{ device_label: string }>();
    expect(event?.device_label).toBe('iPhone Safari');
  });

  it('全体割当のないユーザーは正しい署名でも 403 で、セッションは作られない', async () => {
    // スタッフのクレデンシャルを DB に直接置く (登録自体はコンソールではできない)
    const now = Date.now();
    await testEnv.DB.prepare(
      `INSERT INTO passkey_credentials (user_id, credential_id, public_key_jwk, sign_count, transports, label, created_at, last_used_at)
       VALUES (2, ?1, ?2, 0, NULL, NULL, ?3, NULL)`,
    )
      .bind(authStaff.credentialIdB64, authStaff.publicKeyJwkJson, now)
      .run();

    const before = await platformSessionCount(2);
    const loginOptions = await api('/api/platform/auth/passkey/login/options', {
      method: 'POST',
      body: {},
    });
    const assertion = await authStaff.assertion(loginOptions.body.challenge as string);
    const login = await api('/api/platform/auth/passkey/login/verify', {
      method: 'POST',
      body: assertion,
    });
    expect(login.status).toBe(403);
    expect(login.body.error).toBe('PLATFORM_ADMIN_REQUIRED');
    expect(setCookieOf(login)).not.toContain('admin_session=');
    expect(await platformSessionCount(2)).toBe(before);
  });

  it('別ホスト (rpId) 向けの assertion は拒否される', async () => {
    const loginOptions = await api('/api/platform/auth/passkey/login/options', {
      method: 'POST',
      body: {},
    });
    const foreign = await authAdmin.assertion(loginOptions.body.challenge as string, {
      rpId: 'inventory-system-workers.example.com',
    });
    const login = await api('/api/platform/auth/passkey/login/verify', {
      method: 'POST',
      body: foreign,
    });
    expect(login.status).toBe(400);
    expect(login.body.error).toBe('PASSKEY_VERIFICATION_FAILED');
  });
});

// ------------------------------------------------------- 監査チェーン

describe('監査ハッシュチェーン', () => {
  it('admin の監査がチェーン経由で書かれ、改ざんを検出できる', async () => {
    const token = await createSession(testEnv.DB, 1, { scope: 'platform' });
    const created = await api('/api/platform/stores', {
      cookie: token,
      method: 'POST',
      body: { code: 'CHAIN1', name: 'チェーン検証店' },
    });
    expect(created.status).toBe(201);

    const row = await testEnv.DB.prepare(
      "SELECT id, prev_hash, row_hash, payload FROM audit_logs WHERE action = 'platform.store.create' ORDER BY id DESC LIMIT 1",
    ).first<{ id: number; prev_hash: string | null; row_hash: string | null; payload: string }>();
    expect(row?.row_hash).not.toBeNull();
    expect(row?.prev_hash).not.toBeNull();

    const okRes = await api('/api/platform/audit-integrity', { cookie: token });
    expect(okRes.status).toBe(200);
    expect(okRes.body.ok).toBe(true);
    expect(okRes.body.checked).toBeGreaterThanOrEqual(1);
    expect(okRes.body.brokenAtId).toBeNull();

    await testEnv.DB.prepare("UPDATE audit_logs SET payload = '{\"tampered\":true}' WHERE id = ?1")
      .bind(row?.id)
      .run();
    const broken = await api('/api/platform/audit-integrity', { cookie: token });
    expect(broken.status).toBe(200);
    expect(broken.body.ok).toBe(false);
    expect(broken.body.brokenAtId).toBe(row?.id);

    // 後続テストに影響しないよう元へ戻す
    await testEnv.DB.prepare('UPDATE audit_logs SET payload = ?1 WHERE id = ?2')
      .bind(row?.payload, row?.id)
      .run();
    const restored = await api('/api/platform/audit-integrity', { cookie: token });
    expect(restored.body.ok).toBe(true);
  });

  it('機能フラグの監査 (batch 経由) もチェーンに繋がる', async () => {
    const token = await createSession(testEnv.DB, 1, { scope: 'platform' });
    const res = await api('/api/platform/stores/1/features/alerts', {
      cookie: token,
      method: 'PUT',
      body: { enabled: false },
    });
    expect(res.status).toBe(200);
    const row = await testEnv.DB.prepare(
      "SELECT row_hash FROM audit_logs WHERE action = 'feature_flag.update' ORDER BY id DESC LIMIT 1",
    ).first<{ row_hash: string | null }>();
    expect(row?.row_hash).not.toBeNull();
    const check = await api('/api/platform/audit-integrity', { cookie: token });
    expect(check.body.ok).toBe(true);
  });
});

// ------------------------------------------------------- ステップアップ

describe('重要操作のステップアップ', () => {
  it('未実施で復元・全セッション失効が 403、パスキー再認証で通る', async () => {
    const token = await createSession(testEnv.DB, 1, {
      scope: 'platform',
      userAgent: IPHONE_UA,
      ip: '10.0.0.9',
    });
    const backup = await api('/api/platform/backups', { cookie: token, method: 'POST', body: {} });
    expect(backup.status).toBe(201);
    const backupId = backup.body.id as number;

    // ログイン直後 (step_up_at = 発行時刻) は復元できる
    const fresh = await api(`/api/platform/backups/${backupId}/restore`, {
      cookie: token,
      method: 'POST',
      body: {},
    });
    expect(fresh.status).toBe(200);

    // step_up_at を 11 分前に巻き戻すと、対象操作はどちらも 403 になる
    const hash = await hashSessionToken(token);
    await testEnv.DB.prepare('UPDATE sessions SET step_up_at = ?1 WHERE token_hash = ?2')
      .bind(Date.now() - 11 * 60 * 1000, hash)
      .run();
    const staleRestore = await api(`/api/platform/backups/${backupId}/restore`, {
      cookie: token,
      method: 'POST',
      body: {},
    });
    expect(staleRestore.status).toBe(403);
    expect(staleRestore.body.error).toBe('STEP_UP_REQUIRED');
    const staleRevoke = await api('/api/platform/revoke-all-sessions', {
      cookie: token,
      method: 'POST',
      body: {},
    });
    expect(staleRevoke.status).toBe(403);
    expect(staleRevoke.body.error).toBe('STEP_UP_REQUIRED');

    // パスキーでステップアップすると再び通る
    const options = await api('/api/platform/auth/passkey/step-up/options', {
      cookie: token,
      method: 'POST',
      body: {},
    });
    expect(options.status).toBe(200);
    const assertion = await authAdmin.assertion(options.body.challenge as string);
    const stepUp = await api('/api/platform/auth/step-up/passkey', {
      cookie: token,
      method: 'POST',
      body: assertion,
    });
    expect(stepUp.status).toBe(200);

    const afterRestore = await api(`/api/platform/backups/${backupId}/restore`, {
      cookie: token,
      method: 'POST',
      body: {},
    });
    expect(afterRestore.status).toBe(200);
    const afterRevoke = await api('/api/platform/revoke-all-sessions', {
      cookie: token,
      method: 'POST',
      body: {},
    });
    expect(afterRevoke.status).toBe(200);
  });

  it('Google 再ログイン (?stepup=1) で step_up_at が打ち直される', async () => {
    const token = await createSession(testEnv.DB, 1, { scope: 'platform' });
    const hash = await hashSessionToken(token);
    const stale = Date.now() - 11 * 60 * 1000;
    await testEnv.DB.prepare('UPDATE sessions SET step_up_at = ?1 WHERE token_hash = ?2')
      .bind(stale, hash)
      .run();
    const sessionsBefore = await platformSessionCount(1);

    // ログイン開始: stepup 用は prompt=login と oauth_stepup Cookie を伴う
    const loginRes = await SELF.fetch('https://example.com/auth/login?stepup=1', {
      redirect: 'manual',
    });
    expect(loginRes.status).toBe(302);
    expect(loginRes.headers.get('location') ?? '').toContain('prompt=login');
    expect(setCookieOf(loginRes)).toContain('oauth_stepup=');

    const callback = await SELF.fetch('https://example.com/auth/callback?code=admin-code', {
      redirect: 'manual',
      headers: {
        Cookie: `admin_session=${token}; oauth_nonce=${STEPUP_NONCE}; oauth_stepup=${STEPUP_NONCE}`,
      },
    });
    expect(callback.status).toBe(302);
    expect(callback.headers.get('location')).toBe('/');

    // 新規セッションは発行されず、既存セッションの step_up_at だけが更新される
    expect(await platformSessionCount(1)).toBe(sessionsBefore);
    const row = await testEnv.DB.prepare('SELECT step_up_at FROM sessions WHERE token_hash = ?1')
      .bind(hash)
      .first<{ step_up_at: number | null }>();
    expect(row?.step_up_at).not.toBeNull();
    expect(row?.step_up_at as number).toBeGreaterThan(stale);
  });
});

// ------------------------------------------------------- 自分のセッション

describe('自分の platform セッション', () => {
  it('一覧は platform スコープだけを返し、他セッションを失効できる', async () => {
    const a = await createSession(testEnv.DB, 1, { scope: 'platform', userAgent: IPHONE_UA });
    const b = await createSession(testEnv.DB, 1, { scope: 'platform' });
    await createSession(testEnv.DB, 1, { scope: 'app' });

    const list = await api('/api/platform/auth/sessions', { cookie: a });
    expect(list.status).toBe(200);
    expect(Array.isArray(list.body)).toBe(true);
    const aHash = await hashSessionToken(a);
    const bHash = await hashSessionToken(b);
    const aRow = await testEnv.DB.prepare('SELECT id FROM sessions WHERE token_hash = ?1')
      .bind(aHash)
      .first<{ id: number }>();
    const bRow = await testEnv.DB.prepare('SELECT id FROM sessions WHERE token_hash = ?1')
      .bind(bHash)
      .first<{ id: number }>();
    const ids = (list.body as { id: number }[]).map((s) => s.id);
    expect(ids).toContain(aRow?.id);
    expect(ids).toContain(bRow?.id);
    // app スコープのセッションは含まれない (件数は platform 分だけ)
    const platformCount = await platformSessionCount(1);
    expect(list.body.length).toBe(platformCount);
    const current = (list.body as { id: number; current: boolean }[]).find((s) => s.current);
    expect(current?.id).toBe(aRow?.id);
    const mine = (list.body as { id: number; userAgent: string | null }[]).find((s) => s.id === aRow?.id);
    expect(mine?.userAgent).toBe(IPHONE_UA);

    // 現在のセッション自身は消せない
    const delCurrent = await api(`/api/platform/auth/sessions/${aRow?.id}`, {
      cookie: a,
      method: 'DELETE',
    });
    expect(delCurrent.status).toBe(400);
    expect(delCurrent.body.error).toBe('CURRENT_SESSION');

    // 他のセッション (b) を失効させると、その Cookie は使えなくなる
    const del = await api(`/api/platform/auth/sessions/${bRow?.id}`, {
      cookie: a,
      method: 'DELETE',
    });
    expect(del.status).toBe(200);
    const meB = await api('/api/platform/me', { cookie: b });
    expect(meB.status).toBe(401);
    const meA = await api('/api/platform/me', { cookie: a });
    expect(meA.status).toBe(200);
  });

  it('全体管理者でないユーザーはセッション API を使えない', async () => {
    const staff = await createSession(testEnv.DB, 2, { scope: 'platform' });
    const list = await api('/api/platform/auth/sessions', { cookie: staff });
    expect(list.status).toBe(403);
  });
});

// --------------------------------------------- パスキー必須モード

describe('全体管理コンソールのパスキー必須モード', () => {
  async function setPasskeyOnly(on: boolean): Promise<void> {
    await testEnv.DB.prepare(
      `INSERT INTO platform_settings (key, value, updated_by, updated_at) VALUES ('platform_passkey_only', ?1, 1, ?2)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    )
      .bind(on ? '1' : '0', new Date().toISOString())
      .run();
  }

  it('有効時は未確認セッションを 403 にし、パスキーのステップアップで通る', async () => {
    // 無効時は通常どおり使える
    await setPasskeyOnly(false);
    const token = await createSession(testEnv.DB, 1, { scope: 'platform' });
    const offRes = await api('/api/platform/overview', { cookie: token });
    expect(offRes.status).toBe(200);

    await setPasskeyOnly(true);
    try {
      const config = await api('/auth/config');
      expect(config.status).toBe(200);
      expect(config.body.passkeyOnly).toBe(true);

      // /me は通り、状態が返る
      const me = await api('/api/platform/me', { cookie: token });
      expect(me.status).toBe(200);
      expect(me.body.passkeyOnly).toBe(true);
      expect(me.body.passkeyVerified).toBe(false);

      // 通常 API は PASSKEY_REQUIRED で遮断される
      const blocked = await api('/api/platform/overview', { cookie: token });
      expect(blocked.status).toBe(403);
      expect(blocked.body.error).toBe('PASSKEY_REQUIRED');

      // パスキー確認済みセッションは最初から通る
      const verified = await createSession(testEnv.DB, 1, { scope: 'platform', passkeyVerified: true });
      const okRes = await api('/api/platform/overview', { cookie: verified });
      expect(okRes.status).toBe(200);

      // Google 発行セッションもパスキーのステップアップで確認済みになる
      const options = await api('/api/platform/auth/passkey/step-up/options', {
        cookie: token,
        method: 'POST',
        body: {},
      });
      expect(options.status).toBe(200);
      const assertion = await authAdmin.assertion(options.body.challenge as string);
      const stepUp = await api('/api/platform/auth/step-up/passkey', {
        cookie: token,
        method: 'POST',
        body: assertion,
      });
      expect(stepUp.status).toBe(200);
      const after = await api('/api/platform/overview', { cookie: token });
      expect(after.status).toBe(200);
      const meAfter = await api('/api/platform/me', { cookie: token });
      expect(meAfter.body.passkeyVerified).toBe(true);
    } finally {
      await setPasskeyOnly(false);
    }
  });
});

// --------------------------------------------- ステップアップ範囲

describe('ステップアップ必須の範囲拡大', () => {
  async function rewindStepUp(token: string): Promise<void> {
    const hash = await hashSessionToken(token);
    await testEnv.DB.prepare('UPDATE sessions SET step_up_at = ?1 WHERE token_hash = ?2')
      .bind(Date.now() - 11 * 60 * 1000, hash)
      .run();
  }

  it('プラットフォームエクスポートは再認証が必要', async () => {
    const token = await createSession(testEnv.DB, 1, { scope: 'platform' });
    const freshPrepare = await api('/api/platform/export/prepare', { cookie: token, method: 'POST', body: {} });
    expect(freshPrepare.status).toBe(200);
    const freshExport = await api('/api/platform/export.json', { cookie: token });
    expect(freshExport.status).toBe(200);

    await rewindStepUp(token);
    const stalePrepare = await api('/api/platform/export/prepare', { cookie: token, method: 'POST', body: {} });
    expect(stalePrepare.status).toBe(403);
    expect(stalePrepare.body.error).toBe('STEP_UP_REQUIRED');
    const staleExport = await api('/api/platform/export.json', { cookie: token });
    expect(staleExport.status).toBe(403);
    expect(staleExport.body.error).toBe('STEP_UP_REQUIRED');
  });

  it('緊急メンテナンスの作成は再認証が必要 (通常枠は不要)', async () => {
    const now = Date.now();
    const emergencyBody = {
      kind: 'once',
      startsAt: now + 60 * 60 * 1000,
      endsAt: now + 2 * 60 * 60 * 1000,
      level: 'full',
      emergency: true,
      reason: 'テスト緊急停止',
    };
    const token = await createSession(testEnv.DB, 1, { scope: 'platform' });
    await rewindStepUp(token);
    const stale = await api('/api/platform/maintenance/windows', { cookie: token, method: 'POST', body: emergencyBody });
    expect(stale.status).toBe(403);
    expect(stale.body.error).toBe('STEP_UP_REQUIRED');

    const normal = await api('/api/platform/maintenance/windows', {
      cookie: token,
      method: 'POST',
      body: { kind: 'once', startsAt: now + 24 * 60 * 60 * 1000, endsAt: now + 25 * 60 * 60 * 1000, level: 'read_only' },
    });
    expect(normal.status).toBe(201);

    const fresh = await createSession(testEnv.DB, 1, { scope: 'platform' });
    const okRes = await api('/api/platform/maintenance/windows', { cookie: fresh, method: 'POST', body: emergencyBody });
    expect(okRes.status).toBe(201);
  });

});
