// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import {
  createSourceFile, isCallExpression, isExpressionStatement,
  isIdentifier, isVariableStatement, type Node, ScriptTarget, transpileModule,
} from 'typescript';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GenerationResult } from '../src/telescope/telescope-adapter';
import { getUnlocksFromURL } from '../src/unlocks';

const { generate } = vi.hoisted(() => ({ generate: vi.fn() }));
vi.mock('../src/telescope/telescope-adapter', () => ({ generateDynamicMap: generate }));
vi.mock('../src/dynamic-map', () => ({ getCurrentIsDaily: () => false }));
vi.mock('../src/light-mode', () => ({ isLightMode: () => false }));

// Execute the app's real refresh wiring with the real unlock cache/listeners,
// without starting the map UI or generating terrain.
const source = createSourceFile('main.ts', readFileSync('src/main.ts', 'utf8'), ScriptTarget.Latest);
const wiring: string[] = [];
function collect(statement: Node) {
  const refresh = isVariableStatement(statement) && statement.declarationList.declarations.some(declaration =>
    isIdentifier(declaration.name) && declaration.name.text === 'refreshActiveVariant');
  const listener = isExpressionStatement(statement) && isCallExpression(statement.expression)
    && isIdentifier(statement.expression.expression)
    && ['onActiveDescriptorChange', 'onAltReady'].includes(statement.expression.expression.text);
  if (refresh || listener) wiring.push(statement.getText(source));
  else statement.forEachChild(collect);
}
collect(source);
expect(wiring).toHaveLength(3);
const refreshJS = transpileModule(wiring.join('\n'),
  { compilerOptions: { target: ScriptTarget.ES2022 } }).outputText;

function result(seed = 92): GenerationResult {
  return { seed, poisByPW: { '0,0': [{ type: 'wand', x: 10, y: 20 }] } } as unknown as GenerationResult;
}

async function fixture(unlockParam = '') {
  history.replaceState({}, '', `/?m=dy&se=92${unlockParam}`);
  const variants = await import('../src/unlocks-toggle');
  variants.getActiveDescriptor(); // read the initial URL and persisted view
  let seed: number | null = 92;
  const primary = result();
  const rebuildAltLayers = vi.fn();
  const unifiedSearch = {
    setIndexingState: vi.fn(), setDynamicPOIs: vi.fn(), updateSearchResults: vi.fn(),
  };
  const dependencies = {
    ...variants, getCurrentDynamicSeed: () => seed, getCurrentIsDaily: () => false,
    getLastGenerationResult: () => primary, getUnlocksFromURL,
    getAllPOIsFlat: (value: GenerationResult) => Object.values(value.poisByPW).flat(),
    buildPOIName: () => 'Wand', isSkipCreatures: () => false,
    app: { osd: {} }, rebuildAltLayers, unifiedSearch,
  };
  new Function(...Object.keys(dependencies), `
    let _allDynamicPOIs = [], _currentDynamicPOIs = [];
    ${refreshJS}
  `)(...Object.values(dependencies));
  return { ...variants, primary, rebuildAltLayers, unifiedSearch, setSeed: (value: number | null) => { seed = value; } };
}

describe('POI refresh after background unlock generation', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.resetAllMocks();
    const storage = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    });
    generate.mockImplementation(async ({ seed }) => result(seed));
  });
  afterEach(() => vi.unstubAllGlobals());

  it.each([
    ['all', '', 1], ['none', '&u=none', 1], ['mod', '&u=AQAAAAA', 2],
  ] as const)('keeps the visible %s markers when unused variants finish', async (_primary, param, generations) => {
    const f = await fixture(param);
    const cardReady = vi.fn();
    f.onAltReady(cardReady);
    await f.prewarmAlt(92, false);
    expect(generate).toHaveBeenCalledTimes(generations);
    expect(cardReady).toHaveBeenCalledTimes(generations); // tooltips still receive readiness
    expect(f.rebuildAltLayers).not.toHaveBeenCalled();
    expect(f.unifiedSearch.setDynamicPOIs).not.toHaveBeenCalled();
  });

  it('applies a selected pending variant once, ignoring the other variant finishing later', async () => {
    const f = await fixture('&u=AQAAAAA');
    f.setActiveDescriptor('all');
    expect(f.unifiedSearch.setIndexingState).toHaveBeenLastCalledWith('indexing');
    expect(f.rebuildAltLayers).not.toHaveBeenCalled();
    await f.prewarmAlt(92, false); // completes all, then none
    expect(generate).toHaveBeenCalledTimes(2);
    expect(f.rebuildAltLayers).toHaveBeenCalledExactlyOnceWith(
      expect.anything(), f.getAltResult('all', 92), null, false);
    expect(f.unifiedSearch.setIndexingState).toHaveBeenLastCalledWith('ready');
  });

  it('still switches markers for explicit changes to a cached variant and back to primary', async () => {
    const f = await fixture();
    await f.prewarmAlt(92, false);
    f.rebuildAltLayers.mockClear();
    f.setActiveDescriptor('none');
    expect(f.rebuildAltLayers).toHaveBeenLastCalledWith(expect.anything(), f.getAltResult('none', 92), [], false);
    f.setActiveDescriptor('all');
    expect(f.rebuildAltLayers).toHaveBeenLastCalledWith(expect.anything(), f.primary, null, false);
    expect(f.rebuildAltLayers).toHaveBeenCalledTimes(2);
  });

  it('does not refresh a new seed when an older seed finishes the same selected variant', async () => {
    const f = await fixture();
    let complete!: (value: GenerationResult) => void;
    generate.mockReturnValueOnce(new Promise<GenerationResult>(resolve => { complete = resolve; }));
    f.setActiveDescriptor('none');
    const old = f.prewarmAlt(92, false);
    f.resetAltCache();
    f.setSeed(93);
    await f.prewarmAlt(93, false);
    expect(f.rebuildAltLayers).toHaveBeenCalledOnce();
    f.rebuildAltLayers.mockClear();
    complete(result(92));
    await old;
    expect(f.rebuildAltLayers).not.toHaveBeenCalled();
  });
});
