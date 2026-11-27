// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { encodeReplayFrames, playbackSteps, publicClueReplay, type ReplayFrame } from '../src/guessr/clue-replay';
import { decodeMapFrames, encodeMapFrames, mapPose, mapView, MAP_PACKET_LIMIT } from '../src/guessr/guess-map-replay';
import { GuessMapOutbox } from '../src/guessr/guess-map-outbox';
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

it('keeps both camera clocks ordered within a public second and preserves a deeply zoomed portrait view', () => {
  const world = {x:-17920,y:-31744,width:36352,height:73728}, visible = {x:304.25,y:-2048.5,width:15,height:29};
  const pose = mapPose(visible,world), restored = mapView(pose,world);
  for (const key of ['x','y','width','height'] as const) expect(Math.abs(restored[key]-visible[key])).toBeLessThan(.006);
  const maps = encodeMapFrames([{at:2501,action:'map-pan',map:pose},{at:2540,action:'map-zoom-in',map:pose}],0);
  expect(maps).toHaveLength(40);
  const replay = publicClueReplay({}, {track:encodeReplayFrames([[2500,0,0,0],[2525,24,0,0,'right']],0),
    opens:2500,guesses:[[2540,35,40,0]],maps})!;
  expect(replay.steps).toHaveLength(3);
  expect(playbackSteps(replay).map(s=>s.action)).toEqual(['view','map-pan','right','map-zoom-in','submit']);
  expect(playbackSteps(replay).every(s=>s.second===0)).toBe(true);
  expect(JSON.stringify(replay)).not.toContain('2540');
});

it('bounds an unsent movement burst and restores only unacknowledged movement on reconnect', () => {
  const pose = {x:1000,y:2000,w:33000,h:32700};
  const old = new GuessMapOutbox('map');
  for (let i=0;i<MAP_PACKET_LIMIT+20;i++) old.record('round',{...pose,x:1000+i},'map-pan',start+i);
  const next = new GuessMapOutbox('map');
  const payload = next.attach('round','guess')!;
  expect(payload.partial).toBe(true);
  const frames=decodeMapFrames(payload.data,payload.base,MAP_PACKET_LIMIT);
  expect(frames[0].map.x).toBe(1000);
  expect(frames.at(-1)?.map.x).toBe(1000+MAP_PACKET_LIMIT+19);
  expect(next.attach('round','clue')).toBeUndefined();
  next.reconnect();expect(next.attach('round','retry')).toEqual(payload);
  next.acknowledge('retry',true);
  expect(new GuessMapOutbox('map').attach('round','again')).toBeUndefined();
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
