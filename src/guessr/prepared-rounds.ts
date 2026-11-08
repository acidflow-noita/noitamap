/** Compact, private build products for Workers Free. Eligibility is computed
 * offline; requests only sample a weighted strip and select existing images. */
import { isHolyMountainArea, type AreaDefinition } from "./area-rules";
import { cameraRect, type PreparedFrame } from "./clue-camera";
import type { ImageGameConfig } from "./image-game";
import type { Point } from "./rules";

export interface PreparedGameCatalog {
  schemaVersion: 1;
  version: string;
  capture: {
    originX: number;
    originY: number;
    width: number;
    height: number;
    tileSize: number;
    overlap: number;
    maxLevel: number;
  };
  areas: { definition: AreaDefinition; starts: string; positions: number }[];
}

export interface PreparedRound {
  area: AreaDefinition;
  answer: Point;
  frames: PreparedFrame[];
}

export function preparedGameConfig(
  catalog: PreparedGameCatalog,
  referenceRoot: string,
): ImageGameConfig {
  const c = catalog.capture;
  return {
    version: catalog.version,
    bounds: { x: c.originX, y: c.originY, width: c.width, height: c.height },
    overview: "",
    map: {
      width: c.width,
      height: c.height,
      tileSize: c.tileSize,
      overlap: c.overlap,
      maxLevel: c.maxLevel,
      tiles: referenceRoot.replace(/\/?$/, "/"),
    },
  };
}

const prefix = "/game-data/";
const hex = Array.from({ length: 256 }, (_, n) =>
  n.toString(16).padStart(2, "0"),
);
const secureRandom = () =>
  crypto.getRandomValues(new Uint32Array(1))[0] / 4294967296;

/** Resolved immutable bytes may be cached across requests; pending binding I/O
 * is deliberately not shared across Worker invocation lifetimes. */
export function createPreparedRoundSource(
  readAsset: (path: string) => Promise<Response>,
  imageRoot: string,
  referenceRoot: string,
  random: () => number = secureRandom,
) {
  let catalog: PreparedGameCatalog | undefined;
  let grid: Uint8Array | undefined;
  const samplers = new Map<string, { data: DataView; bytes: number }>();
  let samplerBytes = 0;

  async function bytes(path: string, maximum: number): Promise<ArrayBuffer> {
    const response = await readAsset(prefix + path);
    if (
      !response.ok ||
      Number(response.headers.get("Content-Length")) > maximum
    )
      throw new Error(
        "Prepared game data is unavailable. Run prepare-worker-data.mts.",
      );
    const value = await response.arrayBuffer();
    if (value.byteLength > maximum)
      throw new Error("Prepared game data exceeds its size limit.");
    return value;
  }

  async function loadCatalog(): Promise<PreparedGameCatalog> {
    if (catalog) return catalog;
    const next = JSON.parse(
      new TextDecoder().decode(await bytes("catalog.json", 1024 * 1024)),
    ) as PreparedGameCatalog;
    if (next.schemaVersion !== 1 || !next.version || !next.areas?.length)
      throw new Error("Prepared game catalog is invalid.");
    const c = next.capture;
    if (
      !c ||
      ![
        c.originX,
        c.originY,
        c.width,
        c.height,
        c.tileSize,
        c.overlap,
        c.maxLevel,
      ].every(Number.isSafeInteger) ||
      c.width <= 0 ||
      c.height <= 0 ||
      c.tileSize <= 0 ||
      c.overlap < 0 ||
      c.overlap >= c.tileSize
    )
      throw new Error("Prepared map geometry is invalid.");
    if (
      next.areas.some(
        (a) =>
          !/^[a-f0-9]{32}\.bin$/.test(a.starts) ||
          !Number.isSafeInteger(a.positions) ||
          a.positions <= 0,
      )
    )
      throw new Error("Prepared area sampling data is invalid.");
    catalog = next;
    return next;
  }

  async function loadGrid(
    c: PreparedGameCatalog["capture"],
  ): Promise<Uint8Array> {
    if (grid) return grid;
    const columns = Math.ceil(c.width / c.tileSize),
      rows = Math.ceil(c.height / c.tileSize);
    const next = new Uint8Array(
      await bytes("native-grid.bin", 12 + columns * rows * 16),
    );
    const header = new DataView(next.buffer);
    if (
      next.byteLength !== 12 + columns * rows * 16 ||
      String.fromCharCode(...next.subarray(0, 4)) !== "NGG1" ||
      header.getUint32(4, true) !== columns ||
      header.getUint32(8, true) !== rows
    )
      throw new Error("Prepared image grid is invalid.");
    grid = next;
    return next;
  }

  async function loadSampler(
    area: PreparedGameCatalog["areas"][number],
  ): Promise<DataView> {
    const cached = samplers.get(area.starts);
    if (cached) {
      samplers.delete(area.starts);
      samplers.set(area.starts, cached);
      return cached.data;
    }
    const buffer = await bytes("starts/" + area.starts, 16 * 1024 * 1024);
    if (buffer.byteLength < 8)
      throw new Error("Prepared starting positions are truncated.");
    const data = new DataView(buffer),
      magic = new Uint8Array(buffer, 0, 4);
    const count = data.getUint32(4, true);
    if (
      String.fromCharCode(...magic) !== "NGS1" ||
      !count ||
      buffer.byteLength !== 8 + count * 20 ||
      data.getUint32(8 + (count - 1) * 20 + 16, true) !== area.positions
    )
      throw new Error("Prepared starting positions are invalid.");
    // Keep only a bounded set of immutable masks. One active request can still
    // use a larger individual mask without retaining it for the isolate's life.
    if (buffer.byteLength <= 8 * 1024 * 1024) {
      // Another invocation may have finished the same static asset while this
      // one awaited I/O. Reuse its immutable bytes without double-counting them.
      const existing = samplers.get(area.starts);
      if (existing) return existing.data;
      while (
        samplerBytes + buffer.byteLength > 8 * 1024 * 1024 &&
        samplers.size
      ) {
        const key = samplers.keys().next().value!;
        samplerBytes -= samplers.get(key)!.bytes;
        samplers.delete(key);
      }
      samplers.set(area.starts, { data, bytes: buffer.byteLength });
      samplerBytes += buffer.byteLength;
    }
    return data;
  }

  function drawIndex(length: number): number {
    const value = random();
    if (!Number.isFinite(value) || value < 0 || value >= 1)
      throw new Error("Random source must return a finite number in [0, 1).");
    return Math.min(length - 1, Math.floor(value * length));
  }

  function sample(data: DataView, positions: number): Point {
    const target = drawIndex(positions);
    let low = 0,
      high = data.getUint32(4, true) - 1;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (data.getUint32(8 + middle * 20 + 16, true) <= target)
        low = middle + 1;
      else high = middle;
    }
    const offset = 8 + low * 20;
    const previous = low ? data.getUint32(offset - 4, true) : 0;
    const width = data.getUint32(offset + 8, true),
      height = data.getUint32(offset + 12, true);
    const point = target - previous;
    if (!width || !height || point < 0 || point >= width * height)
      throw new Error("Prepared starting position lies outside its mask.");
    return {
      x: data.getInt32(offset, true) + (point % width),
      y: data.getInt32(offset + 4, true) + Math.floor(point / width),
    };
  }

  function frames(
    c: PreparedGameCatalog["capture"],
    native: Uint8Array,
    point: Point,
  ): PreparedFrame[] {
    const view = cameraRect({ dx: 0, dy: 0, level: 6 });
    const left = point.x + view.x - c.originX,
      top = point.y + view.y - c.originY;
    if (
      left < 0 ||
      top < 0 ||
      left + view.width > c.width ||
      top + view.height > c.height
    )
      throw new Error("Prepared starting view is outside the captured map.");
    const columns = Math.ceil(c.width / c.tileSize),
      result: PreparedFrame[] = [];
    for (
      let y = Math.floor(top / c.tileSize);
      y <= Math.floor((top + view.height - 1) / c.tileSize);
      y++
    ) {
      for (
        let x = Math.floor(left / c.tileSize);
        x <= Math.floor((left + view.width - 1) / c.tileSize);
        x++
      ) {
        const offset = 12 + (y * columns + x) * 16;
        let id = "";
        for (let i = 0; i < 16; i++) id += hex[native[offset + i]];
        const imageX = Math.max(0, x * c.tileSize - c.overlap);
        const imageY = Math.max(0, y * c.tileSize - c.overlap);
        result.push({
          image: imageRoot.replace(/\/$/, "") + "/" + id + ".webp",
          x: c.originX + imageX - point.x,
          y: c.originY + imageY - point.y,
          width: Math.min(c.width, (x + 1) * c.tileSize + c.overlap) - imageX,
          height: Math.min(c.height, (y + 1) * c.tileSize + c.overlap) - imageY,
        });
      }
    }
    return result;
  }

  return {
    async config(): Promise<ImageGameConfig> {
      return preparedGameConfig(await loadCatalog(), referenceRoot);
    },
    async sampleRounds(count: number): Promise<PreparedRound[]> {
      if (!Number.isInteger(count) || count < 1 || count > 20)
        throw new Error("Invalid round count.");
      const data = await loadCatalog(),
        native = await loadGrid(data.capture);
      const grouped = new Map<string, PreparedGameCatalog['areas']>();
      for (const area of data.areas) {
        const group = grouped.get(area.definition.id) ?? [];
        group.push(area); grouped.set(area.definition.id, group);
      }
      let holyMountainUsed = false, featurelessUsed = false;
      const eligible = (area: PreparedGameCatalog['areas'][number]) =>
        (!holyMountainUsed || !isHolyMountainArea(area.definition)) && (!featurelessUsed || !area.definition.viewDifficulty);
      const refill = () => [...grouped.values()].map(group => group.filter(eligible)).filter(group => group.length);
      let pool = refill();
      const result: PreparedRound[] = [];
      for (let n = 0; n < count; n++) {
        if (!pool.length) pool = refill();
        if (!pool.length) throw new Error('Not enough eligible puzzle areas.');
        const group = pool.splice(drawIndex(pool.length), 1)[0];
        // Select a semantic area once, then weight its view variants by native
        // eligible positions. Splitting an area must not give it extra tickets.
        let area = group[0];
        if (group.length > 1) {
          let target = drawIndex(group.reduce((n, entry) => n + entry.positions, 0));
          for (const entry of group) { area = entry; if (target < entry.positions) break; target -= entry.positions; }
        }
        const answer = sample(await loadSampler(area), area.positions);
        result.push({
          area: area.definition,
          answer,
          frames: frames(data.capture, native, answer),
        });
        if (isHolyMountainArea(area.definition)) {
          holyMountainUsed = true;
        }
        if (area.definition.viewDifficulty) featurelessUsed = true;
        pool = pool.map(group => group.filter(eligible)).filter(group => group.length);
      }
      return result;
    },
  };
}
