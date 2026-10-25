/**
 * WebAuthn (パスキー) のサーバー側検証 — 外部ライブラリなし。
 *
 * 実装範囲はこのアプリに必要な最小限に絞る:
 * - 登録: attestation 形式 'none' 前提。'packed' の自己署名 (x5c なし)
 *   は署名も検証する。それ以外の形式は受け付けない。
 * - 認証: ECDSA P-256 (ES256) の assertion 署名を、保存済み JWK で
 *   WebCrypto 検証する。WebAuthn の署名は DER 形式のため、
 *   WebCrypto が要求する raw (r||s) へ変換してから検証する。
 * - CBOR は attestationObject と COSE 公開鍵を読むための最小デコーダ。
 * - チャレンジは DB (webauthn_challenges) に保存し、検証時に削除する
 *   使い捨て (5 分)。失敗時は汎用エラーに倒し、詳細は返さない。
 */

import { base64UrlDecode, base64UrlEncode } from './push';

export { base64UrlDecode, base64UrlEncode };

// ------------------------------------------------------------------ CBOR

type CborValue = number | string | boolean | null | Uint8Array | CborValue[] | Map<unknown, CborValue>;

function cborReadLength(bytes: Uint8Array, offset: number, ai: number): { value: number; next: number } {
  if (ai < 24) return { value: ai, next: offset };
  if (ai === 24) return { value: bytes[offset]!, next: offset + 1 };
  if (ai === 25) return { value: (bytes[offset]! << 8) | bytes[offset + 1]!, next: offset + 2 };
  if (ai === 26) {
    const v =
      bytes[offset]! * 2 ** 24 + bytes[offset + 1]! * 2 ** 16 + bytes[offset + 2]! * 2 ** 8 + bytes[offset + 3]!;
    return { value: v, next: offset + 4 };
  }
  if (ai === 27) {
    // 64bit は Number の安全範囲で読む (この用途では長さ・整数の実値で十分)
    let v = 0;
    for (let i = 0; i < 8; i++) v = v * 256 + bytes[offset + i]!;
    return { value: v, next: offset + 8 };
  }
  throw new Error('unsupported cbor additional info');
}

function cborDecodeItem(bytes: Uint8Array, offset: number): { value: CborValue; next: number } {
  const first = bytes[offset]!;
  const major = first >> 5;
  const ai = first & 0x1f;
  const body = offset + 1;
  switch (major) {
    case 0: {
      const r = cborReadLength(bytes, body, ai);
      return { value: r.value, next: r.next };
    }
    case 1: {
      const r = cborReadLength(bytes, body, ai);
      return { value: -1 - r.value, next: r.next };
    }
    case 2: {
      const r = cborReadLength(bytes, body, ai);
      return { value: bytes.slice(r.next, r.next + r.value), next: r.next + r.value };
    }
    case 3: {
      const r = cborReadLength(bytes, body, ai);
      const text = new TextDecoder().decode(bytes.slice(r.next, r.next + r.value));
      return { value: text, next: r.next + r.value };
    }
    case 4: {
      const r = cborReadLength(bytes, body, ai);
      const arr: CborValue[] = [];
      let pos = r.next;
      for (let i = 0; i < r.value; i++) {
        const item = cborDecodeItem(bytes, pos);
        arr.push(item.value);
        pos = item.next;
      }
      return { value: arr, next: pos };
    }
    case 5: {
      const r = cborReadLength(bytes, body, ai);
      const map = new Map<unknown, CborValue>();
      let pos = r.next;
      for (let i = 0; i < r.value; i++) {
        const k = cborDecodeItem(bytes, pos);
        pos = k.next;
        const v = cborDecodeItem(bytes, pos);
        pos = v.next;
        map.set(k.value, v.value);
      }
      return { value: map, next: pos };
    }
    case 7: {
      if (ai === 20) return { value: false, next: body };
      if (ai === 21) return { value: true, next: body };
      if (ai === 22) return { value: null, next: body };
      throw new Error('unsupported cbor simple value');
    }
    default:
      throw new Error('unsupported cbor major type');
  }
}

/** 先頭の 1 項目だけをデコードする (COSE 公開鍵など後続を切り離す用途) */
export function cborDecodeFirst(bytes: Uint8Array): CborValue {
  return cborDecodeItem(bytes, 0).value;
}

function cborDecodeFirstWithRest(bytes: Uint8Array): { value: CborValue; rest: Uint8Array } {
  const r = cborDecodeItem(bytes, 0);
  return { value: r.value, rest: bytes.slice(r.next) };
}

// ------------------------------------------------------------ authData

export interface AuthenticatorData {
  rpIdHash: Uint8Array;
  flags: number;
  signCount: number;
  userPresent: boolean;
  userVerified: boolean;
  attestedCredentialData: {
    credentialId: Uint8Array;
    cosePublicKey: Map<unknown, CborValue>;
  } | null;
}

export function parseAuthenticatorData(bytes: Uint8Array): AuthenticatorData {
  if (bytes.length < 37) throw new Error('authenticator data too short');
  const rpIdHash = bytes.slice(0, 32);
  const flags = bytes[32]!;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const signCount = view.getUint32(33, false);
  let attested: AuthenticatorData['attestedCredentialData'] = null;
  if (flags & 0x40) {
    // AT: aaguid(16) + credentialIdLength(2) + credentialId + COSE 公開鍵
    const credIdLen = view.getUint16(53, false);
    const credIdStart = 55;
    const credentialId = bytes.slice(credIdStart, credIdStart + credIdLen);
    const coseBytes = bytes.slice(credIdStart + credIdLen);
    const cose = cborDecodeFirst(coseBytes);
    if (!(cose instanceof Map)) throw new Error('invalid COSE public key');
    attested = { credentialId, cosePublicKey: cose as Map<unknown, CborValue> };
  }
  return {
    rpIdHash,
    flags,
    signCount,
    userPresent: (flags & 0x01) !== 0,
    userVerified: (flags & 0x04) !== 0,
    attestedCredentialData: attested,
  };
}

/** COSE EC2 公開鍵を JWK (P-256) へ変換する。P-256 以外は受け付けない */
export function coseEc2ToJwk(cose: Map<unknown, CborValue>): JsonWebKey {
  const kty = cose.get(1);
  const alg = cose.get(3);
  const crv = cose.get(-1);
  const x = cose.get(-2);
  const y = cose.get(-3);
  if (kty !== 2 || (alg !== undefined && alg !== -7) || crv !== 1) {
    throw new Error('unsupported COSE key');
  }
  if (!(x instanceof Uint8Array) || !(y instanceof Uint8Array) || x.length !== 32 || y.length !== 32) {
    throw new Error('invalid COSE coordinates');
  }
  return { kty: 'EC', crv: 'P-256', x: base64UrlEncode(x), y: base64UrlEncode(y) };
}

// ------------------------------------------------------------- 署名検証

/** DER 形式の ECDSA 署名を WebCrypto 用の raw (r||s) へ変換する */
export function derEcdsaToRaw(der: Uint8Array, partLength = 32): Uint8Array {
  let offset = 0;
  if (der[offset++] !== 0x30) throw new Error('invalid DER signature');
  let seqLen = der[offset++]!;
  if (seqLen & 0x80) {
    const n = seqLen & 0x7f;
    seqLen = 0;
    for (let i = 0; i < n; i++) seqLen = seqLen * 256 + der[offset++]!;
  }
  const readPart = (): Uint8Array => {
    if (der[offset++] !== 0x02) throw new Error('invalid DER integer');
    const len = der[offset++]!;
    const raw = der.slice(offset, offset + len);
    offset += len;
    const out = new Uint8Array(partLength);
    if (raw.length >= partLength) {
      out.set(raw.slice(raw.length - partLength));
    } else {
      out.set(raw, partLength - raw.length);
    }
    return out;
  };
  const r = readPart();
  const s = readPart();
  const out = new Uint8Array(partLength * 2);
  out.set(r, 0);
  out.set(s, partLength);
  return out;
}

export async function sha256Bytes(data: Uint8Array | string): Promise<Uint8Array> {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
  return new Uint8Array(digest);
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

export async function importEcdsaPublicKey(jwk: JsonWebKey): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'jwk',
    { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y },
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['verify'],
  );
}

/** WebAuthn の assertion 署名 (DER) を公開鍵 JWK で検証する */
export async function verifyAssertionSignature(
  jwk: JsonWebKey,
  signatureDer: Uint8Array,
  signedData: Uint8Array,
): Promise<boolean> {
  try {
    const key = await importEcdsaPublicKey(jwk);
    const raw = derEcdsaToRaw(signatureDer);
    return await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      key,
      raw as BufferSource,
      signedData as BufferSource,
    );
  } catch {
    return false;
  }
}

// ---------------------------------------------------------- clientData

export interface ClientData {
  type: string;
  challenge: string;
  origin: string;
  crossOrigin?: boolean;
}

export function parseClientData(clientDataJSON: Uint8Array): ClientData {
  const parsed = JSON.parse(new TextDecoder().decode(clientDataJSON)) as ClientData;
  if (typeof parsed.type !== 'string' || typeof parsed.challenge !== 'string' || typeof parsed.origin !== 'string') {
    throw new Error('invalid clientDataJSON');
  }
  return parsed;
}

export function checkClientData(
  clientData: ClientData,
  expected: { type: string; challenge: string; origin: string },
): void {
  if (clientData.type !== expected.type) throw new Error('clientData type mismatch');
  if (clientData.challenge !== expected.challenge) throw new Error('challenge mismatch');
  if (clientData.origin !== expected.origin) throw new Error('origin mismatch');
}

// ---------------------------------------------------------- attestation

export interface ParsedAttestation {
  authData: AuthenticatorData;
  format: string;
}

export function parseAttestationObject(attestationObject: Uint8Array): ParsedAttestation {
  const decoded = cborDecodeFirst(attestationObject);
  if (!(decoded instanceof Map)) throw new Error('invalid attestationObject');
  const fmt = decoded.get('fmt');
  const authData = decoded.get('authData');
  if (typeof fmt !== 'string' || !(authData instanceof Uint8Array)) {
    throw new Error('invalid attestationObject fields');
  }
  return { authData: parseAuthenticatorData(authData), format: fmt };
}

/**
 * attestation の署名検証。'none' は検証不要。'packed' の自己署名
 * (attStmt.sig、x5c なし) はクレデンシャル公開鍵で検証する。
 * それ以外の形式は false (受け付けない)。
 */
export async function verifyAttestationSignature(
  attestationObject: Uint8Array,
  clientDataJSON: Uint8Array,
  jwk: JsonWebKey,
): Promise<boolean> {
  const decoded = cborDecodeFirst(attestationObject);
  if (!(decoded instanceof Map)) return false;
  const fmt = decoded.get('fmt');
  if (fmt === 'none') return true;
  if (fmt !== 'packed') return false;
  const attStmt = decoded.get('attStmt');
  const authData = decoded.get('authData');
  if (!(attStmt instanceof Map) || !(authData instanceof Uint8Array)) return false;
  if (attStmt.get('x5c') !== undefined) return false; // 証明書チェーンの検証は行わない
  const sig = attStmt.get('sig');
  if (!(sig instanceof Uint8Array)) return false;
  const clientHash = await sha256Bytes(clientDataJSON);
  const signed = new Uint8Array(authData.length + clientHash.length);
  signed.set(authData, 0);
  signed.set(clientHash, authData.length);
  return verifyAssertionSignature(jwk, sig, signed);
}

// ------------------------------------------------------------ チャレンジ

export type WebAuthnPurpose = 'register' | 'login' | 'step_up';

export const WEBAUTHN_CHALLENGE_TTL_MS = 5 * 60 * 1000;

export interface ChallengeRow {
  id: number;
  user_id: number | null;
  challenge: string;
  purpose: string;
  session_id: number | null;
  expires_at: number;
}

/** チャレンジを発行する (32 バイト乱数の base64url) */
export async function issueChallenge(
  db: D1Database,
  input: { userId: number | null; purpose: WebAuthnPurpose; sessionId?: number | null },
): Promise<string> {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const challenge = base64UrlEncode(bytes);
  const now = Date.now();
  await db
    .prepare(
      `INSERT INTO webauthn_challenges (user_id, challenge, purpose, session_id, expires_at, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
    )
    .bind(input.userId, challenge, input.purpose, input.sessionId ?? null, now + WEBAUTHN_CHALLENGE_TTL_MS, now)
    .run();
  return challenge;
}

/**
 * チャレンジを取り出して削除する (1 回限り)。purpose が違う・期限切れ・
 * 存在しない場合は null。検証の成否にかかわらず再利用はできない。
 */
export async function consumeChallenge(
  db: D1Database,
  challenge: string,
  purpose: WebAuthnPurpose,
): Promise<ChallengeRow | null> {
  const row = await db
    .prepare('SELECT * FROM webauthn_challenges WHERE challenge = ?1 AND purpose = ?2')
    .bind(challenge, purpose)
    .first<ChallengeRow>();
  if (!row) return null;
  await db.prepare('DELETE FROM webauthn_challenges WHERE id = ?1').bind(row.id).run();
  if (row.expires_at <= Date.now()) return null;
  return row;
}

// ------------------------------------------------------------- 端末ラベル

/** UA から「iPhone Safari」程度の正規化ラベルを作る (ログイン履歴・新端末判定用) */
export function deviceLabelFromUserAgent(userAgent: string | null | undefined): string {
  const ua = userAgent ?? '';
  if (!ua) return '不明な端末';
  const os = /iPhone/.test(ua)
    ? 'iPhone'
    : /iPad/.test(ua)
      ? 'iPad'
      : /Android/.test(ua)
        ? 'Android'
        : /Macintosh|Mac OS X/.test(ua)
          ? 'Mac'
          : /Windows/.test(ua)
            ? 'Windows'
            : /Linux/.test(ua)
              ? 'Linux'
              : '端末';
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /CriOS|Chrome\//.test(ua)
      ? 'Chrome'
      : /FxiOS|Firefox\//.test(ua)
        ? 'Firefox'
        : /Safari\//.test(ua)
          ? 'Safari'
          : 'ブラウザ';
  return `${os} ${browser}`;
}
