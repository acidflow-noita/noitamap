import { describe, expect, it } from "vitest";
import {
  formatGuessCommand,
  parseGuessCommand,
} from "../src/guessr/guess-command";

const limits = {
  rounds: 10,
  bounds: { x: -17920, y: -31744, width: 36352, height: 73728 },
};

describe("shared Twitch guess commands", () => {
  it.each(["-", "--", "‐", "‑", "‒", "–", "—", "―", "−", "﹣", "－"])(
    "accepts %s as a coordinate minus sign without changing the point",
    (sign) => {
      expect(
        parseGuessCommand(`!noitaguessr_guess 2 ${sign}3152 ${sign}874`, limits),
      ).toEqual({ round: 2, x: -3152, y: -874 });
    },
  );
  it.each([" ", "\u00a0", "\u202f", "\t", "\n"])(
    "accepts copied whitespace %j",
    (space) => {
      expect(
        parseGuessCommand(
          ` ${space}!noitaguessr_guess${space}2${space}—${space}3152${space}874${space}`,
          limits,
        ),
      ).toEqual({ round: 2, x: -3152, y: 874 });
    },
  );
  it("encodes the payload while rounding the map pin to native pixels", () => {
    const command = formatGuessCommand(2, { x: -3152.2, y: 874.2 });
    expect(command).toMatch(/^!noitaguessr_guess ✦[^0-9A-Za-z]+✦$/);
    expect(parseGuessCommand(command, limits)).toEqual({
      round: 2,
      x: -3152,
      y: 874,
    });
  });
  it("preserves signs, zero and world-edge positions through copy/paste", () => {
    for (const x of [-17920, -1, 0, 18432])
      for (const y of [-31744, -1, 0, 41984]) {
        const point = { x, y };
        expect(parseGuessCommand(formatGuessCommand(10, point), limits)).toEqual(
          { round: 10, ...point },
        );
      }
    expect(parseGuessCommand("!NOITAGUESSR_GUESS 1 +3152 −0", limits)).toMatchObject({
      round: 1,
      x: 3152,
    });
  });
  it.each([
    '!guess 2 -3152 874',
    '!guessing 2 -3152 874',
    "!noitaguessr_guess 0 -3152 874",
    "!noitaguessr_guess 11 -3152 874",
    "!noitaguessr_guess -2 -3152 874",
    "!noitaguessr_guess 2 +-3152 874",
    "!noitaguessr_guess 2 ---3152 874",
    "!noitaguessr_guess 2 3152–874",
    "!noitaguessr_guess 2 -3,152 874",
    "!noitaguessr_guess 2 1e3 874",
    "!noitaguessr_guess 2 -3152.4 874",
    "!noitaguessr_guess 2 -3152",
    "!noitaguessr_guess 2 -3152 874 extra",
    "!noitaguessr_guess 2 -17921 874",
    "!noitaguessr_guess 2 0 41985",
    "!noitaguessr_guess 2 9007199254740993 0",
    "prefix !noitaguessr_guess 2 0 0",
  ])("rejects invalid or ambiguous input: %s", (text) => {
    expect(parseGuessCommand(text, limits)).toBeNull();
  });
  it("rejects invalid values instead of copying a broken command", () => {
    expect(() => formatGuessCommand(0, { x: 1, y: 1 })).toThrow();
    expect(() => formatGuessCommand(1, { x: NaN, y: 1 })).toThrow();
    expect(parseGuessCommand(null, limits)).toBeNull();
  });
  it('carries a bounded viewer allowance without breaking manual coordinate-only guesses', () => {
    const command = formatGuessCommand(2, { x: 100, y: 200 }, 4500);
    expect(command).not.toContain('4500');
    expect(parseGuessCommand(command, limits)).toEqual({ round: 2, x: 100, y: 200, maximum: 4500 });
    expect(parseGuessCommand('!noitaguessr_guess 2 100 200 5001', limits)).toBeNull();
    expect(parseGuessCommand('!noitaguessr_guess 2 100 200 -1', limits)).toBeNull();
    expect(() => formatGuessCommand(2, { x: 100, y: 200 }, NaN)).toThrow();
  });
  it('carries the live round identity without changing coordinates or point limits', () => {
    const roundId = '11111111-1111-4111-8111-111111111111';
    const command = formatGuessCommand(1, { x: 12, y: -34 }, 4500, roundId);
    expect(parseGuessCommand(command, limits)).toEqual({ round: 1, x: 12, y: -34, maximum: 4500, roundId });
    expect(command.length).toBeLessThan(100);
    expect(() => formatGuessCommand(1, { x: 0, y: 0 }, 5000, '1')).toThrow();
  });
  it('keeps the entire payload opaque, within Twitch limits, and detects damaged copies', () => {
    const roundId = '94311588-1dcc-477c-865b-561122bd9f36';
    const command = formatGuessCommand(1, { x: 14951, y: 14832 }, 4900, roundId);
    expect(command).not.toMatch(/14951|14832|4900|94311588/);
    expect(command.length).toBeLessThan(100);
    expect(new TextEncoder().encode(command).length).toBeLessThan(500);
    expect(parseGuessCommand(command, limits)).toEqual({ round: 1, x: 14951, y: 14832, maximum: 4900, roundId });
    const offset = command.indexOf('✦') + 5;
    const corrupt = command.slice(0, offset) + (command[offset] === 'ᚢ' ? 'ᚠ' : 'ᚢ') + command.slice(offset + 1);
    expect(parseGuessCommand(corrupt, limits)).toBeNull();
    expect(parseGuessCommand(command.slice(0, -2), limits)).toBeNull();
  });
});
