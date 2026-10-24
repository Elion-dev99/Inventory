import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        plugins: [
          cloudflareTest({
            wrangler: { configPath: './wrangler.jsonc' },
            // /auth/callback のコード交換をテストするためのダミー Secret (値は使われない)
            miniflare: { bindings: { GOOGLE_CLIENT_SECRET: 'test-only-secret' } },
          }),
        ],
        test: {
          name: 'workers',
          include: ['test/**/*.spec.ts'],
          exclude: ['test/**/*.node.spec.ts'],
        },
      },
      {
        // バーコードスキャンエンジン (zxing-wasm) の実デコード検証と
        // 純粋ロジックの検証は、DOM / workerd の無い Node 環境で回す
        test: {
          name: 'node',
          environment: 'node',
          include: ['test/**/*.node.spec.ts'],
        },
      },
    ],
  },
});
