// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { encodeReplayFrames, publicClueReplay, type ReplayFrame } from '../src/guessr/clue-replay';
import { ClueReplayOutbox } from '../src/guessr/clue-replay-outbox';

const start = 1800000000000;
beforeEach(() => {
  vi.useFakeTimers();
  const saved = new Map<string, string>();
  vi.stubGlobal('sessionStorage', {
    getItem: (k: string) => saved.get(k) ?? null,
    setItem: (k: string, v: string) => saved.set(k, v),
    removeItem: (k: string) => saved.delete(k),
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it('round-trips signed offsets, zoom, return-to-start, and the original timing across batches', () => {
  const f: ReplayFrame[] = [
    [start + 3000, 0, 0, 0],
    [start + 3529, -24, 11, 0, 'left'],
    [start + 5555, -24, 11, 1, 'zoom-out'],
    [start + 5585, 0, 0, 0, 'return'],
  ];
  const track = encodeReplayFrames(f.slice(0, 2), start) + encodeReplayFrames(f.slice(2), start);
  const stored = {
    track,
    opens: 3000,
    guesses: [
      [3200, 120, 100, 0],
      [5570, 300, 200, 0],
    ] as import('../src/guessr/clue-replay').StoredGuessStep[],
  };
  const result = publicClueReplay({}, stored)!;
  expect(result.steps.map(step => [step.action, step.second])).toEqual([
    ['view', 0],
    ['submit', 0],
    ['left', 0],
    ['zoom-out', 2],
    ['update', 2],
    ['return', 2],
  ]);
  expect(result).not.toHaveProperty('track');
  expect(() => publicClueReplay({}, { ...stored, track: track + track })).toThrow();
});

it('sends the first view once, batches real changes, and sends nothing while idle', () => {
  const send = vi.fn(() => true),
    out = new ClueReplayOutbox('game', send);
  const first = { dx: 0, dy: 0, level: 0 };
  out.record('round', first, start);
  out.record('round', first, start + 5);
  expect(send).toHaveBeenCalledTimes(1);
  out.record('round', { dx: -24, dy: 0, level: 0 }, start + 30);
  out.record('round', { dx: -24, dy: 0, level: 1 }, start + 50);
  vi.advanceTimersByTime(1500);
  expect(send).toHaveBeenLastCalledWith({
    type: 'clue-frames',
    roundId: 'round',
    frames: [
      [start + 30, -24, 0, 0],
      [start + 50, -24, 0, 1],
    ],
  });
  out.acknowledge('round', start + 50);
  vi.advanceTimersByTime(90000);
  out.reconnect();
  expect(send).toHaveBeenCalledTimes(2);
  out.dispose();
});

it('restores just unacknowledged frames after refresh and flushes the final movement before submit', () => {
  const send = vi.fn(() => true),
    old = new ClueReplayOutbox('game', send);
  old.record('round', { dx: 0, dy: 0, level: 0 }, start);
  old.acknowledge('round', start);
  old.record('round', { dx: 0, dy: 11, level: 0 }, start + 10);
  old.dispose();
  const next = new ClueReplayOutbox('game', send);
  next.reconnect();
  expect(send).toHaveBeenLastCalledWith({ type: 'clue-frames', roundId: 'round', frames: [[start + 10, 0, 11, 0]] });
  next.record('round', { dx: 0, dy: 11, level: 0 }, start + 12);
  next.record('round', { dx: 0, dy: 0, level: 0 }, start + 20);
  next.flush();
  expect(send).toHaveBeenLastCalledWith({ type: 'clue-frames', roundId: 'round', frames: [[start + 20, 0, 0, 0]] });
  next.clear();
  expect(sessionStorage.getItem('game')).toBeNull();
});
