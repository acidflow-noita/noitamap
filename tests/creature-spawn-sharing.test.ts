import { describe, expect, it, vi } from 'vitest';
import { createCreatureSpawnSharing, type SpawnShareNotice } from '../src/creature-spawn-sharing';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

async function settle() {
  // Drain the load/result/error/finalization microtasks without browser timers.
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

function setup(initialId: string | undefined = 'wizard', frame = true) {
  const pending = deferred<string | null>();
  const hooks = {
    loadSpawn: vi.fn((_id: string): Promise<string | null> => pending.promise),
    apply: vi.fn((_raw: string, _frame: boolean) => true),
    clearFocus: vi.fn(),
    writeRequest: vi.fn((_id?: string) => {}),
    notice: vi.fn((_status: SpawnShareNotice) => {}),
  };
  const sharing = createCreatureSpawnSharing(hooks, initialId, frame);
  return { sharing, hooks, pending };
}

describe('shared creature spawn overlay', () => {
  it.each(['auth-first', 'map-first'])('waits for both authentication and the map: %s', async order => {
    const { sharing, hooks, pending } = setup();
    if (order === 'auth-first') sharing.setEntitled(true);
    else sharing.setMapReady(true);
    expect(hooks.loadSpawn).not.toHaveBeenCalled();
    expect(hooks.apply).not.toHaveBeenCalled();

    if (order === 'auth-first') sharing.setMapReady(true);
    else sharing.setEntitled(true);
    expect(hooks.loadSpawn).toHaveBeenCalledExactlyOnceWith('wizard');
    expect(hooks.apply).not.toHaveBeenCalled();
    pending.resolve('Pyramid, Tower');
    await settle();
    expect(hooks.apply).toHaveBeenCalledExactlyOnceWith('Pyramid, Tower', true);
    expect(hooks.notice).toHaveBeenLastCalledWith(null);
    expect(hooks.writeRequest).not.toHaveBeenCalled();
  });

  it('keeps a free visitor’s request without fetching extended data and activates it after login', async () => {
    const { sharing, hooks, pending } = setup();
    sharing.setEntitled(false);
    sharing.setMapReady(true);
    sharing.setEntitled(false);
    sharing.setMapReady(true);
    expect(hooks.notice).toHaveBeenLastCalledWith('locked');
    expect(hooks.loadSpawn).not.toHaveBeenCalled();
    expect(hooks.apply).not.toHaveBeenCalled();
    expect(hooks.writeRequest).not.toHaveBeenCalled();

    sharing.setEntitled(true);
    expect(hooks.loadSpawn).toHaveBeenCalledExactlyOnceWith('wizard');
    pending.resolve('Tower');
    await settle();
    expect(hooks.apply).toHaveBeenCalledExactlyOnceWith('Tower', true);
    expect(hooks.notice).toHaveBeenLastCalledWith(null);
  });

  it('clears active highlighting synchronously on logout while preserving the request for login', async () => {
    const { sharing, hooks, pending } = setup();
    sharing.setMapReady(true);
    sharing.setEntitled(true);
    pending.resolve('Pyramid');
    await settle();
    expect(hooks.apply).toHaveBeenCalledOnce();
    hooks.clearFocus.mockClear();

    sharing.setEntitled(false);
    expect(hooks.clearFocus).toHaveBeenCalledOnce();
    expect(hooks.notice).toHaveBeenLastCalledWith('locked');
    expect(hooks.writeRequest).not.toHaveBeenCalled();
    expect(hooks.loadSpawn).toHaveBeenCalledOnce();

    sharing.setEntitled(true);
    await settle();
    expect(hooks.loadSpawn).toHaveBeenNthCalledWith(2, 'wizard');
    expect(hooks.apply).toHaveBeenCalledTimes(2);
    expect(hooks.notice).toHaveBeenLastCalledWith(null);
  });

  it('ignores a pre-logout result even after logging in again with a new request in flight', async () => {
    const { sharing, hooks, pending } = setup();
    const next = deferred<string | null>();
    sharing.setMapReady(true);
    sharing.setEntitled(true);
    sharing.setEntitled(false);
    pending.resolve('Old regions');
    await settle();
    expect(hooks.apply).not.toHaveBeenCalled();
    expect(hooks.notice).toHaveBeenLastCalledWith('locked');

    // The old request is also harmless when it finishes after the new login.
    const overlapping = deferred<string | null>();
    hooks.loadSpawn.mockReturnValueOnce(overlapping.promise).mockReturnValueOnce(next.promise);
    sharing.setEntitled(true);
    sharing.setEntitled(false);
    sharing.setEntitled(true);
    overlapping.resolve('Stale regions');
    await settle();
    expect(hooks.apply).not.toHaveBeenCalled();
    next.resolve('Current regions');
    await settle();
    expect(hooks.apply).toHaveBeenCalledExactlyOnceWith('Current regions', true);
    expect(hooks.loadSpawn).toHaveBeenCalledTimes(3);
    expect(hooks.writeRequest).not.toHaveBeenCalled();
  });

  it('dismisses the URL request and invalidates pending failures without reviving the overlay', async () => {
    const { sharing, hooks, pending } = setup();
    sharing.setMapReady(true);
    sharing.setEntitled(true);
    hooks.clearFocus.mockClear();
    sharing.dismiss();
    expect(hooks.clearFocus).toHaveBeenCalledOnce();
    expect(hooks.writeRequest).toHaveBeenCalledExactlyOnceWith();
    expect(hooks.notice).toHaveBeenLastCalledWith(null);
    pending.reject(new Error('Late network failure'));
    await settle();
    expect(hooks.notice).toHaveBeenLastCalledWith(null);
    expect(hooks.apply).not.toHaveBeenCalled();

    sharing.setMapReady(false);
    sharing.setEntitled(false);
    sharing.setEntitled(true);
    sharing.setMapReady(true);
    expect(hooks.loadSpawn).toHaveBeenCalledOnce();
  });

  it('invalidates a pending result during map replacement and waits for the next ready map', async () => {
    const { sharing, hooks, pending } = setup();
    const next = deferred<string | null>();
    sharing.setEntitled(true);
    sharing.setMapReady(true);
    hooks.clearFocus.mockClear();
    sharing.setMapReady(false);
    expect(hooks.clearFocus).toHaveBeenCalledOnce();
    pending.resolve('Old map regions');
    await settle();
    expect(hooks.apply).not.toHaveBeenCalled();
    sharing.setEntitled(true);
    sharing.setMapReady(false);
    expect(hooks.loadSpawn).toHaveBeenCalledOnce();

    hooks.loadSpawn.mockReturnValueOnce(next.promise);
    sharing.setMapReady(true);
    expect(hooks.loadSpawn).toHaveBeenNthCalledWith(2, 'wizard');
    next.resolve('New map regions');
    await settle();
    expect(hooks.apply).toHaveBeenCalledExactlyOnceWith('New map regions', true);
    expect(hooks.writeRequest).not.toHaveBeenCalled();
  });

  it('lets an explicit card action supersede a pending shared request and preserves its camera on restoration', async () => {
    const { sharing, hooks, pending } = setup();
    sharing.setMapReady(true);
    sharing.setEntitled(true);
    hooks.clearFocus.mockClear();
    expect(sharing.rememberApplied('new_creature')).toBe(true);
    expect(hooks.writeRequest).toHaveBeenCalledExactlyOnceWith('new_creature');
    expect(hooks.clearFocus).not.toHaveBeenCalled();
    pending.resolve('Old creature regions');
    await settle();
    expect(hooks.apply).not.toHaveBeenCalled();
    sharing.setMapReady(true);
    sharing.setEntitled(true);
    expect(hooks.loadSpawn).toHaveBeenCalledOnce();

    hooks.loadSpawn.mockResolvedValueOnce('New creature regions');
    sharing.setMapReady(false);
    sharing.setMapReady(true);
    await settle();
    expect(hooks.loadSpawn).toHaveBeenNthCalledWith(2, 'new_creature');
    expect(hooks.apply).toHaveBeenCalledExactlyOnceWith('New creature regions', false);
  });

  it.each(['missing-data', 'unavailable-geometry', 'load-failure'])('reports unavailable when restoration has %s', async reason => {
    const { sharing, hooks, pending } = setup();
    if (reason === 'unavailable-geometry') hooks.apply.mockReturnValue(false);
    sharing.setEntitled(true);
    sharing.setMapReady(true);
    if (reason === 'load-failure') pending.reject(new Error('Could not load creature data'));
    else pending.resolve(reason === 'missing-data' ? null : 'Tower');
    await settle();
    expect(hooks.notice).toHaveBeenLastCalledWith('unavailable');
    expect(hooks.apply).toHaveBeenCalledTimes(reason === 'unavailable-geometry' ? 1 : 0);
    expect(hooks.writeRequest).not.toHaveBeenCalled();
    sharing.setEntitled(true);
    sharing.setMapReady(true);
    expect(hooks.loadSpawn).toHaveBeenCalledOnce();
    expect(hooks.notice).toHaveBeenLastCalledWith('unavailable');
  });

  it.each([true, false])('respects frame=%s and does not reapply on duplicate readiness/auth notifications', async frame => {
    const { sharing, hooks, pending } = setup('wizard', frame);
    sharing.setEntitled(true);
    sharing.setMapReady(true);
    sharing.setEntitled(true);
    sharing.setMapReady(true);
    expect(hooks.loadSpawn).toHaveBeenCalledOnce();
    pending.resolve('Pyramid');
    await settle();
    sharing.setEntitled(true);
    sharing.setMapReady(true);
    expect(hooks.loadSpawn).toHaveBeenCalledOnce();
    expect(hooks.apply).toHaveBeenCalledExactlyOnceWith('Pyramid', frame);
  });
});
