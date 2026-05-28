/**
 * Unlock encoding/decoding for passing player unlock state via URL.
 *
 * The unlock keys match telescope's UNLOCKABLES object. Each key maps to a
 * bit position. A bitstring is packed into bytes and base64url-encoded so it
 * fits compactly in a query parameter.
 *
 * Encoding: ordered key list -> 0/1 bitstring -> Uint8Array -> base64url
 */

// Canonical ordered list of telescope unlock keys. The order MUST stay stable
// -- new keys are appended at the end so existing encodings remain valid.
export const UNLOCK_KEYS: readonly string[] = [
  "sea_lava",
  "crumbling_earth",
  "cloud_thunder",
  "nuke",
  "bomb_holy",
  "necromancy",
  "material_cement",
  "firework",
  "exploding_deer",
  "spiral_shot",
  "tentacle",
  "sea_mimic",
  "touch_grass",
  "cessation",
  "piss",
  "kantele",
  "ocarina",
  "musicbox",
  "alchemy",
  "everything",
  "divide",
  "bomb_holy_giga",
  "nukegiga",
  "mestari",
  "duplicate",
  "pyramid",
  "dragon",
  "rain",
  "polymorph",
  "paint",
  "maths",
  "funky",
  "fish",
  "homing_wand",
  "black_hole",
  "rainbow_trail",
  "destruction",
] as const;

const STORAGE_KEY = "noitamap-unlocks";

/** Encode an array of unlocked key names into a base64url string. */
export function encodeUnlocks(unlockedKeys: string[]): string {
  const set = new Set(unlockedKeys);
  const byteCount = Math.ceil(UNLOCK_KEYS.length / 8);
  const bytes = new Uint8Array(byteCount);
  for (let i = 0; i < UNLOCK_KEYS.length; i++) {
    if (set.has(UNLOCK_KEYS[i])) {
      bytes[i >> 3] |= 1 << (i & 7);
    }
  }
  // base64url encode (no padding, URL-safe chars)
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Decode a base64url string back into an array of unlock key names. */
export function decodeUnlocks(encoded: string): string[] {
  // Restore standard base64
  let b64 = encoded.replace(/-/g, "+").replace(/_/g, "/");
  while (b64.length % 4) b64 += "=";
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

  const result: string[] = [];
  for (let i = 0; i < UNLOCK_KEYS.length; i++) {
    if (i >> 3 < bytes.length && (bytes[i >> 3] & (1 << (i & 7))) !== 0) {
      result.push(UNLOCK_KEYS[i]);
    }
  }
  return result;
}

/** Read unlock param from URL, cache to localStorage, return unlock keys.
 *  Returns null if no unlock data is available. */
export function getUnlocksFromURL(): string[] | null {
  const params = new URLSearchParams(window.location.search);
  const encoded = params.get("u");

  // Shorthand tokens for shareable views — not a mod-supplied list.
  if (encoded === "all" || encoded === "none") return null;

  if (encoded) {
    // URL has fresh unlock data -- cache it
    try {
      localStorage.setItem(STORAGE_KEY, encoded);
    } catch (_) {}
    return decodeUnlocks(encoded);
  }

  // Fall back to cached value
  try {
    const cached = localStorage.getItem(STORAGE_KEY);
    if (cached) return decodeUnlocks(cached);
  } catch (_) {}

  return null;
}

/** Classify the `?u=` query param. "mod" = base64url-encoded full list (from
 *  the in-game mod). "all" / "none" = shareable view shorthands. null = absent. */
export type UrlUnlockKind = "all" | "none" | "mod" | null;
export function getUrlUnlockKind(): UrlUnlockKind {
  const u = new URLSearchParams(window.location.search).get("u");
  if (!u) return null;
  if (u === "all") return "all";
  if (u === "none") return "none";
  return "mod";
}

/** Check if the unlock state from URL differs from cached state.
 *  Returns true if the URL has a new/different unlock param. */
export function unlocksChanged(): boolean {
  const params = new URLSearchParams(window.location.search);
  const encoded = params.get("u");
  if (!encoded) return false;
  try {
    const cached = localStorage.getItem(STORAGE_KEY);
    return cached !== encoded;
  } catch (_) {
    return true;
  }
}

/** Debug: set unlocks from console. Call window.__setUnlocks(["sea_lava","exploding_deer"]) then reload. */
if (typeof window !== "undefined") {
  (window as any).__setUnlocks = (keys: string[]) => {
    const encoded = encodeUnlocks(keys);
    localStorage.setItem(STORAGE_KEY, encoded);
    console.log(`Stored unlocks: [${keys.join(", ")}] -> "${encoded}". Reload to apply.`);
  };
  (window as any).__clearUnlocks = () => {
    localStorage.removeItem(STORAGE_KEY);
    console.log("Cleared unlocks. Reload to apply.");
  };
  (window as any).__getUnlocks = () => {
    try {
      const cached = localStorage.getItem(STORAGE_KEY);
      if (cached) {
        const keys = decodeUnlocks(cached);
        console.log("Current unlocks:", keys);
        return keys;
      }
    } catch (_) {}
    console.log("No unlocks stored.");
    return null;
  };
}
