// Coordinate-only spawn rules prepared once per worker. These tables contain no
// seed, biome, unlock, RNG or placement decisions. Keep their order-sensitive
// consumers in poi_scanner.js unchanged.
const CHUNK = 512, TILE = 10, PERIOD = 2560;

// Retained scalar definition also covers noninteger or unusually remote input.
function chunkBases(tileIndex, off) {
    const out = [];
    const lo = tileIndex * TILE - off - 1;
    const hi = tileIndex * TILE - off + TILE + 1;
    for (let s = Math.ceil(lo); s <= hi; s++) {
        if (Math.floor((s + off + 0.5) / TILE) !== tileIndex) continue;
        const cb = Math.floor(s / CHUNK) * CHUNK;
        if ((((s - cb) % TILE) + TILE) % TILE !== 0) continue;
        if (!out.includes(cb)) out.push(cb);
    }
    return out;
}

function scalarAxisGate(world, off) {
    const cell = Math.round((world + TILE / 2 + off) / TILE);
    for (const base of chunkBases(cell, off))
        if (base <= world && world < base + CHUNK - 1) return true;
    return false;
}

function scalarScanAxis(world) {
    const phase = ((((Math.floor(world / CHUNK) * CHUNK) % TILE) + TILE) % TILE);
    const base = (((phase - world) % TILE) + TILE) % TILE;
    return world + (base >= 5 ? base : base + TILE);
}

const axisTables = new Map();
function axisTable(off) {
    let table = axisTables.get(off);
    if (!table) {
        table = Uint8Array.from({ length: PERIOD }, (_, world) => +scalarAxisGate(world, off));
        axisTables.set(off, table);
    }
    return table;
}
const scanOffsets = Uint8Array.from({ length: CHUNK }, (_, world) => scalarScanAxis(world) - world);

// Beyond this conservative range the scalar IEEE arithmetic remains authority.
// In-range integer coordinate, chunk and cell intermediates are exactly stored;
// shifting by 2560 translates every candidate by 5 chunks and 256 tile cells.
const tabulated = world => Number.isInteger(world) && Math.abs(world) < 0x40000000;
function axisGate(world, off, table) {
    if (!tabulated(world)) return scalarAxisGate(world, off);
    const phase = world % PERIOD;
    return table[phase < 0 ? phase + PERIOD : phase] !== 0;
}

export function spawnScanPointAxis(world) {
    return tabulated(world) ? world + scanOffsets[world & (CHUNK - 1)] : scalarScanAxis(world);
}

const plans = new Map();
export function preparedSpawnCoordinates(isNGP, gameMode = 'normal') {
    const center = isNGP || gameMode === 'nightmare' ? 32 : 35;
    let plan = plans.get(center);
    if (!plan) {
        const offX = center * CHUNK, offY = 14 * CHUNK;
        const x = axisTable(offX), y = axisTable(offY);
        plan = Object.freeze({
            accepts(worldX, worldY) { return axisGate(worldX, offX, x) && axisGate(worldY, offY, y); },
        });
        plans.set(center, plan);
    }
    return plan;
}

// Charge both mode tables to immutable worker preparation, never to a seed.
preparedSpawnCoordinates(false);
preparedSpawnCoordinates(true);
