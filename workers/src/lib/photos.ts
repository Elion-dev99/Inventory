import type { Env } from '../env';
import { ApiError } from './errors';

/**
 * 商品画像・検品写真の保存 (R2 バインディング IMAGES)。
 *
 * バインディングが無い環境では写真系 API が 503 PHOTOS_NOT_CONFIGURED を
 * 返して劣化する (画像以外の機能には影響しない)。実体は R2 に置き、
 * DB にはキーだけを保持する:
 * - 商品画像: products/{storeId}/{productId}.jpg (商品ごとに 1 枚、上書き)
 * - 検品写真: movements/{storeId}/{photoId}.jpg (movement_photos の id)
 */

export const IMAGE_CONTENT_TYPES: ReadonlySet<string> = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
]);

/** アップロード上限 (2MB)。クライアント側で圧縮してから送る前提 */
export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

/** R2 バケットを返す。未設定なら null (呼び出し側で 503 に劣化させる) */
export function imagesBucket(env: Env): R2Bucket | null {
  return env.IMAGES ?? null;
}

/** R2 バケットを必須として返す。未設定なら 503 PHOTOS_NOT_CONFIGURED */
export function requireImagesBucket(env: Env): R2Bucket {
  const bucket = imagesBucket(env);
  if (!bucket) {
    throw new ApiError(
      503,
      'PHOTOS_NOT_CONFIGURED',
      'Image storage (R2 binding IMAGES) is not configured',
    );
  }
  return bucket;
}

/**
 * アップロードされた画像ボディを検証する。
 * Content-Type が jpeg/png/webp 以外なら 400、2MB 超なら 413。
 * 検証済みの ArrayBuffer と正規化した Content-Type を返す。
 */
export async function readImageBody(
  req: Request,
): Promise<{ bytes: ArrayBuffer; contentType: string }> {
  const contentType = (req.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  if (!IMAGE_CONTENT_TYPES.has(contentType)) {
    throw new ApiError(
      400,
      'INVALID_IMAGE_TYPE',
      'Image must be JPEG, PNG or WebP (Content-Type: image/jpeg, image/png or image/webp)',
    );
  }
  const bytes = await req.arrayBuffer();
  if (bytes.byteLength === 0) {
    throw new ApiError(400, 'INVALID_IMAGE', 'Image body is empty');
  }
  if (bytes.byteLength > MAX_IMAGE_BYTES) {
    throw new ApiError(413, 'IMAGE_TOO_LARGE', 'Image exceeds the 2MB limit');
  }
  return { bytes, contentType };
}

export function productImageKey(storeId: number, productId: number): string {
  return `products/${storeId}/${productId}.jpg`;
}

export function movementPhotoKey(storeId: number, photoId: number): string {
  return `movements/${storeId}/${photoId}.jpg`;
}

/** R2 オブジェクトを HTTP レスポンスに変換する (取得できなければ null) */
export function imageResponse(object: R2ObjectBody | null): Response | null {
  if (!object) return null;
  const headers = new Headers();
  headers.set('Content-Type', object.httpMetadata?.contentType ?? 'image/jpeg');
  headers.set('Cache-Control', 'private, max-age=300');
  if (object.httpEtag) headers.set('ETag', object.httpEtag);
  return new Response(object.body, { headers });
}
