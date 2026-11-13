import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [cloudflareTest({
    wrangler: { configPath: './wrangler.jsonc' },
    remoteBindings: false,
    miniflare: { bindings: { STREAM_IMAGE_ROOT: '/images', STREAM_SIGNING_SECRET: 'runtime-test-socket-key-never-used-in-production' } },
  })],
  test: {
    // Keep runtime tests out of the repository's Node-only Vitest 3 suite.
    include: ['test/**/*.runtime.ts'],
    fileParallelism: false,
  },
});
