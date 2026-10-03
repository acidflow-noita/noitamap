import { readFileSync } from 'node:fs';
import { createSourceFile, isFunctionDeclaration, ScriptTarget, transpileModule } from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { isRepeatedTempleTemplate } from '../src/telescope/terrain-policy';

function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

/** Run the bridge's actual orchestration without booting its browser UI imports. */
function bridgeLifecycle(dependencies: Record<string, unknown>) {
  const source = createSourceFile('bridge.ts', readFileSync('src/telescope/telescope-osd-bridge.ts', 'utf8'), ScriptTarget.Latest);
  const names = ['clearInstantTerrain', 'cancelPendingDynamicTerrain', 'renderGenerationResult'];
  const functions = source.statements.filter(statement =>
    isFunctionDeclaration(statement) && names.includes(statement.name?.text ?? ''));
  expect(functions).toHaveLength(names.length);
  const js = transpileModule(functions.map(statement => statement.getText(source).replace(/^export /, '')).join('\n'),
    { compilerOptions: { target: ScriptTarget.ES2022 } }).outputText;
  return new Function(...Object.keys(dependencies), `
    let currentGenerationId = 0;
    let dynamicOverlayElements = [], dynamicBlobUrls = [], activeOrbTargets = [];
    const dynamicTiledImages = new Set();
    ${js}
    return { renderGenerationResult, cancelPendingDynamicTerrain };
  `)(...Object.values(dependencies));
}

describe('terrain presentation lifetime', () => {
  it.each([
    ['native', true, false, false, ['coalmine/room', 'static_tile/other']],
    ['approximate fallback', false, false, true, ['static_tile/temples-assets/potion_mimics', 'static_tile/temples-assets/darkness', 'coalmine/room', 'static_tile/other']],
    ['bake', false, true, false, ['static_tile/other']],
  ] as const)('uses the correct temple artwork for %s rendering', async (_mode, instant, offline, forceApproximate, expected) => {
    const stopAfterScenes = new Error('scene list captured');
    const addPixelScenes = vi.fn(async () => { throw stopAfterScenes; });
    const bridge = bridgeLifecycle({
      instantTerrainModule: { clearInstantTerrain: vi.fn() },
      clearPortalAnimations: vi.fn(), clearTerrainPngEncoders: vi.fn(), window: {},
      isDynamicSeedItem: () => true, isGLTerrainEnabled: () => offline,
      isInstantTerrainEnabled: () => !offline, isRepeatedTempleTemplate,
      addBiomeBgToOSD: vi.fn(), addBiomeLayersProgressively: vi.fn(),
      buildMarkerData: async () => ({}), ensureTelescopeModules: async () => {},
      instantSceneMasks: async () => [], glTerrainDeps: {},
      loadInstantTerrain: async () => ({ addInstantTerrain: async () => instant }),
      addPixelScenes,
    });
    const viewer = { world: { getItemCount: () => 0 } };
    const scenes = ['static_tile/temples-assets/potion_mimics', 'static_tile/temples-assets/darkness', 'coalmine/room', 'static_tile/other'].map(key => ({ key }));
    const result = { worldSize: 70, isNGP: false, pixelScenesByPW: { '0,-1': scenes, '1,1': scenes } };
    await expect(bridge.renderGenerationResult(viewer, result,
      undefined, false, undefined, undefined, undefined, false, false, forceApproximate)).rejects.toBe(stopAfterScenes);
    const rendered = (addPixelScenes.mock.calls[0] as any)[1];
    for (const selected of Object.values(rendered.pixelScenesByPW) as { key: string }[][])
      expect(selected.map(scene => scene.key)).toEqual(expected);
    expect(result.pixelScenesByPW['0,-1']).toHaveLength(4);
  });

  it.each(['modules', 'masks'])('does not restart a retired generation delayed on %s', async stage => {
    const ready = barrier(), clear = vi.fn();
    const addInstantTerrain = vi.fn(async () => { throw new Error('retired terrain restarted'); });
    const ensureTelescopeModules = vi.fn(() => stage === 'modules' ? ready.promise : Promise.resolve());
    const instantSceneMasks = vi.fn(() => stage === 'masks' ? ready.promise : Promise.resolve([]));
    const oldImage = {}, removeItem = vi.fn(), removeOverlay = vi.fn();
    const viewer = { world: { getItemCount: () => 1, getItemAt: () => oldImage, removeItem }, removeOverlay };
    const bridge = bridgeLifecycle({
      instantTerrainModule: { clearInstantTerrain: clear },
      clearPortalAnimations: vi.fn(), clearTerrainPngEncoders: vi.fn(), window: {},
      isDynamicSeedItem: () => true, isGLTerrainEnabled: () => true, isInstantTerrainEnabled: () => true,
      buildMarkerData: async () => ({}), ensureTelescopeModules, instantSceneMasks,
      loadInstantTerrain: async () => ({ addInstantTerrain }), glTerrainDeps: {},
    });
    const outgoing = bridge.renderGenerationResult(viewer, { worldSize: 70, isNGP: false });
    if (stage === 'masks') await vi.waitFor(() => expect(instantSceneMasks).toHaveBeenCalledOnce());
    else expect(ensureTelescopeModules).toHaveBeenCalledOnce();

    // The replacement owns the shared GPU slot now, before its own map reaches
    // presentation. There may not yet be an active outgoing terrain lifetime.
    bridge.cancelPendingDynamicTerrain();
    ready.resolve();
    await expect(outgoing).resolves.toBeUndefined();
    expect(addInstantTerrain).not.toHaveBeenCalled();
    expect(clear).toHaveBeenCalledTimes(2);
    expect(removeItem).not.toHaveBeenCalled();
    expect(removeOverlay).not.toHaveBeenCalled();
  });
});
