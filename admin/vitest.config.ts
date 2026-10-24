import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      // /auth/callback のコード交換をテストするためのダミー Secret (値は使われない)
      miniflare: { bindings: { GOOGLE_CLIENT_SECRET: 'test-only-secret' } },
    }),
  ],
});
