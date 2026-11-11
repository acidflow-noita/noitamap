// @vitest-environment jsdom
import { formatGuessCommand } from '../src/guessr/guess-command';
import {
  expandStreamResult,
  packStreamPublish,
} from "../src/guessr/stream-codec";
import { describe, expect, it, vi } from "vitest";
import { StreamService } from "../src/guessr/stream-server";
import {
  acceptStreamGuess,
  advanceStreamRound,
  closeStreamRound,
  newStreamGame,
  ordinal,
  revealStreamRound,
  reconcileLiveRound,
  streamResult,
  streamStandings,
} from "../src/guessr/stream-state";
import { streamResultHtml } from "../src/guessr/stream-results";
import { changeClue, maximumScore } from "../src/guessr/rules";
import {
  streamAnswer,
  streamArea,
  streamHost,
  streamNow,
  streamSecret,
  streamSource,
} from "./helpers/guessr-stream";
import { STREAM_MAX_PLAYERS } from "../src/guessr/stream-types";
import type { LiveRoomView } from "../src/guessr/live-room-types";

async function fixture() {
  const service = new StreamService(streamSource(), streamSecret);
  const session = await service.start(streamHost, streamNow);
  expect(session.rounds).toHaveLength(10);
  expect(session.rounds.every(round => round.difficultyTier === streamArea.difficultyTier)).toBe(true);
  session.serverNow = streamNow;
  const game = newStreamGame(session, streamNow);
  const chat = (
    id: string,
    text = "!noitaguessr_guess 1 -17000 500",
    sentAt = streamNow + 1,
    messageId = id + "-message",
  ) =>
    acceptStreamGuess(game, {
      player: { id, name: "Viewer " + id, login: "viewer_" + id },
      id: messageId,
      text,
      sentAt,
    });
  return { service, session, game, chat };
}
describe("stream round protocol and scoring", () => {
  it('rejects copied and replayed packets using Twitch sender identity while accepting a fresh replacement', async () => {
    const f = await fixture(); f.session.live = true;
    const roundId = f.session.rounds[0].id;
    const packet = formatGuessCommand(1, streamAnswer, 5000, roundId, { userId: '123' });
    expect(f.chat('123', packet)).toBe('accepted');
    expect(f.chat('124', packet, streamNow + 2, 'copied')).toBe('invalid');
    expect(f.chat('123', packet, streamNow + 3, 'replayed')).toBe('duplicate');
    const replacement = formatGuessCommand(1, { x: streamAnswer.x + 1, y: streamAnswer.y }, 4900, roundId, { userId: '123' });
    expect(f.chat('123', replacement, streamNow + 4, 'replacement')).toBe('accepted');
    expect(f.chat('123', packet, streamNow + 5, 'old-packet-new-message')).toBe('duplicate');
    const restored = JSON.parse(JSON.stringify(f.game));
    expect(acceptStreamGuess(restored, { player: { id: '123', login: 'viewer_123', name: 'Viewer 123' },
      id: 'after-refresh', text: packet, sentAt: streamNow + 6 })).toBe('duplicate');
    expect(f.game.participants).toHaveLength(2);
    expect(f.game.participants[1].guesses[0]).toMatchObject({ point: { x: streamAnswer.x + 1, y: streamAnswer.y }, maximum: 4900 });
  });
  it("recovers a lost advance acknowledgement without reopening the previous round", async () => {
    const f = await fixture();
    closeStreamRound(f.game, streamAnswer, streamNow + 10);
    revealStreamRound(f.game, await f.service.reveal(f.session.rounds[0].token, streamHost, streamNow + 11));
    const room: LiveRoomView = {
      schema: 1, channel: streamHost.twitchLogin, gameId: f.session.id, revision: 3,
      phase: 'guess', online: true, paused: false, round: 2, roundId: f.session.rounds[1].id,
      clue: 'unused', expiresAt: f.session.expiresAt,
    };
    expect(reconcileLiveRound(f.game, room)).toBe(true);
    expect(f.game).toMatchObject({ round: 1, stage: 'guess' });
    expect(reconcileLiveRound(f.game, room)).toBe(false);
    expect(() => reconcileLiveRound(f.game, { ...room, gameId: crypto.randomUUID() })).toThrow(/another active game/);
  });
  it("rejects an old page's Round 1 command during a new game's Round 1", async () => {
    const f = await fixture(), previous = await fixture();
    f.session.live = true;
    expect(f.chat('123')).toBe('old'); // Untagged legacy commands cannot enter live games.
    expect(f.chat('123', `!noitaguessr_guess 1 -17000 500 5000 #${previous.session.rounds[0].id}`)).toBe('old');
    expect(f.chat('123', `!noitaguessr_guess 1 -17000 500 5000 #${f.session.rounds[0].id}`)).toBe('invalid');
    const valid = formatGuessCommand(1, streamAnswer, 5000, f.session.rounds[0].id, { userId: '123' });
    expect(f.chat('123', valid)).toBe('accepted');
    expect(f.chat('124', valid)).toBe('invalid');
    closeStreamRound(f.game, streamAnswer, streamNow + 10);
    expect(f.chat('123', valid, streamNow + 11)).toBe('closed');
    expect(f.game.participants).toHaveLength(2);
  });
  it("withholds every answer and area until a host-owned token is revealed", async () => {
    const f = await fixture(),
      publicText = JSON.stringify(f.session);
    expect(publicText).not.toContain(streamArea.id);
    expect(publicText).not.toContain(streamArea.label);
    expect(publicText).not.toContain('"answer"');
    expect(publicText).not.toContain('"runs"');
    expect(publicText).not.toContain("-17000");
    const token = f.session.rounds[0].token;
    expect(
      await f.service.reveal(token, streamHost, streamNow + 2),
    ).toMatchObject({ answer: streamAnswer, area: streamArea });
    await expect(
      f.service.reveal(
        token,
        { ...streamHost, sub: "account:someone-else" },
        streamNow,
      ),
    ).rejects.toThrow("host");
    await expect(
      f.service.reveal(token.slice(0, -5) + "abcde", streamHost, streamNow),
    ).rejects.toThrow("invalid");
    await expect(
      f.service.reveal(f.session.token, streamHost, streamNow),
    ).rejects.toThrow("host");
    await expect(
      f.service.reveal(token, streamHost, f.session.expiresAt + 1),
    ).rejects.toThrow("expired");
  });
  it("deduplicates by Twitch identity and message, distinguishes future/old/closed rounds", async () => {
    const f = await fixture();
    expect(f.chat("123", "!noitaguessr_guess 2 -17000 500")).toBe("future");
    expect(f.chat("123", "!noitaguessr_guess 1 -17000 500", streamNow - 1)).toBe("old");
    expect(f.chat("123")).toBe("accepted");
    expect(f.chat("123")).toBe("duplicate");
    expect(f.chat("123", "!noitaguessr_guess 1 -16000 500", streamNow + 2, "later")).toBe(
      "accepted",
    );
    expect(f.game.participants).toHaveLength(2);
    expect(f.game.participants[1].guesses[0]?.point).toEqual({
      x: -16000,
      y: 500,
    });
    expect(f.chat("100")).toBe("host");
    closeStreamRound(f.game, streamAnswer, streamNow + 3);
    expect(f.chat("124", "!noitaguessr_guess 1 -17000 500", streamNow + 4)).toBe("closed");
    const submitted = structuredClone(f.game.participants[0].guesses[0]);
    closeStreamRound(f.game, null, streamNow + 5);
    expect(f.game.participants[0].guesses[0]).toEqual(submitted);
    revealStreamRound(
      f.game,
      await f.service.reveal(
        f.session.rounds[0].token,
        streamHost,
        streamNow + 6,
      ),
    );
    advanceStreamRound(f.game, streamNow + 10);
    expect(f.chat("124", "!noitaguessr_guess 1 -17000 500", streamNow + 11)).toBe("old");
    expect(f.chat("124", "!noitaguessr_guess 2 -17000 500", streamNow + 11)).toBe(
      "accepted",
    );
  });
  it("snapshots assistance at acceptance and re-prices later replacements without time bonuses", async () => {
    const f = await fixture();
    f.chat("1");
    changeClue(f.session.rounds[0].clue, f.game.clue, 0, 0, 4);
    const cap = maximumScore(f.game.clue);
    expect(cap).toBeLessThan(5000);
    f.chat("2", undefined, streamNow + 2);
    closeStreamRound(f.game, streamAnswer, streamNow + 3);
    const reveal = await f.service.reveal(
      f.session.rounds[0].token,
      streamHost,
      streamNow + 4,
    );
    revealStreamRound(f.game, reveal);
    const scores = streamStandings(f.game.participants, [reveal]);
    expect(scores.find((p) => p.id === "1")?.score).toBe(5000);
    expect(scores.find((p) => p.id === "2")?.score).toBe(cap);
    expect(scores.find((p) => p.id === "100")?.score).toBe(cap);
    expect(scores.find((p) => p.id === "2")?.rank).toBe(2);
    expect(scores.find((p) => p.id === "100")?.rank).toBe(2);
    const replacement = await fixture();
    replacement.chat("1");
    changeClue(
      replacement.session.rounds[0].clue,
      replacement.game.clue,
      0,
      0,
      4,
    );
    expect(replacement.chat("1", undefined, streamNow + 2, "replacement")).toBe(
      "accepted",
    );
    expect(replacement.game.participants[1].guesses[0]?.maximum).toBe(cap);
  });
  it('honours a chatter’s exploration allowance without raising the shared host ceiling', async () => {
    const f = await fixture();
    expect(f.chat('1', '!noitaguessr_guess 1 -17000 500 4500')).toBe('accepted');
    expect(f.game.participants.find(player => player.id === '1')!.guesses[0]!.maximum).toBe(4500);
    changeClue(f.session.rounds[0].clue, f.game.clue, 0, 0, 4);
    expect(f.chat('2', '!noitaguessr_guess 1 -17000 500 4900')).toBe('accepted');
    expect(f.game.participants.find(player => player.id === '2')!.guesses[0]!.maximum).toBe(maximumScore(f.game.clue));
    expect(f.chat('3', '!noitaguessr_guess 1 -17000 500 5001')).toBe('invalid');
  });
  it('cannot add or replace an old-round guess after its answer has been revealed', async () => {
    const f = await fixture();
    f.chat('1', '!noitaguessr_guess 1 -16000 500');
    closeStreamRound(f.game, streamAnswer, streamNow + 2);
    const before = structuredClone(f.game.participants);
    expect(f.chat('2', '!noitaguessr_guess 1 -17000 500 5000', streamNow + 3)).toBe('closed');
    revealStreamRound(f.game, await f.service.reveal(f.session.rounds[0].token, streamHost, streamNow + 4));
    expect(f.chat('1', '!noitaguessr_guess 1 -17000 500 5000', streamNow + 5, 'after-answer')).toBe('closed');
    expect(f.chat('2', '!noitaguessr_guess 1 -17000 500 5000', streamNow + 6)).toBe('closed');
    expect(f.game.participants).toEqual(before);
    advanceStreamRound(f.game, streamNow + 10);
    expect(f.chat('2', '!noitaguessr_guess 1 -17000 500 5000', streamNow + 11)).toBe('old');
    expect(f.game.participants).toEqual(before);
  });
  it("keeps every local chatter when cloud publication's participant bound is exceeded", async () => {
    const f = await fixture();
    for (let i = 1000; i < 1000 + STREAM_MAX_PLAYERS + 2; i++)
      expect(f.chat(String(i))).toBe("accepted");
    expect(f.game.participants).toHaveLength(STREAM_MAX_PLAYERS + 3);
    const revealed = await f.service.reveal(
      f.session.rounds[0].token,
      streamHost,
      streamNow + 5,
    );
    expect(streamStandings(f.game.participants, [revealed])).toHaveLength(
      STREAM_MAX_PLAYERS + 3,
    );
  });
  it.each([-120000, 120000])(
    "normalizes a browser clock skewed by %i ms before comparing Twitch timestamps or publishing",
    async (skew) => {
      const f = await fixture();
      const game = newStreamGame(f.session, streamNow + skew);
      const clock = vi.spyOn(Date, "now");
      try {
        for (let i = 0; i < game.session.rounds.length; i++) {
          clock.mockReturnValue(streamNow + skew + (i + 1) * 100);
          expect(
            acceptStreamGuess(game, {
              player: { id: "123", login: "viewer", name: "Viewer" },
              id: "message-" + i,
              text: `!noitaguessr_guess ${i + 1} -17000 500`,
              sentAt: streamNow + (i + 1) * 100 - 10,
            }),
          ).toBe("accepted");
          closeStreamRound(game, streamAnswer);
          revealStreamRound(
            game,
            await f.service.reveal(
              f.session.rounds[i].token,
              streamHost,
              streamNow + 1000,
            ),
          );
          advanceStreamRound(game);
        }
        expect(game.finishedAt).toBe(
          streamNow + game.session.rounds.length * 100,
        );
        await expect(
          f.service.result(
            packStreamPublish({
              token: f.session.token,
              finishedAt: game.finishedAt!,
              players: streamResult(game).players,
            }),
            streamHost,
            streamNow + 1000,
          ),
        ).resolves.toBeTruthy();
      } finally {
        clock.mockRestore();
      }
    },
  );
  it("recomputes a bounded final result with no credentials and restores an interrupted close", async () => {
    const f = await fixture();
    f.chat("1");
    for (let i = 0; i < f.session.rounds.length; i++) {
      closeStreamRound(f.game, streamAnswer, streamNow + 10 + i * 10);
      const resumed = JSON.parse(JSON.stringify(f.game));
      expect(resumed.stage).toBe("closing");
      revealStreamRound(
        f.game,
        await f.service.reveal(
          f.session.rounds[i].token,
          streamHost,
          streamNow + 11 + i * 10,
        ),
      );
      advanceStreamRound(f.game, streamNow + 12 + i * 10);
    }
    const local = streamResult(f.game);
    const server = await f.service.result(
      packStreamPublish({
        token: f.session.token,
        finishedAt: f.game.finishedAt!,
        players: streamResult(f.game).players,
      }),
      streamHost,
      streamNow + 100,
    );
    expect(expandStreamResult(server.result)).toEqual(local);
    expect(JSON.stringify(local)).not.toMatch(
      /accessToken|refreshToken|token|account:fixture/,
    );
    expect(local.players.find((p) => p.id === "1")?.rounds[1].score).toBe(0);
    const unsafe = structuredClone(local);
    unsafe.host.name = "</script><script>bad()</script>";
    expect(streamResultHtml(unsafe)).not.toContain(unsafe.host.name);
    expect(streamResultHtml(unsafe)).not.toMatch(/src=["']https?:/);
    expect(ordinal(83)).toBe("83rd");
    expect(ordinal(11)).toBe("11th");
    expect(ordinal(1247)).toBe("1,247th");
  });
});
