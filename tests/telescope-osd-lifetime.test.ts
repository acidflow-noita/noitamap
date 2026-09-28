import { readFileSync } from 'node:fs';
import { createSourceFile, isFunctionDeclaration, ScriptTarget, transpileModule } from 'typescript';
import { describe, expect, it, vi } from 'vitest';

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
