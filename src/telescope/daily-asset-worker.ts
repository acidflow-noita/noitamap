import { prepareDataArchive } from '../data-archive';
import { biomeBackgroundRevisions } from 'virtual:noitamap-data-archives';
import { packs, provenance as sceneRevision } from 'virtual:noitamap-scene-assets';
import { provenance as terrainRevision } from 'virtual:noitamap-telescope-asset-identity';
import spritesheetRevision from '../data/spritesheet-revision.json';
import { fullPixelDataAssets } from './full-pixel-data';
import { immutableTelescopeAssets, revisionedAssetUrl } from './immutable-assets';
import { prepareSceneAtlas } from './scene-source-atlas';
import type { DailyAssetReply, DailyAssetRequest } from './daily-asset-worker-protocol';

/** Deliberately no Telescope/DOM/OSD/GPU imports. Optional daily preparation
 * must never evaluate the generator, compose scenes, or compile a shader on
 * the UI thread. These exact keys/revisions are reused by live generation. */
export async function prepareDailyAssets(
  request: DailyAssetRequest,
  report: (reply: DailyAssetReply) => void,
): Promise<void> {
  const started = performance.now();
  let prepared = 0, failures = 0;
  const prepare = async (asset: string, run: () => Promise<unknown>) => {
    try { await run(); prepared++; }
    catch (error) {
      failures++;
      report({ type: 'failure', asset, error: String(error) });
    }
  };
  const cache = async (key: string, revision: string, source: string) => {
    const url = new URL(source, request.baseUrl).href;
    const response = await immutableTelescopeAssets.fetch(key, revision,
      () => fetch(revisionedAssetUrl(url, revision), {
        cache: 'force-cache', signal: AbortSignal.timeout(30_000),
      }));
    if (!response.ok) throw new Error(`Asset download failed (HTTP ${response.status})`);
  };
  const stage = async (name: string, run: () => Promise<unknown>) => {
    const from = performance.now(), initialFailures = failures;
    report({ type: 'stage', stage: name, state: 'started', elapsedMs: 0, failures: 0 });
    await run();
    report({ type: 'stage', stage: name, state: 'finished', elapsedMs: performance.now() - from, failures: failures - initialFailures });
  };

  // Page downloads are bounded and shared with generation workers. Static
  // files retain the same content URLs across seeds and unchanged builds.
  for (const key of ['main', 'wang_tiles', 'pixel_scenes'])
    await stage(`${key} asset pages`, () => prepare(key, () => prepareDataArchive(key, request.baseUrl)));
  await stage('scene source atlas', () => prepare('scene source atlas', prepareSceneAtlas));

  const fork = request.fullPixels ? 'full' : 'approx';
  await stage('compressed scene inputs', () => prepare(`prepared-scenes/${fork}`, () =>
    cache(`prepared-scenes/${fork}`, sceneRevision, packs[fork].url)));
  if (request.fullPixels)
    await stage('material and edge atlas inputs', async () => {
      for (const [filename, url] of Object.entries(fullPixelDataAssets))
        await prepare(`full-pixel/${filename}`, () => cache(`full-pixel/${filename}`, terrainRevision, url));
    });

  await stage('native biome background inputs', async () => {
    for (const [filename, revision] of Object.entries(biomeBackgroundRevisions))
      await prepare(`biome-background/${filename}`, () =>
        cache(`biome-background/${filename}`, revision, `./biome_bg/${filename}`));
  });
  await stage('marker spritesheet', () => prepare('marker-spritesheet', () =>
    cache('marker-spritesheet', spritesheetRevision, `./assets/spritesheet.png?v=${spritesheetRevision}`)));

  await stage('optional persistent writes', () => immutableTelescopeAssets.flushWrites());
  report({ type: 'done', prepared, failures, elapsedMs: performance.now() - started });
}

self.onmessage = (event: MessageEvent<DailyAssetRequest>) => {
  void prepareDailyAssets(event.data, reply => self.postMessage(reply));
};
