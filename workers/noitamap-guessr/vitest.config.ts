import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [cloudflareTest({
    wrangler: { configPath: './wrangler.jsonc' },
    remoteBindings: false,
  })],
  test: {
    // Keep runtime tests out of the repository's Node-only Vitest 3 suite.
    include: ['test/**/*.runtime.ts'],
    fileParallelism: false,
  },
});
