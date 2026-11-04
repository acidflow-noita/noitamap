import { afterEach, expect, it, vi } from 'vitest';
import { withProgress } from '../build_scripts/guessr/progress.mts';
afterEach(() => vi.useRealTimers());
it('reports useful counts, throughput, elapsed time and ETA during a long stage', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'performance'] });
  const log = vi.fn(); let advance!: (count?: number) => void, finish!: () => void;
  const work = withProgress('Compositing reference tiles', 100, async progress => {
    advance = progress.advance; await new Promise<void>(resolve => { finish = resolve; }); return 'done';
  }, { log, unit: 'tiles', details: () => 'background: 15 cached, 10 downloaded' });
  expect(log.mock.calls[0][0]).toContain('0/100 tiles');
  advance(25); await vi.advanceTimersByTimeAsync(5000);
  const line = log.mock.calls.at(-1)![0];
  for (const detail of ['25/100 tiles', '25.0%', '5.0s elapsed', '5.0 tiles/s', 'ETA 15s', '15 cached, 10 downloaded', 'RSS']) expect(line).toContain(detail);
  await vi.advanceTimersByTimeAsync(15000);
  expect(log.mock.calls.at(-1)![0]).toContain('20s since last completed item');
  advance(75); finish(); expect(await work).toBe('done');
  expect(log.mock.calls.at(-1)![0]).toContain('complete, 100/100 tiles');
  expect(vi.getTimerCount()).toBe(0);
});
it('reports and cleans up a failed stage without exposing the exception contents', async () => {
  vi.useFakeTimers(); const log = vi.fn();
  await expect(withProgress('Uploading', null, async () => { throw new Error('private payload'); }, { log })).rejects.toThrow('private payload');
  expect(log.mock.calls.at(-1)![0]).toContain('failed');
  expect(log.mock.calls.flat().join('')).not.toContain('private payload');
  expect(vi.getTimerCount()).toBe(0);
});
