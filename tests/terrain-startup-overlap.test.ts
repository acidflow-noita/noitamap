import { readFileSync } from 'node:fs';
import { createCanvas } from '@napi-rs/canvas';
import { createSourceFile, isMethodDeclaration, ScriptTarget, transpileModule, type Node } from 'typescript';
import { describe, expect, it, vi } from 'vitest';

// Exercise the production startup callback without booting a browser/worker.
const source = createSourceFile('instant-terrain.ts', readFileSync('src/telescope/instant-terrain.ts', 'utf8'), ScriptTarget.Latest);
const callbacks: string[] = [];
function visit(node: Node) {
  if (isMethodDeclaration(node) && node.name.getText(source) === 'renderFrame') callbacks.push(node.getText(source));
  node.forEachChild(visit);
}
visit(source);
expect(callbacks).toHaveLength(1);
const js = transpileModule(`const startup = { ${callbacks[0]} };`, { compilerOptions: { target: ScriptTarget.ES2022 } }).outputText;
const plan = { x: 0, y: 0, width: 8, height: 4, pixelWidth: 8, pixelHeight: 4, scale: 1 };
function gate() {
  let resolve!: () => void;
  return { promise: new Promise<void>(done => { resolve = done; }), release: () => resolve() };
}
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
function fixture(direct = true) {
  const artwork = gate(), gpu = gate(), lifetime = new AbortController();
  const image = createCanvas(8, 4), context = image.getContext('2d');
  context.fillStyle = '#20c060'; context.fillRect(0, 0, 8, 4);
  const renderer = direct ? { renderViewportSync: vi.fn(() => image), waitForViewport: vi.fn(() => gpu.promise) } : {};
  const display = { render: vi.fn(async () => image) };
  const render = new Function('mainRenderer', 'presentationReady', 'display', 'document', `${js}; return startup.renderFrame;`)(
    renderer, artwork.promise, display, { createElement: () => createCanvas(1, 1) });
  return { artwork, gpu, lifetime, renderer, display, render, image };
}
describe('first terrain frame startup', () => {
  it.each(['artwork', 'gpu'] as const)('submits the requested GPU view early but waits for both prerequisites (%s finishes first)', async first => {
    const f = fixture(); let published = false;
    const pending = f.render(plan, f.lifetime.signal, false).then((image: any) => { published = true; return image; });
    expect((f.renderer as any).renderViewportSync).toHaveBeenCalledExactlyOnceWith(plan);
    f[first].release(); await flush();
    expect(published).toBe(false);
    expect((f.renderer as any).renderViewportSync).toHaveBeenCalledOnce();
    f[first === 'gpu' ? 'artwork' : 'gpu'].release();
    const pixels = await pending;
    expect((f.renderer as any).renderViewportSync).toHaveBeenCalledTimes(2);
    expect([...pixels.getContext('2d').getImageData(2, 1, 1, 1).data]).toEqual([32, 192, 96, 255]);
    expect(f.display.render).not.toHaveBeenCalled();
  });
  it('rejects a cancelled preparation without publishing or redrawing its frame', async () => {
    const f = fixture(), pending = f.render(plan, f.lifetime.signal, false);
    f.lifetime.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    f.gpu.release(); f.artwork.release(); await flush();
    expect((f.renderer as any).renderViewportSync).toHaveBeenCalledOnce();
  });
  it('retains the async fallback artwork barrier and private overview behavior', async () => {
    const f = fixture(false), pending = f.render(plan, f.lifetime.signal, false);
    expect(f.display.render).not.toHaveBeenCalled();
    f.artwork.release(); await pending;
    expect(f.display.render).toHaveBeenCalledOnce();
    const overview = fixture(false);
    await overview.render(plan, overview.lifetime.signal, true);
    expect(overview.display.render).toHaveBeenCalledOnce();
  });
});
