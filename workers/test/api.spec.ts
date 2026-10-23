import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

/**
 * Workers ランタイム上での疎通確認 (D1 / Durable Objects のバインディング前提)。
 * 業務 API は OIDC 未設定のため 401 になることが期待値。
 */
describe('worker endpoints', () => {
  it('GET /api/v1/health は認証不要で 200', async () => {
    const res = await SELF.fetch('https://example.com/api/v1/health');
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ status: 'ok' });
  });

  it('業務 API はトークン無しで 401', async () => {
    const res = await SELF.fetch('https://example.com/api/v1/stocks');
    expect(res.status).toBe(401);
  });

  it('未知のルートも認証が先に効いて 401 (認証 -> ルーティングの順)', async () => {
    const res = await SELF.fetch('https://example.com/api/v1/unknown');
    expect(res.status).toBe(401);
  });

  it('API 配下でないルートは 404', async () => {
    const res = await SELF.fetch('https://example.com/nope');
    expect(res.status).toBe(404);
  });
});
