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
    await Promise.resolve(); // Let the old request enter the generator.
    f.resetAltCache();
    f.setSeed(93);
    await f.prewarmAlt(93, false);
    expect(f.rebuildAltLayers).toHaveBeenCalledOnce();
    f.rebuildAltLayers.mockClear();
    complete(result(92));
    await old;
    expect(f.rebuildAltLayers).not.toHaveBeenCalled();
  });

  it('cancels old prewarming before dispatch and stops its remaining descriptors', async () => {
    const f = await fixture('&u=AQAAAAA');
    const old = f.prewarmAlt(92, false);
    f.beginAltSeed(93);
    await old;
    expect(generate).not.toHaveBeenCalled();
  });

  it('resets primary and alternate data when a fresh mod payload replaces the same seed in place', async () => {
    const f = await fixture();
    await f.prewarmAlt(92, false);
    expect(f.primaryDescriptor()).toBe('all');
    expect(f.getAltResult('none', 92)).not.toBeNull();
    history.replaceState({}, '', '/?m=dy&se=92&u=AQAAAAA&p=1.AA');
    f.resetUnlocksForNavigation();
    expect(f.primaryDescriptor()).toBe('mod');
    expect(f.getAltResult('none', 92)).toBeNull();
    expect(f.getActiveDescriptor()).toBe('mod');
    await f.prewarmAlt(92, false);
    expect(f.getAltResult('all', 92)).not.toBeNull();
  });

  it('aborts an active old seed and ignores its late results and notifications', async () => {
    const f = await fixture('&u=AQAAAAA');
    let complete!: (value: GenerationResult) => void;
    generate.mockReturnValueOnce(new Promise<GenerationResult>(resolve => { complete = resolve; }));
    const ready = vi.fn(); f.onAltReady(ready, true);
    const old = f.prewarmAlt(92, false);
    await Promise.resolve();
    const signal: AbortSignal = generate.mock.calls[0][0].signal;
    expect(signal.aborted).toBe(false);
    f.beginAltSeed(93);
    expect(signal.aborted).toBe(true);
    complete(result(92)); // Models an already-running worker finishing late.
    await old;
    expect(generate).toHaveBeenCalledTimes(1); // No second descriptor for 92.
    expect(f.getAltResult('all', 92)).toBeNull();
    expect(ready).not.toHaveBeenCalled();
  });

  it('coalesces explicit demand and protects a replacement same-key request from old cleanup', async () => {
    const f = await fixture();
    const completions: Array<(value: GenerationResult) => void> = [];
    generate.mockImplementation(() => new Promise<GenerationResult>(resolve => { completions.push(resolve); }));
    const old = f.prewarmAlt(92, false);
    await Promise.resolve();
    f.resetAltCache(); f.beginAltSeed(92);
    let finished = false;
    const replacement = f.requestVariant('none').then(() => { finished = true; });
    await Promise.resolve();
    completions[0](result()); await old;
    const joined = f.requestVariant('none');
    await Promise.resolve();
    expect(finished).toBe(false);
    expect(generate).toHaveBeenCalledTimes(2);
    completions[1](result()); await Promise.all([replacement, joined]);
    expect(f.isVariantReady('none', 92)).toBe(true);
    f.beginAltSeed(92);
    await f.prewarmAlt(92, false);
    expect(generate).toHaveBeenCalledTimes(2); // Same-seed cache stays warm.
    f.beginAltSeed(93);
    expect(f.getAltResult('none', 92)).toBeNull();
  });
});
