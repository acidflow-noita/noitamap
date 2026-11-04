// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { streamHistorySection } from '../src/guessr/stream-history';
import { readPublishedStreamVisits, rememberPublishedStream } from '../src/guessr/stream-history-records';
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
afterEach(() => { document.body.replaceChildren(); vi.unstubAllGlobals(); });
it('lists a chatter’s confirmed game link after refresh without fetching every result', async () => {
  rememberPublishedStream(id, 'wuote'); rememberPublishedStream(id, 'wuote');
  expect(localStorage.setItem).toHaveBeenCalledOnce();
  expect(readPublishedStreamVisits()).toHaveLength(1);
  const main = document.createElement('main'); document.body.append(main);
  await streamHistorySection(main);
  expect(main.querySelector('tbody tr')).not.toBeNull();
  expect(main.querySelector<HTMLAnchorElement>('a[href*="channel=wuote"]')).not.toBeNull();
  expect(main.querySelector<HTMLAnchorElement>(`a[href$="/guess/results/${id}/"]`)).not.toBeNull();
  expect(request).not.toHaveBeenCalled();
});
it('shows a retriable history failure, then makes recovered rows visible and paginates only on click', async () => {
  request.mockRejectedValueOnce(new Error('Offline'))
    .mockResolvedValueOnce({ games: [{ id, hostName: 'WUOTE', finishedAt: Date.now(), players: 1000 }], next: 'cursor' })
    .mockResolvedValueOnce({ games: [{ id: '22222222-2222-4222-8222-222222222222', hostName: 'WUOTE', finishedAt: 1, players: 1 }] });
  const main = document.createElement('main'); document.body.append(main);
  await streamHistorySection(main, 'wuote');
  expect(request).toHaveBeenCalledOnce(); expect(main.textContent).toContain('Offline');
  main.querySelector('button')!.click();
  await vi.waitFor(() => expect(main.querySelector<HTMLElement>('.table-wrap')!.hidden).toBe(false));
  expect(main.querySelector('button')!.textContent).toBe('Load more');
  expect(main.querySelectorAll('tbody tr')).toHaveLength(1);
  main.querySelector('button')!.click();
  await vi.waitFor(() => expect(main.querySelectorAll('tbody tr')).toHaveLength(2));
  expect(request).toHaveBeenLastCalledWith('wuote', 'cursor');
  expect(main.querySelector('button')!.hidden).toBe(true);
});
