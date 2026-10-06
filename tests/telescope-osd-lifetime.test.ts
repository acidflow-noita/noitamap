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
    let activeMarkerData, markerTiledImage;
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

function presentationFixture() {
  const artwork = barrier(), calls: any[][] = [];
  const oldImage = { source: {} }, terrainImage = { source: {} };
  const viewer = {
    world: { getItemCount: () => 1, getItemAt: () => oldImage, removeItem: vi.fn() },
    removeOverlay: vi.fn(),
    addTiledImage: vi.fn((options: any) => options.success({ item: { source: options.tileSource } })),
  };
  const module = {
    clearInstantTerrain: vi.fn(() => calls.at(-1)?.[10]?.()),
    addInstantTerrain: vi.fn(async (...args: any[]) => { calls.push(args); args[5](terrainImage); return true; }),
  };
  const deps = {
    instantTerrainModule: module, loadInstantTerrain: async () => module,
    clearPortalAnimations: vi.fn(), clearTerrainPngEncoders: vi.fn(), window: { dispatchEvent: vi.fn() },
    setTimeout: vi.fn((callback: () => void, delay: number) => { if (delay === 0) queueMicrotask(callback); }),
    isDynamicSeedItem: () => true, isGLTerrainEnabled: () => false, isInstantTerrainEnabled: () => true,
    isRepeatedTempleTemplate, addBiomeBgToOSD: vi.fn(), ensureTelescopeModules: async () => {},
    instantSceneMasks: async () => [], glTerrainDeps: {},
    addBiomeLayersProgressively: vi.fn(async (_viewer: any, _result: any, _id: number, paint: () => void) => paint()),
    addPixelScenes: vi.fn(() => artwork.promise), registerPixelSceneHoverDebug: vi.fn(),
    buildMarkerData: vi.fn(async () => ({ originX: 0, originY: 0, bboxWidth: 100 })),
    addOrbOverlays: vi.fn(), installClickHandler: vi.fn(), rebuildHighValueOverlays: vi.fn(),
    createMarkerTileSource: vi.fn(() => ({})), installPortalAnimations: vi.fn(),
    legacyMimicMarkerData: () => null,
    addBakedDZIsToOSD: vi.fn((_viewer: any, placements: any[], added: (item: any) => void) => {
      for (const placement of placements) added({ source: { tilesUrl: placement.dziUrl } });
    }),
  };
  const bridge = bridgeLifecycle(deps);
  const result = { worldSize: 70, isNGP: false, pixelScenesByPW: {} };
  const firstPaint = vi.fn();
  const start = () => bridge.renderGenerationResult(viewer, result, null, false, firstPaint);
  return { ...deps, bridge, viewer, result, artwork, calls, module, firstPaint, start, oldImage };
}

describe('terrain before live POIs', () => {
  it('passes the persisted-terrain preference to live presentation', async () => {
    const f = presentationFixture();
    const pending = f.bridge.renderGenerationResult(f.viewer, f.result, null, false, f.firstPaint,
      'cached-seed', null, false, false, false, 0, true);
    await vi.waitFor(() => expect(f.addPixelScenes).toHaveBeenCalledOnce());
    expect(f.calls[0][11]).toBe(true);
    f.artwork.resolve(); await f.calls[0][9]; f.calls[0][6](); await pending;
  });
  it('releases terrain after artwork and prepares no POIs until that terrain has actually painted', async () => {
    const f = presentationFixture(), pending = f.start();
    await vi.waitFor(() => expect(f.addPixelScenes).toHaveBeenCalledOnce());
    const terrainMayDraw = vi.fn();
    f.calls[0][9].then(terrainMayDraw);
    expect(f.buildMarkerData).not.toHaveBeenCalled();
    expect(f.addOrbOverlays).not.toHaveBeenCalled();
    expect(terrainMayDraw).not.toHaveBeenCalled();
    f.artwork.resolve();
    await vi.waitFor(() => expect(terrainMayDraw).toHaveBeenCalledOnce());
    expect(f.buildMarkerData).not.toHaveBeenCalled();
    expect(f.installClickHandler).not.toHaveBeenCalled();
    expect(f.viewer.world.removeItem).not.toHaveBeenCalled();
    f.calls[0][6](); // actual complete-frame notification, not renderer attachment
    await pending;
    expect(f.firstPaint).toHaveBeenCalledOnce();
    expect(f.viewer.world.removeItem).toHaveBeenCalledWith(f.oldImage);
    expect(f.buildMarkerData).toHaveBeenCalledOnce();
    expect(f.addOrbOverlays).toHaveBeenCalledOnce();
    expect(f.installClickHandler).toHaveBeenCalledOnce();
    expect(f.createMarkerTileSource).toHaveBeenCalledOnce();
    expect(f.buildMarkerData.mock.invocationCallOrder[0]).toBeGreaterThan(f.firstPaint.mock.invocationCallOrder[0]);
  });

  it('settles a cancelled frame wait and ignores a late paint without adding obsolete POIs', async () => {
    const f = presentationFixture(), pending = f.start();
    await vi.waitFor(() => expect(f.addPixelScenes).toHaveBeenCalledOnce());
    f.artwork.resolve();
    await f.calls[0][9];
    f.bridge.cancelPendingDynamicTerrain();
    await pending;
    f.calls[0][6]();
    expect(f.firstPaint).not.toHaveBeenCalled();
    expect(f.viewer.world.removeItem).not.toHaveBeenCalled();
    expect(f.buildMarkerData).not.toHaveBeenCalled();
    expect(f.addOrbOverlays).not.toHaveBeenCalled();
  });

  it('joins the approximate fallback after GPU failure instead of leaving the first-frame wait stuck', async () => {
    const f = presentationFixture(), approximate = barrier(), finished = vi.fn();
    f.addBiomeLayersProgressively.mockImplementation(async (_viewer, _result, _id, paint) => {
      await approximate.promise; paint();
    });
    const pending = f.start().then(finished);
    await vi.waitFor(() => expect(f.addPixelScenes).toHaveBeenCalledOnce());
    f.artwork.resolve();
    await f.calls[0][9];
    f.calls[0][10]?.(); // renderer disposal precedes its fallback callback
    f.calls[0][7](new Error('GPU lost'));
    await vi.waitFor(() => expect(f.addBiomeLayersProgressively).toHaveBeenCalledOnce());
    expect(finished).not.toHaveBeenCalled();
    expect(f.buildMarkerData).not.toHaveBeenCalled();
    approximate.resolve();
    await pending;
    expect(f.firstPaint).toHaveBeenCalledOnce();
    expect(f.buildMarkerData).toHaveBeenCalledOnce();
    expect(f.installClickHandler).toHaveBeenCalledOnce();
  });

  it('keeps visible terrain running if later marker preparation fails', async () => {
    const f = presentationFixture(), error = new Error('marker atlas unavailable');
    f.buildMarkerData.mockRejectedValue(error);
    const pending = expect(f.start()).rejects.toBe(error);
    await vi.waitFor(() => expect(f.addPixelScenes).toHaveBeenCalledOnce());
    f.artwork.resolve();
    await f.calls[0][9];
    f.calls[0][6]();
    await pending;
    expect(f.firstPaint).toHaveBeenCalledOnce();
    expect(f.module.clearInstantTerrain).toHaveBeenCalledOnce(); // initial setup only
  });

  it.each(['daily', 'previous-daily'])('keeps baked %s metadata independent of live terrain readiness', async prefix => {
    const f = presentationFixture();
    await f.bridge.renderGenerationResult(f.viewer, f.result, null, true, f.firstPaint, 'baked',
      [{ dziUrl: `https://${prefix}-middle.acidflow.stream/map.dzi` }], false, true);
    expect(f.addBakedDZIsToOSD).toHaveBeenCalledOnce();
    expect(f.module.addInstantTerrain).not.toHaveBeenCalled();
    expect(f.addPixelScenes).not.toHaveBeenCalled();
    expect(f.buildMarkerData).toHaveBeenCalledOnce();
    expect(f.installClickHandler).toHaveBeenCalledOnce();
    expect(f.createMarkerTileSource).not.toHaveBeenCalled();
  });
});
