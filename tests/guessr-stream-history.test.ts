// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { streamHistorySection } from '../src/guessr/stream-history';
import { readPublishedStreamVisits, rememberPublishedStream } from '../src/guessr/stream-history-records';
import { StreamResultArchive, type ArchivedStreamResult } from '../src/guessr/stream-result-archive';
const request = vi.hoisted(() => vi.fn());
vi.mock('../src/guessr/stream-api', () => ({ StreamApi: class { history = request; } }));
const id = '11111111-1111-4111-8111-111111111111';
beforeEach(() => {
  request.mockReset();
  const data = new Map<string, string>();
  vi.stubGlobal('localStorage', { get length() { return data.size; }, key: (i: number) => [...data.keys()][i] ?? null,
    getItem: (key: string) => data.get(key) ?? null, setItem: vi.fn((key: string, value: string) => data.set(key, value)),
    removeItem: (key: string) => data.delete(key) });
});
afterEach(() => { document.body.replaceChildren(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it('shows numeric placement and score for the host or any selected player with no extra requests', async () => {
  vi.spyOn(StreamResultArchive.prototype, 'list').mockResolvedValue([]);
  request.mockResolvedValue({ games: [
    { id, finishedAt: 2, hostName: 'WUOTE', players: 3, summary: { hostId: '1', maximum: 25000,
      standings: [['1', 'WUOTE', 1, 23000], ['2', 'Chatter', 1, 23000], ['3', 'Other', 3, 19000]] } },
    { id: '22222222-2222-4222-8222-222222222222', finishedAt: 1, hostName: 'WUOTE', players: 2,
      summary: { hostId: '1', maximum: 15000, standings: [['1', 'WUOTE', 2, 10000], ['3', 'Other', 1, 12000]] } },
  ] });
  const main = document.createElement('main'); document.body.append(main);
  const dispose = await streamHistorySection(main, 'wuote');
  const rows = () => [...main.querySelectorAll<HTMLTableRowElement>('tbody tr')];
  expect(rows()[0].cells[1].textContent).toBe('1 / 3');
  expect(rows()[0].cells[2].textContent).toBe('23,000 / 25,000');
  expect(rows()[1].cells[1].textContent).toBe('2 / 2');
  const select = main.querySelector('[role="combobox"]')!;
  select.dispatchEvent(Object.assign(new Event('change.bs.combobox'), { value: '2' }));
  expect(rows()[0].cells[1].textContent).toBe('1 / 3');
  expect(rows()[0].cells[2].textContent).toBe('23,000 / 25,000');
  expect(rows()[1].cells[1].textContent).toBe('This player did not join the game.');
  expect(rows()[1].cells[1].colSpan).toBe(2);
  select.dispatchEvent(Object.assign(new Event('change.bs.combobox'), { value: '3' }));
  expect(rows()[0].cells[1].textContent).toBe('3 / 3');
  expect(rows()[1].cells[2].textContent).toBe('12,000 / 15,000');
  expect(request).toHaveBeenCalledOnce(); dispose();
});
it('lists a chatter’s confirmed game link after refresh without fetching every result', async () => {
  rememberPublishedStream(id, 'wuote'); rememberPublishedStream(id, 'wuote');
  expect(localStorage.setItem).toHaveBeenCalledOnce();
  expect(readPublishedStreamVisits()).toHaveLength(1);
  const main = document.createElement('main'); document.body.append(main);
  await streamHistorySection(main);
  expect(main.querySelector('tbody tr')).not.toBeNull();
  expect(main.querySelector<HTMLAnchorElement>('a[href$="/guess/wuote/"]')).not.toBeNull();
  expect(main.querySelector<HTMLAnchorElement>(`a[href$="/guess/results/${id}/"]`)).not.toBeNull();
  expect(request).not.toHaveBeenCalled();
});
function pendingResult(gameId = id, channel = 'wuote'): ArchivedStreamResult {
  return { published: false, pendingToken: 'local-only-retry-token', result: { schema: 1, id: gameId,
    version: 'fixture', createdAt: 1, finishedAt: 2, host: { id: '1', login: channel, name: channel.toUpperCase() },
    rounds: Array.from({ length: 10 }, (_, n) => ({ id: String(n), answer: { x: 0, y: 0 }, name: 'Fixture', difficultyTier: 'normal' })),
    players: [{ id: '1', login: channel, name: channel.toUpperCase(), score: 0, rank: 1,
      rounds: Array.from({ length: 10 }, () => ({ score: 0, areaScore: 0, positionScore: 0 })) }] } };
}
it('uses the saved Twitch identity for a legacy Patron-labelled local history entry', async () => {
  const entry = pendingResult(); entry.result.host.name = 'Patron'; entry.result.players[0].name = 'Patron';
  vi.spyOn(StreamResultArchive.prototype, 'list').mockResolvedValue([entry]);
  const main = document.createElement('main'); document.body.append(main);
  await streamHistorySection(main);
  expect(main.querySelector('a[href$="/guess/wuote/"]')!.textContent).toBe('wuote');
  expect(entry.result.host.name).toBe('Patron');
  expect(request).not.toHaveBeenCalled();
});
it('keeps unpublished channel games accessible and deduplicates them once publication is confirmed', async () => {
  vi.spyOn(StreamResultArchive.prototype, 'list').mockResolvedValue([pendingResult(), pendingResult('33333333-3333-4333-8333-333333333333', 'other')]);
  const save = vi.spyOn(StreamResultArchive.prototype, 'save').mockResolvedValue();
  request.mockResolvedValueOnce({ games: [], next: 'next' }).mockResolvedValueOnce({ games: [{ id, finishedAt: 2, hostName: 'WUOTE', players: 1 }] });
  const main = document.createElement('main'); document.body.append(main);
  await streamHistorySection(main, 'wuote');
  expect(main.querySelectorAll('[data-game-id]')).toHaveLength(1);
  expect(main.textContent).toContain('Retry publishing'); expect(main.textContent).not.toContain('OTHER');
  expect(main.innerHTML).not.toContain('local-only-retry-token');
  main.querySelector<HTMLButtonElement>('.stream-history-more')!.click();
  await vi.waitFor(() => expect(main.textContent).toContain('View results'));
  expect(main.querySelectorAll('[data-game-id]')).toHaveLength(1);
  expect(main.textContent).not.toContain('Not published yet');
  expect(save).toHaveBeenCalledWith(expect.objectContaining({ published: true }));
  expect(save.mock.calls[0][0].pendingToken).toBeUndefined();
  expect(request).toHaveBeenCalledTimes(2);
  const count = main.querySelector('tbody .numeric')!;
  expect(count.textContent).toBe('—'); expect(main.querySelector('tbody time')).not.toBeNull();
});
it('bounds local history rows and only reveals more when requested, without API calls', async () => {
  const entries = Array.from({ length: 25 }, (_, n) => pendingResult(n.toString(16).padStart(8, '0') + '-1111-4111-8111-111111111111'));
  vi.spyOn(StreamResultArchive.prototype, 'list').mockResolvedValue(entries);
  const main = document.createElement('main'); document.body.append(main);
  await streamHistorySection(main);
  expect(main.querySelectorAll('[data-game-id]')).toHaveLength(20);
  main.querySelector<HTMLButtonElement>('.stream-history-more')!.click();
  expect(main.querySelectorAll('[data-game-id]')).toHaveLength(25); expect(request).not.toHaveBeenCalled();
});
it('shows a retriable history failure, then makes recovered rows visible and paginates only on click', async () => {
  request.mockRejectedValueOnce(new Error('Offline'))
    .mockResolvedValueOnce({ games: [{ id, hostName: 'WUOTE', finishedAt: Date.now(), players: 1000 }], next: 'cursor' })
    .mockResolvedValueOnce({ games: [{ id: '22222222-2222-4222-8222-222222222222', hostName: 'WUOTE', finishedAt: 1, players: 1 }] });
  const main = document.createElement('main'); document.body.append(main);
  await streamHistorySection(main, 'wuote');
  expect(request).toHaveBeenCalledOnce(); expect(main.textContent).toContain('Offline');
  main.querySelector<HTMLButtonElement>('.stream-history-more')!.click();
  await vi.waitFor(() => expect(main.querySelector<HTMLElement>('.table-wrap')!.hidden).toBe(false));
  expect(main.querySelector<HTMLButtonElement>('.stream-history-more')!.textContent).toBe('Load more');
  expect(main.querySelectorAll('tbody tr')).toHaveLength(1);
  main.querySelector<HTMLButtonElement>('.stream-history-more')!.click();
  await vi.waitFor(() => expect(main.querySelectorAll('tbody tr')).toHaveLength(2));
  expect(request).toHaveBeenLastCalledWith('wuote', 'cursor');
  expect(main.querySelector<HTMLButtonElement>('.stream-history-more')!.hidden).toBe(true);
});
