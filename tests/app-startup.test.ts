// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppCreateOpts } from '../src/app';
import type { URLState } from '../src/data_sources/url';

const dependencies = vi.hoisted(() => ({ create: vi.fn(), translations: vi.fn() }));
vi.mock('../src/app', () => ({ App: { create: dependencies.create } }));
vi.mock('../src/i18n', () => ({ initializeTranslations: dependencies.translations }));
import { initializeApplication } from '../src/app/startup';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function options(): AppCreateOpts {
  const initialState: URLState = {
    map: 'dynamic-main-branch', pos: { x: 120, y: -560, zoom: 3 }, seed: 123,
    query: 'black hole', filters: ['s'], targetPoiId: 'd-test',
    overlays: ['items'], seedReportOpen: true,
  };
  return {
    mountTo: document.createElement('div'), overlayButtons: document.createElement('div'),
    useWebGL: true, initialState,
  };
}

beforeEach(() => {
  dependencies.create.mockReset();
  dependencies.translations.mockReset();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('parallel application startup', () => {
  it('starts and finishes map creation while the dictionary is still loading', async () => {
    const dictionary = deferred<void>();
    const map = deferred<object>();
    const app = {};
    const opts = options();
    dependencies.translations.mockReturnValue(dictionary.promise);
    dependencies.create.mockReturnValue(map.promise);
    const started = initializeApplication(opts);
    let ready = false;
    void started.then(() => { ready = true; });
    expect(dependencies.create).toHaveBeenCalledWith(opts);
    expect(dependencies.translations).toHaveBeenCalledTimes(1);
    map.resolve(app);
    await Promise.resolve();
    expect(ready).toBe(false);
    dictionary.resolve();
    await expect(started).resolves.toBe(app);
  });

  it('opens the map even when dictionary loading fails', async () => {
    const failure = new Error('translation request failed');
    const app = {};
    dependencies.translations.mockRejectedValue(failure);
    dependencies.create.mockResolvedValue(app);
    await expect(initializeApplication(options())).resolves.toBe(app);
    expect(dependencies.create).toHaveBeenCalledTimes(1);
    expect(console.error).toHaveBeenCalledWith('i18next initialization failed:', failure);
  });

  it('changes only the map on fallback and leaves the caller state intact', async () => {
    const opts = options();
    const originalState = structuredClone(opts.initialState);
    const app = {};
    dependencies.translations.mockResolvedValue(undefined);
    dependencies.create.mockRejectedValueOnce(new Error('seed unavailable')).mockResolvedValueOnce(app);
    await expect(initializeApplication(opts)).resolves.toBe(app);
    expect(dependencies.create).toHaveBeenCalledTimes(2);
    const fallback = dependencies.create.mock.calls[1][0] as AppCreateOpts;
    expect(fallback).toEqual({ ...opts, initialState: { ...originalState, map: 'regular-main-branch' } });
    expect(fallback.mountTo).toBe(opts.mountTo);
    expect(fallback.overlayButtons).toBe(opts.overlayButtons);
    expect(opts.initialState).toEqual(originalState);
    expect(fallback.initialState).not.toBe(opts.initialState);
  });

  it('propagates a failed fallback instead of retrying indefinitely', async () => {
    const failure = new Error('tiles unavailable');
    dependencies.translations.mockResolvedValue(undefined);
    dependencies.create.mockRejectedValue(failure);
    await expect(initializeApplication(options())).rejects.toBe(failure);
    expect(dependencies.create).toHaveBeenCalledTimes(2);
  });
});
