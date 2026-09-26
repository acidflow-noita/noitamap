import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { build, createServer } from 'vite';

const root = resolve(import.meta.dirname, '..');
const expected = [
  '/assets/runfast-logo.svg',
  '/assets/icons/overlay-toggles/icon-structures.svg',
  '/assets/icons/overlay-toggles/icon-orbs.webp',
  '/assets/icons/overlay-toggles/icon-items.webp',
  '/assets/icons/overlay-toggles/icon-bosses.webp',
  '/assets/icons/overlay-toggles/icon-spatial-awareness.webp',
  '/assets/icons/overlay-toggles/icon-hidden-messages.webp',
].sort();

async function assertPublicImages(css: string): Promise<void> {
  // CSS now enters through src/styles/map.css; rebasing relative URLs in its
  // public/ imports must not leak filesystem paths into browser requests.
  const urls = [...css.matchAll(/url\(["']?(\/[^"')\s]+)["']?\)/g)]
    .map(match => match[1]).sort();
  expect(urls).toEqual(expected);
  for (const url of urls) {
    expect((await readFile(resolve(root, 'public', url.slice(1)))).byteLength, url)
      .toBeGreaterThan(0);
  }
}

describe('shared stylesheet public images', () => {
  it('requests the served public paths after development import rebasing', async () => {
    const server = await createServer({
      configFile: false, root, logLevel: 'silent',
      server: { middlewareMode: true, hmr: false, watch: null, preTransformRequests: false },
      optimizeDeps: { noDiscovery: true, include: [] },
    });
    try {
      const result = await server.transformRequest('/src/styles/map.css?direct');
      expect(result).not.toBeNull();
      await assertPublicImages(result!.code);
    } finally {
      await server.close();
    }
  });

  it('keeps the same working public image URLs in the production CSS bundle', async () => {
    const result: any = await build({
      configFile: false, root, logLevel: 'silent',
      build: {
        write: false, assetsDir: 'build',
        rollupOptions: { input: resolve(root, 'src/styles/map.css') },
      },
    });
    const styles = result.output.filter((file: { fileName: string }) => file.fileName.endsWith('.css'));
    expect(styles).toHaveLength(1);
    await assertPublicImages(String(styles[0].source));
  });
});
