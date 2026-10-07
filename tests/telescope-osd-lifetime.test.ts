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
  const names = ['clearInstantTerrain', 'beginMarkerRequest', 'cancelPendingDynamicTerrain', 'clearDynamicOverlays', 'renderGenerationResult', 'rebuildAltLayers'];
  if (!dependencies.addOrbOverlays) names.push('addOrbOverlays');
  const functions = source.statements.filter(statement =>
    isFunctionDeclaration(statement) && names.includes(statement.name?.text ?? ''));
  expect(functions).toHaveLength(names.length);
  const js = transpileModule(functions.map(statement => statement.getText(source).replace(/^export /, '')).join('\n'),
    { compilerOptions: { target: ScriptTarget.ES2022 } }).outputText;
  return new Function(...Object.keys(dependencies), `
    let currentGenerationId = 0, currentMarkerRequestId = 0, pendingMarkerProgressGeneration;
    let dynamicOverlayElements = [], dynamicBlobUrls = [], activeOrbTargets = [];
    let activeMarkerData, markerTiledImage, suspendedMarkerContext;
    const dynamicTiledImages = new Set();
    ${js}
    return { renderGenerationResult, cancelPendingDynamicTerrain, clearDynamicOverlays, rebuildAltLayers,
      markers: () => activeMarkerData, orbs: () => activeOrbTargets };
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

function presentationFixture(instant = true) {
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
    isDynamicSeedItem: () => true, isGLTerrainEnabled: () => false, isInstantTerrainEnabled: () => instant,
    isRepeatedTempleTemplate, addBiomeBgToOSD: vi.fn(), ensureTelescopeModules: async () => {},
    instantSceneMasks: async () => [], glTerrainDeps: {},
    addBiomeLayersProgressively: vi.fn(async (_viewer: any, _result: any, _id: number, paint: () => void) => paint()),
    addPixelScenes: vi.fn(() => artwork.promise), registerPixelSceneHoverDebug: vi.fn(),
    buildMarkerData: vi.fn(async () => ({ originX: 0, originY: 0, bboxWidth: 100 })),
    addOrbOverlays: vi.fn(), installClickHandler: vi.fn(), rebuildHighValueOverlays: vi.fn(),
    createMarkerTileSource: vi.fn(() => ({})), installPortalAnimations: vi.fn(),
    resetPOICardContext: vi.fn(), liveSceneBitmaps: { clear: vi.fn() },
    resetPersistentBiomeBackgrounds: vi.fn(), clearBiomeBackgroundLayers: vi.fn(),
    clearGLTerrain: vi.fn(), clearHighValueOverlays: vi.fn(),
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

describe('marker progress belongs to its generation', () => {
  async function paint(f: ReturnType<typeof presentationFixture>, index = 0) {
    await vi.waitFor(() => expect(f.calls.length).toBeGreaterThan(index));
    f.artwork.resolve(); await f.calls[index][9]; f.calls[index][6]();
  }
  function retire(f: ReturnType<typeof presentationFixture>, target: string) {
    if (target === 'static') f.bridge.clearDynamicOverlays(f.viewer);
    else f.bridge.cancelPendingDynamicTerrain();
  }
  const progress = (f: ReturnType<typeof presentationFixture>) => f.window.dispatchEvent.mock.calls
    .map(([event]) => (event as CustomEvent).detail.percentage);

  it.each(['reseed', 'static'].flatMap(target => ['success', 'failure'].map(outcome => ({ target, outcome }))))(
    'ignores marker preparation $outcome after retirement to $target', async ({ target, outcome }) => {
      const f = presentationFixture(), ready = barrier(), error = new Error('old sprite load failed');
      f.buildMarkerData.mockImplementationOnce(async () => {
        await ready.promise;
        if (outcome === 'failure') throw error;
        return { originX: 0, originY: 0, bboxWidth: 100 };
      });
      const pending = f.start();
      await paint(f);
      await vi.waitFor(() => expect(f.buildMarkerData).toHaveBeenCalledOnce());
      expect(progress(f)).toEqual([0]);
      retire(f, target); f.window.dispatchEvent.mockClear();
      ready.resolve();
      await expect(pending).resolves.toBeUndefined();
      expect(f.window.dispatchEvent).not.toHaveBeenCalled();
      expect(f.installClickHandler).not.toHaveBeenCalled();
      expect(f.createMarkerTileSource).not.toHaveBeenCalled();
      expect(f.installPortalAnimations).not.toHaveBeenCalled();
    },
  );

  it.each(['reseed', 'static'].flatMap(target => ['success', 'error', 'timeout'].map(callback => ({ target, callback }))))(
    'ignores an old marker $callback callback and timeout after retirement to $target', async ({ target, callback }) => {
      const f = presentationFixture(), attachments: any[] = [];
      f.viewer.addTiledImage.mockImplementation(options => { attachments.push(options); });
      const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const pending = f.start(); await paint(f); await pending;
        expect(progress(f)).toEqual([0, 50]);
        const timeout = f.setTimeout.mock.calls.find(([, ms]) => ms === 3000)![0];
        retire(f, target); f.window.dispatchEvent.mockClear();
        if (callback === 'success') {
          const stale = {}; attachments[0].success({ item: stale });
          expect(f.viewer.world.removeItem).toHaveBeenCalledWith(stale);
        } else if (callback === 'error') attachments[0].error(new Error('old OSD request failed'));
        // A rejected late success also leaves the old fallback timer queued.
        timeout(); timeout();
        expect(f.window.dispatchEvent).not.toHaveBeenCalled();
        expect(warning).not.toHaveBeenCalled();
      } finally { warning.mockRestore(); }
    },
  );

  it.each(['success', 'error', 'timeout'])('keeps the active generation\'s %s completion working exactly once', async callback => {
    const f = presentationFixture(), attachments: any[] = [];
    f.viewer.addTiledImage.mockImplementation(options => { attachments.push(options); });
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const pending = f.start(); await paint(f); await pending;
      const timeout = f.setTimeout.mock.calls.find(([, ms]) => ms === 3000)![0];
      if (callback === 'success') attachments[0].success({ item: {} });
      else if (callback === 'error') attachments[0].error(new Error('current OSD request failed'));
      timeout(); timeout();
      expect(progress(f)).toEqual([0, 50, 100]);
      expect(warning).toHaveBeenCalledTimes(callback === 'error' ? 1 : 0);
      expect(f.module.clearInstantTerrain).toHaveBeenCalledOnce(); // initial setup only
    } finally { warning.mockRestore(); }
  });

  it('does not let an older timer finish the replacement generation\'s progress', async () => {
    const f = presentationFixture(), attachments: any[] = [];
    f.viewer.addTiledImage.mockImplementation(options => { attachments.push(options); });
    const old = f.start(); await paint(f); await old;
    const oldTimeout = f.setTimeout.mock.calls.find(([, ms]) => ms === 3000)![0];
    const current = f.start(); await paint(f, 1); await current;
    expect(progress(f)).toEqual([0, 50, 0, 50]);
    f.window.dispatchEvent.mockClear();
    oldTimeout(); expect(f.window.dispatchEvent).not.toHaveBeenCalled();
    attachments[1].success({ item: {} });
    expect(progress(f)).toEqual([100]);
    oldTimeout(); expect(progress(f)).toEqual([100]);
  });
});

describe('same-seed marker request ownership', () => {
  const progress = (f: ReturnType<typeof presentationFixture>) => f.window.dispatchEvent.mock.calls
    .map(([event]) => (event as CustomEvent).detail.percentage);

  async function paint(f: ReturnType<typeof presentationFixture>) {
    const pending = f.start();
    await vi.waitFor(() => expect(f.addPixelScenes).toHaveBeenCalledOnce());
    f.artwork.resolve(); await f.calls[0][9]; f.calls[0][6](); await pending;
  }

  it.each(['success', 'failure'])('ignores an older unlock build that finishes with %s', async outcome => {
    const f = presentationFixture(), ready = barrier(), started = barrier();
    const old = { ...f.result, variant: 'old' }, current = { ...f.result, variant: 'current' };
    f.buildMarkerData.mockImplementation((async (result: unknown) => {
      if (result === old) {
        started.resolve(); await ready.promise;
        if (outcome === 'failure') throw new Error('obsolete marker preparation');
      }
      return { originX: 0, originY: 0, bboxWidth: 100, result };
    }) as any);
    const previous = f.bridge.rebuildAltLayers(f.viewer, old, [], false);
    await started.promise;
    await f.bridge.rebuildAltLayers(f.viewer, current, null, false);
    ready.resolve(); await expect(previous).resolves.toBeUndefined();
    expect(f.installClickHandler).toHaveBeenCalledOnce();
    expect(f.bridge.markers().result).toBe(current);
    expect(f.viewer.addTiledImage).toHaveBeenCalledOnce();
    expect(f.window.dispatchEvent).not.toHaveBeenCalled();
    expect(f.module.addInstantTerrain).not.toHaveBeenCalled();
    expect(f.module.clearInstantTerrain).not.toHaveBeenCalled();
  });

  it('removes a late OSD attachment without replacing the current layer', async () => {
    const f = presentationFixture(), attachments: any[] = [];
    f.viewer.addTiledImage.mockImplementation(options => { attachments.push(options); });
    await f.bridge.rebuildAltLayers(f.viewer, f.result, [], false);
    await f.bridge.rebuildAltLayers(f.viewer, f.result, null, false);
    const old = {}, current = {};
    attachments[1].success({ item: current }); attachments[0].success({ item: old });
    expect(f.viewer.world.removeItem).toHaveBeenCalledWith(old);
    expect(f.viewer.world.removeItem).not.toHaveBeenCalledWith(current);
    await f.bridge.rebuildAltLayers(f.viewer, f.result, [], false);
    expect(f.viewer.world.removeItem).toHaveBeenLastCalledWith(current);
  });

  it.each(['success', 'error', 'timeout'])('hands initial marker progress to the replacement %s callback', async completion => {
    const f = presentationFixture(), attachments: any[] = [];
    f.viewer.addTiledImage.mockImplementation(options => { attachments.push(options); });
    await paint(f);
    expect(progress(f)).toEqual([0, 50]);
    const oldTimeout = f.setTimeout.mock.calls.find(([, ms]) => ms === 3000)![0];
    await f.bridge.rebuildAltLayers(f.viewer, f.result, [], false);
    f.window.dispatchEvent.mockClear();
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const old = {};
      attachments[0].success({ item: old });
      attachments[0].error(new Error('obsolete OSD callback')); oldTimeout();
      expect(f.viewer.world.removeItem).toHaveBeenCalledWith(old);
      expect(f.window.dispatchEvent).not.toHaveBeenCalled();
      expect(warning).not.toHaveBeenCalled();
      if (completion === 'success') attachments[1].success({ item: {} });
      else if (completion === 'error') attachments[1].error(new Error('current OSD callback'));
      else f.setTimeout.mock.calls.filter(([, ms]) => ms === 3000).at(-1)![0]();
      expect(progress(f)).toEqual([100]);
      expect(warning).toHaveBeenCalledTimes(completion === 'error' ? 1 : 0);
      oldTimeout(); attachments[1].success({ item: {} });
      expect(progress(f)).toEqual([100]);
    } finally { warning.mockRestore(); }
  });

  it('finishes adopted progress when current marker preparation fails', async () => {
    const f = presentationFixture();
    f.viewer.addTiledImage.mockImplementation(() => {});
    await paint(f); f.window.dispatchEvent.mockClear();
    const error = new Error('current atlas failure');
    f.buildMarkerData.mockRejectedValueOnce(error);
    await expect(f.bridge.rebuildAltLayers(f.viewer, f.result, [], false)).rejects.toBe(error);
    expect(progress(f)).toEqual([100]);
  });

  it('does not open a progress interval for an ordinary unlock refresh', async () => {
    const f = presentationFixture();
    await f.bridge.rebuildAltLayers(f.viewer, f.result, [], false);
    expect(f.window.dispatchEvent).not.toHaveBeenCalled();
    expect(f.setTimeout).not.toHaveBeenCalled();
  });

  it.each(['reseed', 'static'].flatMap(target => ['success', 'failure'].map(outcome => ({ target, outcome }))))(
    'retires an unlock build with $outcome when leaving for $target', async ({ target, outcome }) => {
      const f = presentationFixture(), ready = barrier(), started = barrier();
      f.buildMarkerData.mockImplementationOnce(async () => {
        started.resolve(); await ready.promise;
        if (outcome === 'failure') throw new Error('retired unlock build');
        return { originX: 0, originY: 0, bboxWidth: 100 };
      });
      const pending = f.bridge.rebuildAltLayers(f.viewer, f.result, [], false);
      await started.promise;
      if (target === 'static') f.bridge.clearDynamicOverlays(f.viewer);
      else f.bridge.cancelPendingDynamicTerrain();
      ready.resolve(); await expect(pending).resolves.toBeUndefined();
      expect(f.viewer.addTiledImage).not.toHaveBeenCalled();
      expect(f.installClickHandler).not.toHaveBeenCalled();
      expect(f.window.dispatchEvent).not.toHaveBeenCalled();
    },
  );

  it('ignores superseded initial orb errors while finishing the terrain handoff', async () => {
    const f = presentationFixture(false), ready = barrier(), started = barrier();
    f.addBiomeLayersProgressively.mockImplementation(async () => {});
    f.addOrbOverlays.mockImplementationOnce(async () => {
      started.resolve(); await ready.promise; throw new Error('obsolete orb load');
    });
    const pending = f.start();
    await vi.waitFor(() => expect(f.addPixelScenes).toHaveBeenCalledOnce());
    f.artwork.resolve(); await started.promise;
    await f.bridge.rebuildAltLayers(f.viewer, f.result, [], false);
    ready.resolve(); await expect(pending).resolves.toBeUndefined();
    expect(f.installClickHandler).toHaveBeenCalledOnce();
    expect(f.window.dispatchEvent).not.toHaveBeenCalled();
    expect(f.installPortalAnimations).toHaveBeenCalledOnce();
    expect(f.viewer.world.removeItem).toHaveBeenCalledWith(f.oldImage);
  });

  it.each(['success', 'failure'])('keeps terrain cleanup and portals when superseded initial markers settle with %s', async outcome => {
    const f = presentationFixture(false), ready = barrier(), started = barrier();
    const initial = { ...f.result, variant: 'initial' };
    f.addBiomeLayersProgressively.mockImplementation(async () => {});
    f.buildMarkerData.mockImplementation((async (result: unknown) => {
      if (result === initial) {
        started.resolve(); await ready.promise;
        if (outcome === 'failure') throw new Error('obsolete initial marker failure');
      }
      return { originX: 0, originY: 0, bboxWidth: 100, result };
    }) as any);
    const pending = f.bridge.renderGenerationResult(f.viewer, initial);
    await vi.waitFor(() => expect(f.addPixelScenes).toHaveBeenCalledOnce());
    f.artwork.resolve(); await started.promise;
    expect(progress(f)).toEqual([0]);
    await f.bridge.rebuildAltLayers(f.viewer, f.result, [], false);
    expect(progress(f)).toEqual([0, 100]);
    f.window.dispatchEvent.mockClear(); ready.resolve();
    await expect(pending).resolves.toBeUndefined();
    expect(f.window.dispatchEvent).not.toHaveBeenCalled();
    expect(f.installClickHandler).toHaveBeenCalledOnce();
    expect(f.bridge.markers().result).toBe(f.result);
    expect(f.installPortalAnimations).toHaveBeenCalledExactlyOnceWith(f.viewer, initial);
    expect(f.viewer.world.removeItem).toHaveBeenCalledWith(f.oldImage);
  });

  it.each(['icons', 'collected sprite'])('ignores obsolete orb overlays after waiting for %s', async stage => {
    const ready = barrier(), started = barrier();
    const viewer = { world: { removeItem: vi.fn() }, removeOverlay: vi.fn(), addOverlay: vi.fn(),
      addTiledImage: vi.fn((options: any) => options.success({ item: {} })) };
    const loadIcon = vi.fn(async () => {});
    const emptySprite = vi.fn(async () => 'empty-orb');
    if (stage === 'icons') loadIcon.mockImplementationOnce(async () => { started.resolve(); await ready.promise; });
    else emptySprite.mockImplementationOnce(async () => { started.resolve(); await ready.promise; return 'obsolete-empty-orb'; });
    const bridge = bridgeLifecycle({
      orbsData: [{ maps: ['dynamic-main-branch'], icon: 'orb_00.png', x: 10, y: 20 }],
      ORB_OVERLAY_UNLOCK_KEYS: ['sea_lava'], _orbIconCache: new Map([['orb_00.png', 'full-orb']]),
      loadOrbIconByPath: loadIcon, getPOISpriteFirstFrame: emptySprite,
      document: { createElement: () => ({ style: {}, remove: vi.fn() }) },
      OpenSeadragon: { Rect: class {} }, window: { dispatchEvent: vi.fn() },
      buildMarkerData: async () => ({ originX: 0, originY: 0, bboxWidth: 100 }),
      createMarkerTileSource: () => ({}), installClickHandler: vi.fn(), rebuildHighValueOverlays: vi.fn(),
    });
    const previous = bridge.rebuildAltLayers(viewer, {}, ['sea_lava'], false);
    await started.promise;
    await bridge.rebuildAltLayers(viewer, {}, null, false);
    ready.resolve(); await previous;
    expect(viewer.addOverlay).toHaveBeenCalledOnce();
    expect(bridge.orbs()).toHaveLength(1);
    expect(bridge.orbs()[0].iconUrl).toBe('full-orb');
    expect(viewer.addTiledImage).toHaveBeenCalledOnce();
  });
});
