/**
 * Achievement-pillar unlock encoding/decoding.
 *
 * Separate channel from src/unlocks.ts: that one (`&u=`) carries the 37
 * spell/perk-availability keys so the dynamic map generates the right spell
 * pool. THIS one (`&p=`) carries the ~76 achievement flags the in-game mod
 * reads from persistent/flags via HasFlagPersistent, so the Achievement Pillars
 * render with the player's real completion (unlocked = colour, locked = gray).
 *
 * The flag set is the first element of every PILLAR_FLAGS entry, which is a
 * verbatim copy of data/scripts/biomes/mountain_tree.lua `spawn_pillars`. The
 * bit order is the flag set sorted ALPHABETICALLY, derived here at runtime so it
 * can never drift from PILLAR_FLAGS. The mod (noitamap-mod/noitamap/init.lua)
 * builds the same bitfield by table.sort()-ing the identical flag list.
 *
 * Versioning: the `&p=` value is `"<version>.<base64url>"`. Adding/removing a
 * flag shifts every later bit, so bump PILLAR_UNLOCK_VERSION (here AND in the
 * mod) when the flag set changes. A value whose version prefix doesn't match is
 * ignored (treated as absent) rather than mis-decoded.
 */

import { PILLAR_FLAGS } from "./data/pillars";

/** Bump in lockstep with the mod when the pillar flag set changes. */
export const PILLAR_UNLOCK_VERSION = "1";

/** Canonical bit order: every pillar flag, sorted alphabetically. */
export const PILLAR_FLAG_ORDER: readonly string[] = PILLAR_FLAGS.flat()
  .map(([flag]) => flag)
  .sort();

/** Encode unlocked pillar flags as `"<version>.<base64url>"`. */
export function encodePillarFlags(unlockedFlags: string[]): string {
  const set = new Set(unlockedFlags);
  const byteCount = Math.ceil(PILLAR_FLAG_ORDER.length / 8);
  const bytes = new Uint8Array(byteCount);
  for (let i = 0; i < PILLAR_FLAG_ORDER.length; i++) {
    if (set.has(PILLAR_FLAG_ORDER[i])) {
      bytes[i >> 3] |= 1 << (i & 7);
    }
  }
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  const b64 = btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${PILLAR_UNLOCK_VERSION}.${b64}`;
}

/** Decode a `"<version>.<base64url>"` value. Returns null on version mismatch. */
export function decodePillarFlags(encoded: string): string[] | null {
  const dot = encoded.indexOf(".");
  if (dot === -1) return null;
  if (encoded.slice(0, dot) !== PILLAR_UNLOCK_VERSION) return null;
  let b64 = encoded.slice(dot + 1).replace(/-/g, "+").replace(/_/g, "/");
  while (b64.length % 4) b64 += "=";
  let binary: string;
  try {
    binary = atob(b64);
  } catch (_) {
    return null;
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

  const result: string[] = [];
  for (let i = 0; i < PILLAR_FLAG_ORDER.length; i++) {
    if (i >> 3 < bytes.length && (bytes[i >> 3] & (1 << (i & 7))) !== 0) {
      result.push(PILLAR_FLAG_ORDER[i]);
    }
  }
  return result;
}

/** Read `&p=` from the URL. Returns the unlocked-flag list, or null if absent
 *  / shorthand / version mismatch (caller then falls back to spell-unlock
 *  inference or all-unlocked). */
export function getPillarFlagsFromURL(): string[] | null {
  const p = new URLSearchParams(window.location.search).get("p");
  if (!p || p === "all" || p === "none") return null;
  return decodePillarFlags(p);
}
