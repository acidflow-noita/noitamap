import type { AreaDefinition } from "../../src/guessr/area-rules";
import type { StreamRoundSource } from "../../src/guessr/stream-server";
import { liveRoomView, startLiveRoom, transitionLiveRoom, type LiveRoomState, type LiveRoomAction } from "../../src/guessr/live-room-core";
import type { LiveRoomNamespace } from "../../src/guessr/live-room-types";
export const streamNow = Date.UTC(2026, 9, 18, 12);
export const streamSecret =
  "local-only-stream-key-not-a-real-production-secret";
export const streamHost = {
  sub: "account:fixture",
  name: "Streamer",
  twitchUserId: "100",
  twitchLogin: "streamer",
};
export const streamArea: AreaDefinition = {
  id: "secret-place",
  label: "Private place",
  originY: 0,
  runs: [
    [0, 0, 4],
    [1, 0, 4],
  ],
  cells: 8,
  bounds: { x: -17920, y: 0, width: 2048, height: 1024 },
  difficultyTier: "normal",
  scoring: { area: 1000, position: 4000, maximum: 5000 },
};
export const streamAnswer = { x: -17000, y: 500 };
export function streamSource(): StreamRoundSource {
  return {
    config() {
      return {
        version: "stream-test-v1",
        bounds: streamArea.bounds!,
        overview: "",
        map: {
          width: 2048,
          height: 1024,
          tileSize: 512,
          overlap: 2,
          maxLevel: 11,
          tiles: "/reference/",
        },
      };
    },
    async sampleRounds(count) {
      return Array.from({ length: count }, () => ({
        area: streamArea,
        answer: streamAnswer,
        frames: [
          {
            image: "/images/" + "a".repeat(32) + ".webp",
            x: -900,
            y: -450,
            width: 1800,
            height: 900,
          },
        ],
      }));
    },
  };
}

export function memoryLiveRooms(now: number): LiveRoomNamespace {
  const states = new Map<string, LiveRoomState>();
  return {
    getByName(channel) {
      const update = (owner: string, gameId: string, action: LiveRoomAction) => {
        const next = transitionLiveRoom(states.get(channel) ?? null, owner, gameId, action, now);
        states.set(channel, next);
        return Promise.resolve(liveRoomView(next, channel, now));
      };
      return {
        start: async (owner, game) => {
          const next = startLiveRoom(states.get(channel) ?? null, owner, game, now);
          states.set(channel, next); return liveRoomView(next, channel, now);
        },
        reveal: (owner, game, roundId, outcome) => update(owner, game, { type: 'reveal', roundId, outcome }),
        advance: (owner, game, roundId) => update(owner, game, { type: 'advance', roundId }),
        pulse: (owner, game, hostProVerifiedUntil) => update(owner, game, { type: 'pulse', hostProVerifiedUntil }),
        pause: (owner, game, paused) => update(owner, game, { type: 'pause', paused }),
        quit: (owner, game) => update(owner, game, { type: 'quit' }),
        publish: (owner, game, result) => update(owner, game, { type: 'publish', result }),
        fetch: async () => new Response('Use a real Workers runtime for socket tests.', { status: 426 }),
      };
    },
  };
}
