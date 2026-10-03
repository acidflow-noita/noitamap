// @vitest-environment jsdom
/**
 * Pillar unlock channel (&p=) — encode/decode round-trip + bit-order invariants.
 *
 * The mod (noitamap-mod/noitamap/init.lua get_pillar_flags_param) packs the same
 * flag set, alphabetically sorted, into the same base64url bitfield with the same
 * version prefix. These tests pin the contract the Lua side must match: stable
 * alphabetical order, the full 76-flag set, and a lossless round-trip.
 */
import { describe, it, expect } from "vitest";
import { PILLAR_FLAGS } from "../src/data/pillars";
import {
  PILLAR_FLAG_ORDER,
  PILLAR_UNLOCK_VERSION,
  encodePillarFlags,
  decodePillarFlags,
} from "../src/pillars-unlocks";

describe("pillar unlock channel", () => {
  it("PILLAR_FLAG_ORDER is the full flag set, unique and alphabetically sorted", () => {
    const fromPillars = PILLAR_FLAGS.flat().map(([f]) => f);
    expect(PILLAR_FLAG_ORDER.length).toBe(fromPillars.length);
    expect(new Set(PILLAR_FLAG_ORDER).size).toBe(PILLAR_FLAG_ORDER.length); // no dupes
    expect([...PILLAR_FLAG_ORDER]).toEqual([...fromPillars].sort()); // exact alpha order
    expect(new Set(PILLAR_FLAG_ORDER)).toEqual(new Set(fromPillars)); // same membership
  });

  it("round-trips an arbitrary subset", () => {
    const subset = ["essence_fire", "progress_ending0", "secret_supernova", "boss_centipede"];
    const decoded = decodePillarFlags(encodePillarFlags(subset));
    expect(new Set(decoded)).toEqual(new Set(subset));
  });

  it("round-trips empty and full sets", () => {
    expect(decodePillarFlags(encodePillarFlags([]))).toEqual([]);
    const all = [...PILLAR_FLAG_ORDER];
    expect(new Set(decodePillarFlags(encodePillarFlags(all)))).toEqual(new Set(all));
  });

  it("ignores unknown flags on encode", () => {
    const decoded = decodePillarFlags(encodePillarFlags(["essence_fire", "not_a_real_flag"]));
    expect(decoded).toEqual(["essence_fire"]);
  });

  it("rejects a value whose version prefix does not match", () => {
    const good = encodePillarFlags(["essence_fire"]);
    const bad = good.replace(/^\d+\./, "9.");
    expect(good.startsWith(`${PILLAR_UNLOCK_VERSION}.`)).toBe(true);
    expect(decodePillarFlags(bad)).toBeNull();
  });

  it("rejects malformed input", () => {
    expect(decodePillarFlags("")).toBeNull();
    expect(decodePillarFlags("no-dot")).toBeNull();
  });
});
