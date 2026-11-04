// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { StreamResultArchive, type ArchivedStreamResult, type ResultArchiveStore } from '../src/guessr/stream-result-archive';
import { StreamService } from '../src/guessr/stream-server';
import { newStreamGame, closeStreamRound, revealStreamRound, advanceStreamRound, streamResult } from '../src/guessr/stream-state';
import { STREAM_SESSION_KEY } from '../src/guessr/stream-types';
import { streamSource, streamHost, streamSecret, streamNow, streamAnswer } from './helpers/guessr-stream';

beforeEach(() => {
  const data = new Map<string, string>();
  vi.stubGlobal('localStorage', { get length() { return data.size; }, key: (i: number) => [...data.keys()][i] ?? null,
    getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => data.set(key, value),
    removeItem: (key: string) => data.delete(key) });
});
afterEach(() => vi.unstubAllGlobals());
async function completed() {
  const service = new StreamService(streamSource(), streamSecret);
  const game = newStreamGame(await service.start(streamHost, streamNow), streamNow);
  for (const round of game.session.rounds) {
    closeStreamRound(game, streamAnswer, streamNow + 1);
    revealStreamRound(game, await service.reveal(round.token, streamHost, streamNow + 2));
    advanceStreamRound(game, streamNow + 3);
  }
  return game;
}
function store(): ResultArchiveStore {
  const rows = new Map<string, ArchivedStreamResult>();
  return { get: async id => rows.get(id), all: async () => [...rows.values()], put: async entry => { rows.set(entry.result.id, structuredClone(entry)); } };
}
it('retains every pending publication after a newer game replaces the active session and the page reloads', async () => {
  const database = store(), archive = new StreamResultArchive(() => localStorage, () => database);
  const first = await completed(), second = await completed();
  await archive.save({ result: streamResult(first), published: false, pendingToken: first.session.token });
  localStorage.setItem(STREAM_SESSION_KEY, JSON.stringify(second));
  const reloaded = new StreamResultArchive(() => localStorage, () => database);
  expect((await reloaded.list()).map(entry => entry.result.id).sort()).toEqual([first.session.id, second.session.id].sort());
  const pending = await reloaded.get(first.session.id);
  expect(pending?.pendingToken).toBe(first.session.token);
  expect(JSON.stringify(pending?.result)).not.toContain(first.session.token);
  await reloaded.save({ result: pending!.result, published: true });
  // A stale cache import cannot put credentials back after successful publication.
  await reloaded.save({ result: pending!.result, published: false, pendingToken: first.session.token });
  expect(await reloaded.get(first.session.id)).toEqual({ result: pending!.result, published: true });
});
it('imports old result caches and removes them only after durable storage succeeds', async () => {
  const game = await completed(), result = streamResult(game), database = store();
  const key = 'noitamap-guessr-result:' + result.id;
  localStorage.setItem(key, JSON.stringify(result));
  const put = vi.spyOn(database, 'put').mockRejectedValueOnce(new Error('Blocked'));
  const archive = new StreamResultArchive(() => localStorage, () => database);
  expect((await archive.list())[0].result).toEqual(result);
  expect(localStorage.getItem(key)).not.toBeNull();
  put.mockRestore(); await archive.save({ result, published: true });
  expect(localStorage.getItem(key)).toBeNull();
  expect((await archive.get(result.id))?.published).toBe(true);
});
it('reports storage failure rather than claiming an unsaved result is safe', async () => {
  const result = streamResult(await completed());
  const archive = new StreamResultArchive(() => { throw new Error('Storage denied'); }, () => { throw new Error('IndexedDB denied'); });
  await expect(archive.save({ result, published: false, pendingToken: 'private' })).rejects.toThrow('Download a copy before closing');
});
