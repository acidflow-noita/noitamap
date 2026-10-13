// Adapted into the owned Noitamap rules runtime. See NOTICE.txt for provenance.
import { fetchSafeJson } from "./utils.js";
// This fails on some browsers
//import biomeFlagsData from '../data/biome_flags.json' with { type: 'json' };
const biomeFlagsData = await fetchSafeJson('../data/biome_flags.json');

const EDGE_NOISE_DEFAULTS = {
    noise_biome_edges: 1, // 0 for straight edges, 1 for wobble
    fat_biome_edges: 0, // 1 for "fat" edges that short-circuit to the original chunk, 0 for normal edge noise
    // big_noise_biome_edges: 1, // used to remove sincos wobble when set to 0, but not currently used so omitted for now
};

const KNOWN_BIOME_COLORS = new Set();
const BIOME_FLAGS_BY_COLOR = new Map();
for (const b of biomeFlagsData.biomes) {
    const rgb = parseInt(b.color, 16) & 0xffffff;
    KNOWN_BIOME_COLORS.add(rgb);
    BIOME_FLAGS_BY_COLOR.set(rgb, b);
}

// Look up a single edge-noise attribute for a biome-map RGB color.
export function biomeEdgeNoiseFlag(colorInt, attr) {
    const rgb = colorInt & 0xffffff;
    if (!KNOWN_BIOME_COLORS.has(rgb)) return null; // This is unlikely to ever trigger
    const entry = BIOME_FLAGS_BY_COLOR.get(rgb);
    return entry[attr] ?? EDGE_NOISE_DEFAULTS[attr]; // Return default if missing
}

export const BIOME_FLAGS = biomeFlagsData;
