import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

it('ships the pinned OpenSeadragon dependency without a second CDN copy', () => {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const lock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'));
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const version = manifest.devDependencies.openseadragon;

  expect(version).toMatch(/^\d+\.\d+\.\d+$/);
  expect(html).not.toContain('cdn.jsdelivr.net/npm/openseadragon');
  expect(lock.packages[''].devDependencies.openseadragon).toBe(version);
  expect(lock.packages['node_modules/openseadragon'].version).toBe(version);
});
