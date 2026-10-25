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
import commercialSql from '../migrations/0015_commercial.sql?raw';
import operationsSql from '../migrations/0016_operations.sql?raw';
import securitySql from '../migrations/0017_security.sql?raw';
import { recordLoginEvent } from '../src/lib/login-events';
import { createSession, hashSessionToken } from '../src/lib/session';

/**
 * セキュリティ強化 (0017) の結合テスト:
 * - パスキー (WebAuthn): テスト用 authenticator (P-256 鍵 + CBOR フィクスチャ) で
 *   登録 -> ログインの一連、チャレンジ再利用・signCount 後退・他人の鍵での
 *   署名を拒否すること
 * - セキュリティヘッダと Origin チェック
 * - 自分のセッション一覧 / 失効
 * - ログイン履歴と新しい端末の判定 (通知はスタブで確認)
 * - 監査ハッシュチェーンの検証と改ざん検出
 * - 重要操作のステップアップ (未実施 403 -> パスキー再認証で可 -> 期限切れで再び 403)
 *
 * ユーザー: 2 = 店舗1の SYSTEM_ADMIN、3 = 店舗1の INVENTORY_STAFF。
 * SELF.fetch のホストは example.com のため rpId = 'example.com'、
 * origin = 'https://example.com' でフィクスチャを作る。
 */

const ISSUER = 'https://accounts.google.com';
const AUDIENCE = '1099201950238-iq41o4dmf63nnitj43ifnfojqvtbip8s.apps.googleusercontent.com';
const RP_ID = 'example.com';
const ORIGIN = 'https://example.com';
const IPHONE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

interface TestEnv {
  DB: D1Database;
}
const testEnv = env as unknown as TestEnv;

let managerToken = '';

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

// ------------------------------------------------------------ DER 変換 (WebCrypto は raw を返す)

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

  private async rpIdHash(): Promise<Uint8Array> {
    return sha256(new TextEncoder().encode(RP_ID));
  }

  private clientData(type: string, challenge: string): Uint8Array {
    return new TextEncoder().encode(
      JSON.stringify({ type, challenge, origin: ORIGIN, crossOrigin: false }),
    );
  }

  /** attestation (fmt 'none') のフィクスチャ。登録用ボディ (フラット形式) を返す */
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

  /** assertion のフィクスチャ。ログイン/ステップアップ用ボディ (フラット形式) を返す */
  async assertion(
    challenge: string,
    opts: { count?: number; signWith?: CryptoKeyPair } = {},
  ): Promise<Record<string, unknown>> {
    const count = opts.count ?? this.signCount + 1;
    this.signCount = count;
    const rpHash = await this.rpIdHash();
    const authData = concatBytes([rpHash, new Uint8Array([0x05]), u32be(count)]); // UP | UV
    const clientData = this.clientData('webauthn.get', challenge);
    const signed = concatBytes([authData, await sha256(clientData)]);
    const rawSig = new Uint8Array(
      await crypto.subtle.sign(
        { name: 'ECDSA', hash: 'SHA-256' },
        (opts.signWith ?? this.keyPair).privateKey,
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
  headers: Headers;
}

async function api(
  path: string,
  init: { method?: string; cookie?: string; token?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<ApiResult> {
  const headers: Record<string, string> = { ...(init.headers ?? {}) };
  if (init.cookie) headers.Cookie = init.cookie;
  if (init.token) headers.Authorization = `Bearer ${init.token}`;
  let body: string | undefined;
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
  return { status: res.status, body: parsed, headers: res.headers };
}

function setCookieOf(res: Response): string {
  const anyHeaders = res.headers as Headers & { getSetCookie?: () => string[] };
  const list = typeof anyHeaders.getSetCookie === 'function' ? anyHeaders.getSetCookie() : [];
  if (list.length > 0) return list.join(', ');
  return res.headers.get('set-cookie') ?? '';
}

async function sessionCookieFor(userId: number): Promise<{ cookie: string; token: string }> {
  const token = await createSession(testEnv.DB, userId, { userAgent: IPHONE_UA, ip: '10.0.0.9' });
  return { cookie: `session=${token}`, token };
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

let authManager: TestAuthenticator;
let authStaff: TestAuthenticator;
/** ログイン成功時の検証ボディ (チャレンジ再利用テストで使い回す) */
let usedLoginBody: Record<string, unknown> | null = null;

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
    ...statementsOf(commercialSql),
    ...statementsOf(operationsSql),
    ...statementsOf(securitySql),
  ]) {
    await testEnv.DB.prepare(stmt).run();
  }
  const now = Date.now();
  await testEnv.DB.batch([
    testEnv.DB.prepare(
      `INSERT INTO users (id, external_id, email, display_name, status, created_at, updated_at)
       VALUES (2, 'sub-manager', 'manager@example.com', 'Manager', 'active', ?1, ?1),
              (3, 'sub-staff', 'staff@example.com', 'Staff', 'active', ?1, ?1)`,
    ).bind(now),
    testEnv.DB.prepare(
      `INSERT INTO warehouses (id, code, name, store_id, created_at, updated_at)
       VALUES (1, 'WH1', '本社倉庫', 1, ?1, ?1)`,
    ).bind(now),
    testEnv.DB.prepare(
      `INSERT INTO user_roles (user_id, role_code, warehouse_id, store_id)
       VALUES (2, 'SYSTEM_ADMIN', NULL, 1), (3, 'INVENTORY_STAFF', NULL, 1)`,
    ),
  ]);
  managerToken = await mintToken('sub-manager', 'manager@example.com', privateKey);
  authManager = await TestAuthenticator.create();
  authStaff = await TestAuthenticator.create();
});

// ---------------------------------------------------------------- パスキー

describe('パスキー (WebAuthn)', () => {
  it('登録 -> 一覧 -> ログインの一連が通り、ログイン履歴に残る', async () => {
    const { cookie } = await sessionCookieFor(2);

    const options = await api('/api/v1/auth/passkey/register/options', {
      method: 'POST',
      cookie,
      body: {},
    });
    expect(options.status).toBe(200);
    expect(options.body.rp.id).toBe(RP_ID);
    expect(options.body.authenticatorSelection.residentKey).toBe('required');
    expect(options.body.authenticatorSelection.userVerification).toBe('required');

    const attestation = await authManager.attestation(options.body.challenge as string);
    const verify = await api('/api/v1/auth/passkey/register/verify', {
      method: 'POST',
      cookie,
      body: attestation,
    });
    expect(verify.status).toBe(201);
    expect(verify.body.credentialId).toBe(authManager.credentialIdB64);

    const list = await api('/api/v1/auth/passkey/credentials', { cookie });
    expect(list.status).toBe(200);
    expect(Array.isArray(list.body)).toBe(true);
    expect(list.body).toHaveLength(1);
    expect(list.body[0].credentialId).toBe(authManager.credentialIdB64);

    // ログイン (未認証でも options が取れる)
    const loginOptions = await api('/api/v1/auth/passkey/login/options', { method: 'POST', body: {} });
    expect(loginOptions.status).toBe(200);
    usedLoginBody = await authManager.assertion(loginOptions.body.challenge as string);
    const loginRes = await SELF.fetch('https://example.com/api/v1/auth/passkey/login/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': IPHONE_UA },
      body: JSON.stringify(usedLoginBody),
    });
    expect(loginRes.status).toBe(200);
    const setCookie = setCookieOf(loginRes);
    expect(setCookie).toContain('session=');
    const newCookie = `session=${setCookie.match(/session=([^;,]+)/)?.[1] ?? ''}`;

    const me = await api('/api/v1/me', { cookie: newCookie });
    expect(me.status).toBe(200);
    expect(me.body.email).toBe('manager@example.com');

    // ログイン履歴に passkey の記録が残る
    const events = await api('/api/v1/auth/login-events', { cookie: newCookie });
    expect(events.status).toBe(200);
    expect(events.body.some((e: { method: string }) => e.method === 'passkey')).toBe(true);
    const row = await testEnv.DB.prepare(
      "SELECT device_label FROM login_events WHERE user_id = 2 AND method = 'passkey'",
    ).first<{ device_label: string }>();
    expect(row?.device_label).toBe('iPhone Safari');
  });

  it('使用済みチャレンジの再利用は拒否される', async () => {
    expect(usedLoginBody).not.toBeNull();
    const res = await api('/api/v1/auth/passkey/login/verify', { method: 'POST', body: usedLoginBody });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('PASSKEY_VERIFICATION_FAILED');
  });

  it('signCount が後退した assertion は拒否される', async () => {
    const loginOptions = await api('/api/v1/auth/passkey/login/options', { method: 'POST', body: {} });
    const body = await authManager.assertion(loginOptions.body.challenge as string, {
      count: authManager.signCount, // 前回と同じ値 = 後退扱い
    });
    const res = await api('/api/v1/auth/passkey/login/verify', { method: 'POST', body });
    expect(res.status).toBe(400);
  });

  it('他人の鍵で署名した assertion と未知の credential は拒否される', async () => {
    // ユーザー2の credential_id を名乗り、ユーザー3の鍵で署名する
    const loginOptions = await api('/api/v1/auth/passkey/login/options', { method: 'POST', body: {} });
    const forged = await authManager.assertion(loginOptions.body.challenge as string, {
      signWith: authStaff.keyPair,
    });
    const res = await api('/api/v1/auth/passkey/login/verify', { method: 'POST', body: forged });
    expect(res.status).toBe(400);

    const loginOptions2 = await api('/api/v1/auth/passkey/login/options', { method: 'POST', body: {} });
    const unknown = await authStaff.assertion(loginOptions2.body.challenge as string);
    const res2 = await api('/api/v1/auth/passkey/login/verify', { method: 'POST', body: unknown });
    expect(res2.status).toBe(400);
  });

  it('自分のパスキーだけを削除できる', async () => {
    const { cookie } = await sessionCookieFor(3);
    const options = await api('/api/v1/auth/passkey/register/options', {
      method: 'POST',
      cookie,
      body: {},
    });
    const attestation = await authStaff.attestation(options.body.challenge as string);
    const verify = await api('/api/v1/auth/passkey/register/verify', {
      method: 'POST',
      cookie,
      body: attestation,
    });
    expect(verify.status).toBe(201);
    const staffCredId = verify.body.id as number;

    // ユーザー2のセッションではユーザー3の credential を消せない
    const { cookie: managerCookie } = await sessionCookieFor(2);
    const other = await api(`/api/v1/auth/passkey/credentials/${staffCredId}`, {
      method: 'DELETE',
      cookie: managerCookie,
    });
    expect(other.status).toBe(404);

    const own = await api(`/api/v1/auth/passkey/credentials/${staffCredId}`, {
      method: 'DELETE',
      cookie,
    });
    expect(own.status).toBe(200);
    const list = await api('/api/v1/auth/passkey/credentials', { cookie });
    expect(list.body).toHaveLength(0);
  });
});

// ------------------------------------------------------- ヘッダ / Origin

describe('セキュリティヘッダと Origin チェック', () => {
  it('/app と API レスポンスにセキュリティヘッダが付く', async () => {
    const app = await SELF.fetch('https://example.com/app');
    expect(app.status).toBe(200);
    const csp = app.headers.get('content-security-policy') ?? '';
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("'wasm-unsafe-eval'");
    expect(csp).toContain("worker-src 'self' blob:");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(app.headers.get('x-content-type-options')).toBe('nosniff');
    expect(app.headers.get('referrer-policy')).toBe('no-referrer');
    expect(app.headers.get('referer-policy')).toBeNull();
    expect(app.headers.get('permissions-policy')).toContain('camera=(self)');

    const apiRes = await SELF.fetch('https://example.com/api/v1/me');
    expect(apiRes.status).toBe(401);
    expect(apiRes.headers.get('content-security-policy')).toContain("default-src 'self'");
    expect(apiRes.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('他オリジンからの状態変更は 403、自オリジンと Origin なしは通る', async () => {
    const evil = await sessionCookieFor(2);
    const evilRes = await SELF.fetch('https://example.com/api/v1/auth/logout', {
      method: 'POST',
      headers: { Cookie: evil.cookie, Origin: 'https://evil.example.com' },
    });
    expect(evilRes.status).toBe(403);
    expect(((await evilRes.json()) as { error: string }).error).toBe('ORIGIN_MISMATCH');

    const same = await sessionCookieFor(2);
    const sameRes = await SELF.fetch('https://example.com/api/v1/auth/logout', {
      method: 'POST',
      headers: { Cookie: same.cookie, Origin: ORIGIN },
    });
    expect(sameRes.status).toBe(200);

    const none = await sessionCookieFor(2);
    const noneRes = await SELF.fetch('https://example.com/api/v1/auth/logout', {
      method: 'POST',
      headers: { Cookie: none.cookie },
    });
    expect(noneRes.status).toBe(200);
  });
});

// ------------------------------------------------------- セッション管理

describe('自分のセッション管理', () => {
  it('一覧で現在のセッションが分かり、他のセッションを失効できる', async () => {
    const a = await sessionCookieFor(2);
    const b = await sessionCookieFor(2);

    const list = await api('/api/v1/auth/sessions', { cookie: a.cookie });
    expect(list.status).toBe(200);
    expect(Array.isArray(list.body)).toBe(true);
    expect(list.body.length).toBeGreaterThanOrEqual(2);
    const current = (list.body as { id: number; current: boolean }[]).find((s) => s.current);
    expect(current).toBeDefined();

    // 現在のセッション自身はこの API では消せない
    const delCurrent = await api(`/api/v1/auth/sessions/${current?.id}`, {
      method: 'DELETE',
      cookie: a.cookie,
    });
    expect(delCurrent.status).toBe(400);
    expect(delCurrent.body.error).toBe('CURRENT_SESSION');

    // 他のセッション (b) を失効させると、その Cookie は使えなくなる。
    // 一覧の最新行が b とは限らないため、b の行 ID は token ハッシュから引く
    const bHash = await hashSessionToken(b.token);
    const bRow = await testEnv.DB.prepare('SELECT id FROM sessions WHERE token_hash = ?1')
      .bind(bHash)
      .first<{ id: number }>();
    const del = await api(`/api/v1/auth/sessions/${bRow?.id}`, {
      method: 'DELETE',
      cookie: a.cookie,
    });
    expect(del.status).toBe(200);
    const meB = await api('/api/v1/me', { cookie: b.cookie });
    expect(meB.status).toBe(401);
    const meA = await api('/api/v1/me', { cookie: a.cookie });
    expect(meA.status).toBe(200);
  });
});

// ------------------------------------------------------- ログイン履歴

describe('ログイン履歴と新しい端末の判定', () => {
  it('初めての device ラベル + IP のときだけ通知し、履歴に記録する', async () => {
    const calls: { userIds: number[]; title: string }[] = [];
    const notify = (async (
      _db: unknown,
      _env: unknown,
      userIds: number[],
      payload: { title: string },
    ) => {
      calls.push({ userIds, title: payload.title });
    }) as unknown as Parameters<typeof recordLoginEvent>[3];
    const pushEnv = testEnv as unknown as Parameters<typeof recordLoginEvent>[1];

    const first = await recordLoginEvent(
      testEnv.DB,
      pushEnv,
      { userId: 3, method: 'google', ip: '10.1.1.1', userAgent: IPHONE_UA },
      notify,
    );
    expect(first.recorded).toBe(true);
    expect(first.isNewDevice).toBe(true);
    expect(first.deviceLabel).toBe('iPhone Safari');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.userIds).toEqual([3]);

    const second = await recordLoginEvent(
      testEnv.DB,
      pushEnv,
      { userId: 3, method: 'passkey', ip: '10.1.1.1', userAgent: IPHONE_UA },
      notify,
    );
    expect(second.isNewDevice).toBe(false);
    expect(calls).toHaveLength(1);

    const otherIp = await recordLoginEvent(
      testEnv.DB,
      pushEnv,
      { userId: 3, method: 'google', ip: '10.2.2.2', userAgent: IPHONE_UA },
      notify,
    );
    expect(otherIp.isNewDevice).toBe(true);
    expect(calls).toHaveLength(2);

    const { cookie } = await sessionCookieFor(3);
    const events = await api('/api/v1/auth/login-events', { cookie });
    expect(events.status).toBe(200);
    expect(events.body.length).toBeGreaterThanOrEqual(3);
    expect(events.body[0].deviceLabel).toBe('iPhone Safari');
  });
});

// ------------------------------------------------------- ステップアップ

describe('重要操作のステップアップ', () => {
  it('未実施で 403、パスキー再認証で通り、期限切れで再び 403 になる', async () => {
    const s = await sessionCookieFor(2);
    const putBody = { permissions: ['stocks.read'] };

    // ログイン直後 (step_up_at = 発行時刻) は通る
    const fresh = await api('/api/v1/admin/role-permissions/INVENTORY_STAFF', {
      method: 'PUT',
      cookie: s.cookie,
      body: putBody,
    });
    expect(fresh.status).toBe(200);

    // step_up_at を 11 分前に巻き戻すと、対象操作はどちらも 403 になる
    const hash = await hashSessionToken(s.token);
    await testEnv.DB.prepare('UPDATE sessions SET step_up_at = ?1 WHERE token_hash = ?2')
      .bind(Date.now() - 11 * 60 * 1000, hash)
      .run();
    const stalePut = await api('/api/v1/admin/role-permissions/INVENTORY_STAFF', {
      method: 'PUT',
      cookie: s.cookie,
      body: putBody,
    });
    expect(stalePut.status).toBe(403);
    expect(stalePut.body.error).toBe('STEP_UP_REQUIRED');
    const staleExport = await api('/api/v1/admin/export.json', { cookie: s.cookie });
    expect(staleExport.status).toBe(403);
    expect(staleExport.body.error).toBe('STEP_UP_REQUIRED');

    // パスキーでステップアップすると再び通る
    const options = await api('/api/v1/auth/passkey/step-up/options', {
      method: 'POST',
      cookie: s.cookie,
      body: {},
    });
    expect(options.status).toBe(200);
    const assertion = await authManager.assertion(options.body.challenge as string);
    const stepUp = await api('/api/v1/auth/step-up/passkey', {
      method: 'POST',
      cookie: s.cookie,
      body: assertion,
    });
    expect(stepUp.status).toBe(200);

    const afterPut = await api('/api/v1/admin/role-permissions/INVENTORY_STAFF', {
      method: 'PUT',
      cookie: s.cookie,
      body: putBody,
    });
    expect(afterPut.status).toBe(200);
    const afterExport = await api('/api/v1/admin/export.json', { cookie: s.cookie });
    expect(afterExport.status).toBe(200);

    // 期限切れに戻すと再び 403
    await testEnv.DB.prepare('UPDATE sessions SET step_up_at = ?1 WHERE token_hash = ?2')
      .bind(Date.now() - 11 * 60 * 1000, hash)
      .run();
    const staleAgain = await api('/api/v1/admin/export.json', { cookie: s.cookie });
    expect(staleAgain.status).toBe(403);
    expect(staleAgain.body.error).toBe('STEP_UP_REQUIRED');

    // Bearer (IdP トークン) はステップアップ対象外
    const bearerExport = await api('/api/v1/admin/export.json', { token: managerToken });
    expect(bearerExport.status).toBe(200);
  });
});

// ------------------------------------------------------- ハッシュチェーン

describe('監査ログのハッシュチェーン', () => {
  it('通常は ok で、行を書き換えると brokenAtId で検出する', async () => {
    const { cookie } = await sessionCookieFor(2);
    const put = await api('/api/v1/admin/role-permissions/INVENTORY_STAFF', {
      method: 'PUT',
      cookie,
      body: { permissions: ['stocks.read'] },
    });
    expect(put.status).toBe(200);

    const okRes = await api('/api/v1/admin/audit-integrity', { cookie });
    expect(okRes.status).toBe(200);
    expect(okRes.body.ok).toBe(true);
    expect(okRes.body.checked).toBeGreaterThanOrEqual(1);
    expect(okRes.body.brokenAtId).toBeNull();

    const target = await testEnv.DB.prepare(
      'SELECT id FROM audit_logs WHERE row_hash IS NOT NULL ORDER BY id DESC LIMIT 1',
    ).first<{ id: number }>();
    expect(target?.id).toBeGreaterThan(0);
    await testEnv.DB.prepare("UPDATE audit_logs SET payload = '{\"tampered\":true}' WHERE id = ?1")
      .bind(target?.id)
      .run();

    const broken = await api('/api/v1/admin/audit-integrity', { cookie });
    expect(broken.status).toBe(200);
    expect(broken.body.ok).toBe(false);
    expect(broken.body.brokenAtId).toBe(target?.id);
  });
});
