// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { createScenePrefetchGate } from '../src/telescope/scene-prefetch-gate';

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const close of cleanups.splice(0)) close();
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});

function fixture() {
  const handlers = new Map<string, Set<() => void>>();
  const frames = new Map<number, FrameRequestCallback>();
  const idle = new Map<number, IdleRequestCallback>();
  let sequence = 0, animating = false, terrainBusy = false, hidden = false;
  vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden);
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { frames.set(++sequence, cb); return sequence; });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  vi.stubGlobal('requestIdleCallback', (cb: IdleRequestCallback) => { idle.set(++sequence, cb); return sequence; });
  vi.stubGlobal('cancelIdleCallback', (id: number) => idle.delete(id));
  const viewer = {
    isAnimating: () => animating,
    world: { getItemCount: () => 1, getItemAt: () => ({ source: { isInstantTerrainBusy: () => terrainBusy } }) },
    addHandler(name: string, cb: () => void) { if (!handlers.has(name)) handlers.set(name, new Set()); handlers.get(name)!.add(cb); },
    removeHandler(name: string, cb: () => void) { handlers.get(name)?.delete(cb); },
  };
  const controller = new AbortController();
  const gate = createScenePrefetchGate({ viewer }, controller.signal);
  cleanups.push(gate.dispose);
  const emit = (name: string) => { for (const cb of [...handlers.get(name) ?? []]) cb(); };
  return { viewer, gate, controller, handlers, frames, idle, emit,
    frame() { const work = [...frames.values()]; frames.clear(); for (const cb of work) cb(0); },
    runIdle() { const work = [...idle.values()]; idle.clear(); for (const cb of work) cb({ didTimeout: false, timeRemaining: () => 10 }); },
    animate(value: boolean) { animating = value; emit(value ? 'animation-start' : 'animation-finish'); },
    terrain(value: boolean) { terrainBusy = value; emit('update-viewport'); },
    visibility(value: boolean) { hidden = value; document.dispatchEvent(new Event('visibilitychange')); },
  };
}

it('admits each scene only after a viewer frame and an idle opportunity', async () => {
  const f = fixture(), ready = vi.fn();
  const first = f.gate.wait().then(ready);
  await Promise.resolve(); expect(ready).not.toHaveBeenCalled();
  expect(f.frames.size).toBe(1); expect(f.idle.size).toBe(0);
  f.frame(); expect(f.idle.size).toBe(1);
  f.runIdle(); await first; expect(ready).toHaveBeenCalledWith(true);
  const next = f.gate.wait(); expect(f.frames.size).toBe(1);
  f.frame(); f.runIdle(); await expect(next).resolves.toBe(true);
});

it.each(['pan', 'zoom', 'resize'])('withdraws an idle grant when %s begins and waits for settling', async event => {
  const f = fixture(), ready = vi.fn();
  const wait = f.gate.wait().then(ready); f.frame();
  const obsolete = [...f.idle.values()][0];
  f.emit(event); f.animate(true);
  expect(f.idle.size).toBe(0); expect(f.frames.size).toBe(0);
  obsolete({ didTimeout: false, timeRemaining: () => 10 });
  await Promise.resolve(); expect(ready).not.toHaveBeenCalled();
  f.emit('update-viewport'); expect(f.frames.size).toBe(0);
  f.animate(false); f.frame(); f.runIdle();
  await wait; expect(ready).toHaveBeenCalledWith(true);
});

it('keeps prefetch paused through a held drag and its release animation', async () => {
  const f = fixture(); f.emit('canvas-press');
  const wait = f.gate.wait(); expect(f.frames.size).toBe(0);
  f.emit('canvas-drag'); f.animate(true); f.emit('canvas-drag-end'); f.emit('canvas-release');
  expect(f.frames.size).toBe(0);
  f.animate(false); f.frame(); f.runIdle(); await expect(wait).resolves.toBe(true);
});

it('gives pending visible terrain priority even after camera animation ends', async () => {
  const f = fixture(); f.terrain(true);
  const wait = f.gate.wait(); f.animate(false); expect(f.frames.size).toBe(0);
  f.terrain(false); f.frame(); f.runIdle(); await expect(wait).resolves.toBe(true);
});

it('resumes on visibility and cancels hidden waits without relying on another frame', async () => {
  const f = fixture(); f.visibility(true);
  const first = f.gate.wait(); expect(f.frames.size).toBe(0);
  f.visibility(false); f.frame(); f.runIdle(); await expect(first).resolves.toBe(true);
  f.visibility(true); const cancelled = f.gate.wait(); f.controller.abort();
  await expect(cancelled).resolves.toBe(false);
  expect([...f.handlers.values()].every(set => !set.size)).toBe(true);
  expect(f.frames.size + f.idle.size).toBe(0);
  await expect(f.gate.wait()).resolves.toBe(false);
});

it('cancels pending callbacks on viewer destruction', async () => {
  const f = fixture(); const wait = f.gate.wait(); f.frame();
  f.emit('before-destroy'); await expect(wait).resolves.toBe(false);
  expect(f.idle.size).toBe(0);
  expect([...f.handlers.values()].every(set => !set.size)).toBe(true);
});

it('uses a later task without idle API support and rejects a stale task grant', async () => {
  const f = fixture(); vi.stubGlobal('requestIdleCallback', undefined);
  const tasks: Array<() => void> = [];
  vi.stubGlobal('scheduler', { yield: () => new Promise<void>(resolve => tasks.push(resolve)) });
  const ready = vi.fn(), wait = f.gate.wait().then(ready);
  f.frame(); expect(tasks).toHaveLength(1);
  f.emit('update-viewport'); expect(f.frames.size).toBe(0);
  f.emit('pan'); f.animate(true); tasks.shift()!();
  await Promise.resolve(); expect(ready).not.toHaveBeenCalled();
  f.animate(false); f.frame(); tasks.shift()!(); await wait;
  expect(ready).toHaveBeenCalledWith(true);
});
