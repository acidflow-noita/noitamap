import { describe, expect, it } from 'vitest';
import {
  expireLiveRoom, LIVE_ROOM_HOST_TIMEOUT_MS, liveRoomErrorStatus, liveRoomView,
  nextLiveRoomAlarm, startLiveRoom, transitionLiveRoom,
} from '../src/guessr/live-room-core';
import type { LiveRoomGame } from '../src/guessr/live-room-types';
import type { StreamPublishedResult, StreamRoundOutcome } from '../src/guessr/stream-types';

const now = 1_800_000_000_000;
const game: LiveRoomGame = {
  channel: 'wuote', hostId: '100', gameId: 'game_1', expiresAt: now + 86_400_000,
  rounds: Array.from({ length: 10 }, (_, index) => ({ id: `r${index + 1}`, clue: `private_clue_${index + 1}` })),
};
const start = () => startLiveRoom(null, 'host', game, now);
const outcome = (roundId = 'r1'): StreamRoundOutcome => ({
  roundId, answer: { x: 10, y: 20 }, label: 'The Mines', difficultyTier: 'normal',
  players: [{ id: '100', guess: { x: 10, y: 20 }, score: 4600, areaScore: 920, positionScore: 3680, distance: 0 }],
});
const result = (): StreamPublishedResult => ({
  schema: 1, format: 'compact-scores-v1', id: game.gameId, version: 'fixture', createdAt: now, finishedAt: now + 1,
  host: { id: '100', login: game.channel, name: 'Host' },
  rounds: game.rounds.map(round => ({ id: round.id, answer: { x: 10, y: 20 }, name: 'The Mines', difficultyTier: 'normal' })),
  players: [{ id: '100', login: game.channel, name: 'Host', score: 46000, rank: 1,
    rounds: game.rounds.map(() => [920, 3680]) }],
});

describe('live room protocol', () => {
  it('quits once without exposing clues and rejects stale operations and unauthorised retries', () => {
    let state = start();
    expect(() => transitionLiveRoom(state, 'other', game.gameId, { type: 'quit' }, now)).toThrow('[room:403]');
    state = transitionLiveRoom(state, 'host', game.gameId, { type: 'reveal', roundId: 'r1', outcome: outcome() }, now);
    state = transitionLiveRoom(state, 'host', game.gameId, { type: 'quit' }, now);
    expect(liveRoomView(state, game.channel, now)).toMatchObject({ phase: 'waiting', clue: null, gameId: null, online: false });
    expect(state.game.rounds).toEqual([]);
    expect(state.outcome).toBeUndefined();
    expect(state.result).toBeUndefined();
    expect(nextLiveRoomAlarm(state, now)).toBeNull();
    expect(transitionLiveRoom(state, 'host', game.gameId, { type: 'quit' }, now + 1)).toBe(state);
    expect(() => transitionLiveRoom(state, 'other', game.gameId, { type: 'quit' }, now)).toThrow('[room:403]');
    for (const action of [{ type: 'pulse' }, { type: 'advance', roundId: 'r1' }, { type: 'reveal', roundId: 'r1' }] as const)
      expect(() => transitionLiveRoom(state, 'host', game.gameId, action, now)).toThrow('[room:410]');
    expect(() => startLiveRoom(state, 'host', game, now)).toThrow('[room:410]');
    const next = startLiveRoom(state, 'host', { ...game, gameId: 'new-game' }, now);
    expect(() => transitionLiveRoom(next, 'host', game.gameId, { type: 'quit' }, now)).toThrow('[room:409]');
  });

  it('publishes Pro only from unexpired proof and renews it without broadcasting every host pulse', () => {
    expect(liveRoomView(start(), 'wuote', now).hostPro).toBe('unknown');
    const local = startLiveRoom(null, 'local', { ...game, hostId: '900000000' }, now);
    expect(liveRoomView(local, 'wuote', now).hostPro).toBe('unknown');
    const provedGame = { ...game, hostProVerifiedUntil: now + 1_200_000 };
    let state = startLiveRoom(null, 'host', provedGame, now);
    expect(liveRoomView(state, 'wuote', now)).toMatchObject({ hostPro: 'active', hostProVerifiedUntil: provedGame.hostProVerifiedUntil });
    const initialRevision = state.revision;
    for (let minute = 1; minute <= 19; minute++) {
      state = transitionLiveRoom(state, 'host', game.gameId,
        { type: 'pulse', hostProVerifiedUntil: provedGame.hostProVerifiedUntil }, now + minute * 60_000);
      expect(state.revision).toBe(initialRevision);
    }
    const renewalTime = now + 19 * 60_000, renewedProof = renewalTime + 1_200_000;
    state = transitionLiveRoom(state, 'host', game.gameId, { type: 'pulse', hostProVerifiedUntil: renewedProof }, renewalTime);
    expect(state.revision).toBe(initialRevision + 1);
    expect(startLiveRoom(state, 'host', provedGame, renewalTime)).toBe(state);
    expect(state.game.hostProVerifiedUntil).toBe(provedGame.hostProVerifiedUntil);
    expect(nextLiveRoomAlarm(state, renewalTime)).toBe(renewalTime + LIVE_ROOM_HOST_TIMEOUT_MS);
    expect(liveRoomView(state, 'wuote', renewedProof).hostPro).toBe('unknown');
    expect(() => transitionLiveRoom(state, 'host', game.gameId,
      { type: 'pulse', hostProVerifiedUntil: renewedProof + 86_400_000 }, renewalTime)).toThrow('[room:400]');
  });

  it('only exposes the current clue and keeps future rounds private', () => {
    const state = start(), view = liveRoomView(state, 'wuote', now);
    expect(view).toMatchObject({ gameId: 'game_1', hostId: '100', phase: 'guess', round: 1, clue: 'private_clue_1', paused: false });
    const wire = JSON.stringify(view);
    expect(wire).not.toContain('private_clue_2');
    expect(wire).not.toContain('ownerId');
    expect(wire).not.toContain('"rounds"');
    expect(state.game.rounds).not.toBe(game.rounds);
  });

  it('closes before revealing and retries cannot advance twice or reopen a round', () => {
    let state = start();
    expect(() => transitionLiveRoom(state, 'host', game.gameId, { type: 'advance', roundId: 'r1' }, now)).toThrow();
    state = transitionLiveRoom(state, 'host', game.gameId, { type: 'reveal', roundId: 'r1' }, now);
    expect(liveRoomView(state, 'wuote', now).phase).toBe('reveal');
    expect(transitionLiveRoom(state, 'host', game.gameId, { type: 'reveal', roundId: 'r1' }, now)).toBe(state);
    state = transitionLiveRoom(state, 'host', game.gameId, { type: 'advance', roundId: 'r1' }, now);
    expect(state.index).toBe(1);
    expect(transitionLiveRoom(state, 'host', game.gameId, { type: 'advance', roundId: 'r1' }, now)).toBe(state);
    expect(() => transitionLiveRoom(state, 'host', game.gameId, { type: 'reveal', roundId: 'r1' }, now)).toThrow();
    expect(startLiveRoom(state, 'host', game, now)).toBe(state);
  });

  it('publishes only the closed round outcome, freezes its first roster, and clears it on advance', () => {
    const first = outcome();
    let state = start();
    expect(liveRoomView({ ...state, outcome: first }, 'wuote', now).outcome).toBeUndefined();
    state = transitionLiveRoom(state, 'host', game.gameId, { type: 'reveal', roundId: 'r1', outcome: first }, now);
    first.players[0].score = 1;
    expect(liveRoomView(state, 'wuote', now).outcome!.players[0].score).toBe(4600);
    const replacement = { ...outcome(), players: [] };
    const retried = transitionLiveRoom(state, 'host', game.gameId, { type: 'reveal', roundId: 'r1', outcome: replacement }, now);
    expect(retried).toBe(state);
    state = transitionLiveRoom(state, 'host', game.gameId, { type: 'advance', roundId: 'r1' }, now);
    expect(state.outcome).toBeUndefined();
    expect(liveRoomView(state, 'wuote', now).outcome).toBeUndefined();
  });

  it('includes complete standings once, without accepting replacement scores or rewriting completed pulses', () => {
    let state = start();
    expect(() => transitionLiveRoom(state, 'host', game.gameId, { type: 'publish', result: result() }, now)).toThrow();
    expect(liveRoomView({ ...state, result: result() }, 'wuote', now).result).toBeUndefined();
    for (const round of game.rounds) {
      state = transitionLiveRoom(state, 'host', game.gameId, { type: 'reveal', roundId: round.id, outcome: outcome(round.id) }, now);
      state = transitionLiveRoom(state, 'host', game.gameId, { type: 'advance', roundId: round.id }, now);
    }
    const published = result();
    state = transitionLiveRoom(state, 'host', game.gameId, { type: 'publish', result: published }, now);
    published.players[0].name = 'Changed';
    const view = liveRoomView(state, 'wuote', now);
    expect(view.result!.players[0]).toMatchObject({ name: 'Host', score: 46000, rank: 1 });
    expect(() => transitionLiveRoom(state, 'host', game.gameId, { type: 'quit' }, now)).toThrow('Completed games cannot be quit.');
    expect(liveRoomView(state, 'wuote', now).result).toBe(view.result);
    expect(view.outcome!.roundId).toBe('r10');
    expect(transitionLiveRoom(state, 'host', game.gameId, { type: 'publish', result: published }, now)).toBe(state);
    expect(transitionLiveRoom(state, 'host', game.gameId, { type: 'pulse' }, now + 60_000)).toBe(state);
    const expired = expireLiveRoom(state, game.expiresAt)!;
    expect(expired.result).toBeUndefined();
    expect(expired.outcome).toBeUndefined();
  });

  it('rejects wrong owners, replaced games, and expired sessions', () => {
    const state = start();
    expect(() => transitionLiveRoom(state, 'attacker', game.gameId, { type: 'pulse' }, now)).toThrow('[room:403]');
    expect(() => startLiveRoom(state, 'attacker', { ...game, gameId: 'game_2' }, now)).toThrow('[room:403]');
    expect(() => transitionLiveRoom(state, 'host', 'game_2', { type: 'pulse' }, now)).toThrow('[room:409]');
    expect(() => transitionLiveRoom(state, 'host', game.gameId, { type: 'pulse' }, game.expiresAt)).toThrow('[room:410]');
    expect(liveRoomErrorStatus(new Error('[room:409] This game is no longer active.'))).toBe(409);
  });

  it('pauses without closing and recovers host presence without viewer requests', () => {
    let state = transitionLiveRoom(start(), 'host', game.gameId, { type: 'pause', paused: true }, now);
    expect(liveRoomView(state, 'wuote', now)).toMatchObject({ paused: true, online: true, phase: 'guess' });
    expect(nextLiveRoomAlarm(state, now)).toBe(now + LIVE_ROOM_HOST_TIMEOUT_MS);
    state = expireLiveRoom(state, now + LIVE_ROOM_HOST_TIMEOUT_MS)!;
    expect(liveRoomView(state, 'wuote', now + LIVE_ROOM_HOST_TIMEOUT_MS)).toMatchObject({ online: false, paused: true });
    expect(nextLiveRoomAlarm(state, now + LIVE_ROOM_HOST_TIMEOUT_MS)).toBe(game.expiresAt);
    state = transitionLiveRoom(state, 'host', game.gameId, { type: 'pulse' }, now + LIVE_ROOM_HOST_TIMEOUT_MS + 1);
    expect(state).toMatchObject({ online: true, paused: true });
    state = transitionLiveRoom(state, 'host', game.gameId, { type: 'pause', paused: false }, now + LIVE_ROOM_HOST_TIMEOUT_MS + 2);
    expect(state.paused).toBe(false);
  });

  it('clears expired clues and marks complete only after the last closed round', () => {
    let state = start();
    for (const round of game.rounds) {
      state = transitionLiveRoom(state, 'host', game.gameId, { type: 'reveal', roundId: round.id }, now);
      state = transitionLiveRoom(state, 'host', game.gameId, { type: 'advance', roundId: round.id }, now);
    }
    expect(state.phase).toBe('complete');
    state = transitionLiveRoom(state, 'host', game.gameId, { type: 'publish' }, now);
    expect(liveRoomView(state, 'wuote', now).resultId).toBe(game.gameId);
    state = expireLiveRoom(state, game.expiresAt)!;
    expect(state.game.rounds).toEqual([]);
    expect(liveRoomView(state, 'wuote', game.expiresAt)).toMatchObject({ phase: 'waiting', clue: null, gameId: null });
    expect(nextLiveRoomAlarm(state, game.expiresAt)).toBeNull();
  });
});
