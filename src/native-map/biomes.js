// Derived from noita-telescope by Lymm (MIT); see LICENSE.
// Source: Lymm 7fce46be8a5587fa88693d468046e236f862f5c7; algorithms unchanged
// except explicit input/state ownership and removal of discarded raster output.

import { NollaPrng } from "./random.js";
import { shuffleTable } from "./coordinates.js";

export const BIOME_CONFIG = {
  CHUNK_SIZE: 512,
  W_NG0: 70,
  H_NG0: 48,
  W_NGP: 64,
  H_NGP: 48,
};

// Internal Helper to interact with the pixel buffer
class BiomePainter {
  constructor(pixels, w, h, rng, isNightmare) {
    this.pixels = pixels; // Uint32Array
    this.w = w;
    this.h = h;
    this.rng = rng;
    this.isNightmare = isNightmare;
  }

  set(x, y, c) {
    if (x < 0 || x >= this.w || y < 0 || y >= this.h) return;
    this.pixels[y * this.w + x] = c;
  }

  rect(x, y, w, h, c, buf) {
    let ex = this.rng.Random(0, buf);
    x -= ex;
    w += ex + this.rng.Random(0, buf);
    for (let iy = y; iy < y + h; iy++) {
      for (let ix = x; ix < x + w; ix++) {
        this.set(ix, iy, c);
      }
    }
  }

  rectSplit(x, y, w, h, c1, c2, buf) {
    let ex = this.rng.Random(0, buf);
    x -= ex;
    w += ex + this.rng.Random(0, buf);
    let cut = this.rng.Random(y + 1, y + h - 2);

    for (let ix = x; ix < x + w; ix++) {
      for (let iy = y; iy < y + h; iy++) {
        this.set(ix, iy, iy < cut ? c1 : c2);
      }
      cut += this.rng.Random(-1, 1);
      cut = Math.max(y + 1, Math.min(y + h - 2, cut));
    }
  }

  cave(x, y, dir, c, len) {
    for (let i = 1; i <= len; i++) {
      this.set(x, y, c);

      // Random walk X
      if (i < 5 || this.rng.Random(0, 100) < 75) x += dir;
      else x -= dir;
      x = Math.max(2, Math.min(62, x));

      this.set(x, y, c);

      // Why is this different? wtf
      if (this.isNightmare) {
        y = Math.max(17, Math.min(45, y));
      }

      // Random walk Y
      if (i > 3) {
        if (this.rng.Random(0, 100) < 65) y++;
        else y--;
      }

      if (!this.isNightmare) {
        y = Math.max(17, Math.min(45, y));
      }

      // Blobbing
      if (i > 6) {
        if (this.rng.Random(0, 100) < 35) this.set(x - 1, y, c);
        if (this.rng.Random(0, 100) < 35) this.set(x + 1, y, c);
        if (this.rng.Random(0, 100) < 35) this.set(x, y - 1, c);
        if (this.rng.Random(0, 100) < 35) this.set(x, y + 1, c);
      }
    }
  }
}

/**
 * Generates the biome map data.
 * @param {number} seed World Seed
 * @param {number} ng New Game+ Count
 * @param {Uint8Array | Uint8ClampedArray} baseImageData Initial pixel data from the base PNG, RGBA
 * @param {number} width
 * @param {number} height
 */
export function generateBiomeData(
  seed,
  ng,
  gameMode,
  baseImageData,
  width,
  height,
  nightmarePlusPainter = false,
) {
  // Copy base pixels to new buffer to avoid modifying the cached source
  const pixels = new Uint32Array(width * height);
  for (let i = 0; i < baseImageData.length; i++) {
    pixels[i] =
      0xff000000 |
      (baseImageData[i * 4] << 16) |
      (baseImageData[i * 4 + 1] << 8) |
      baseImageData[i * 4 + 2];
  }
  const orbs = [];

  // There is nothing special about Nightmare+
  const isNightmare = gameMode === "nightmare" && ng === 0;

  // If NG+ is 0, we just return the base map (static)
  if (ng === 0 && !isNightmare) {
    // Generate heaven/hell maps (literally just repeat first/last row)
    let heavenPixels = new Uint32Array(pixels.length);
    let hellPixels = new Uint32Array(pixels.length);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        heavenPixels[y * width + x] = pixels[x % width]; // Repeat first row
        hellPixels[y * width + x] = pixels[(height - 1) * width + (x % width)]; // Repeat last row
      }
    }
    return { pixels, heavenPixels, hellPixels, orbs };
  }

  const rng = new NollaPrng(0);
  rng.SetRandomSeed(seed + ng, 4573, 4621);
  const painter = new BiomePainter(
    pixels,
    width,
    height,
    rng,
    isNightmare || (nightmarePlusPainter && gameMode === "nightmare"),
  );

  // 1. Biome Colors (Standard Palette)
  let b = {
    coal: isNightmare ? 0xffd57917 : 0xffd56517,
    coll: 0xffd56517,
    fungi: 0xffe861f0,
    excav: 0xff124445,
    snow: 0xff1775d5,
    hiisi: 0xff0046ff,
    j1: 0xffa08400,
    j2: 0xff808000,
    vault: 0xff008000,
    sand: 0xffe1cd32,
    snowvault: 0xff0080a8,
    wand: 0xff006c42,
    crypt: 0xff786c42, // Not present in nightmare biome list for some reason??
  };

  // 2. NG+ Variations
  let doWalls = false;
  if (ng > 0) {
    if (ng % 2 === 0) {
      // Tower
      b.coal = 0xff3d3e37;
      b.coll = 0xff3d3e37;
      b.fungi = 0xff3d3e3b;
      b.excav = 0xff3d3e38;
      b.snow = 0xff3d3e39;
      b.hiisi = 0xff3d3e3a;
      b.j1 = 0xff3d3e3c;
      b.j2 = 0xff3d3e3c;
      b.vault = 0xff3d3e3d;
      b.crypt = 0xff3d3e3e;
    }

    if (ng % 3 === 0) {
      // Shuffled world
      let pool = [
        0xffd56517, 0xffd56517, 0xffe861f0, 0xff124445, 0xff1775d5, 0xff0046ff,
        0xffa08400, 0xff808000, 0xff008000, 0xffe1cd32, 0xff0080a8, 0xff006c42,
        0xff786c42,
      ];
      shuffleTable(pool, rng);

      b.coal = pool[0];
      b.coll = pool[1];
      b.fungi = pool[2];
      b.excav = pool[3];
      b.snow = pool[4];
      b.hiisi = pool[5];
      b.j1 = pool[6];
      b.j2 = pool[7];
      b.vault = pool[8];
      b.crypt = pool[9];
    }

    doWalls = ng % 5 === 0;

    if (ng % 7 === 0) {
      // Specific color replacement at (16, 5)
      const t = Math.floor(ng / 7) % 3;
      const c = t === 0 ? 0xffcc9944 : t === 1 ? 0xffd6d8e3 : 0xff33e311;
      const target = pixels[5 * width + 16];
      for (let i = 0; i < pixels.length; i++) {
        if (pixels[i] === target) pixels[i] = c;
      }
    }
  }

  // 3. Swaps
  const swap = (k1, k2) => {
    if (rng.Random(0, 100) < 35) {
      let t = b[k1];
      b[k1] = b[k2];
      b[k2] = t;
    }
  };
  if (!isNightmare) {
    swap("coal", "coll");
  } else {
    // Swap without random chance
    let t = b["coal"];
    b["coal"] = b["excav"];
    b["excav"] = t;
  }
  swap("fungi", "excav");
  swap("snow", "hiisi");
  swap("j1", "j2");
  swap("sand", "fungi");
  swap("wand", "sand");

  // 4. Caves
  const doCave = (x, y, dir, c, lMin, lMax) => {
    if (rng.Random(0, 100) < 65) {
      painter.cave(x, y, dir, c, rng.Random(lMin, lMax));
    }
  };

  doCave(27, 15, -1, b.fungi, 4, 50);
  doCave(35, 15, 1, b.fungi, 4, 50);
  doCave(27, 18, -1, b.fungi, 4, 50);
  doCave(35, 18, 1, b.fungi, 4, 50);

  if (rng.Random(0, 100) < 65)
    painter.cave(27, 20 + rng.Random(0, 5), -1, b.wand, rng.Random(5, 50));
  if (rng.Random(0, 100) < 65)
    painter.cave(35, 20 + rng.Random(0, 5), 1, b.wand, rng.Random(5, 50));
  if (rng.Random(0, 100) < 65)
    painter.cave(27, 27 + rng.Random(0, 6), -1, b.sand, rng.Random(5, 50));
  if (rng.Random(0, 100) < 65)
    painter.cave(35, 27 + rng.Random(0, 6), 1, b.sand, rng.Random(5, 50));

  // 5. Rect Areas
  painter.rect(32, 14, 3, 2, b.coal, 0);
  painter.rect(28, 15, 4, 1, b.coll, 1);
  if (!isNightmare) {
    painter.rect(28, 17, 4, 2, b.excav, 2);
    painter.rectSplit(28, 20, 7, 6, b.snow, b.hiisi, 3);
  } else {
    painter.rect(28, 17, 4, 4, b.snow, 2);
    painter.rect(28, 22, 7, 4, b.hiisi, 3);
  }
  painter.rectSplit(28, 27, 7, 4, b.j1, b.j2, 4);
  painter.rectSplit(28, 29, 7, 5, b.j2, b.vault, 4);
  // Not listed in nightmare but I'm pretty sure it's the same? Actually nope
  if (!isNightmare) {
    painter.rect(29, 35, 11, 3, b.crypt, 0);
  }

  if (doWalls) {
    const wallLeft = rng.Random(2, 6);
    const wallRight = rng.Random(1, 4);
    painter.rect(23, 15, wallLeft, 25, 0xff3d3d3d, 0);
    painter.rect(33 + (4 - wallRight), 16, wallRight, 22, 0xff3d3d3d, 0);
  }

  // 6. Orbs
  const addOrb = (x, y, name, color) => {
    painter.set(x, y, color);
    //let worldX = x * 512 + 256 - 32 * 512; // Center of chunk
    //let worldY = y * 512 + 256 - 14 * 512;
    // Uses chunk x and y, unlike other objects... Weird inconsistency as a result of this being the first PoI type thing added
    orbs.push({
      x: x,
      y: y,
      name,
      type: "item",
      item: "orb",
      biome: "orb_room",
    });
  };

  addOrb(51, 11, "Pyramid", 0xffc88f5f);
  addOrb(33, 11, "Floating Island", 0xffc08082);
  if (!isNightmare) {
    addOrb(rng.Random(0, 5) + 10, rng.Random(0, 2) + 18, "Vault", 0xffffd102);
    addOrb(
      rng.Random(0, 5) + 49,
      rng.Random(0, 3) + 17,
      "Pyramid (Inside)",
      0xffffd104,
    );

    let hx = rng.Random(0, 9) + 27;
    let hy = rng.Random(0, 2) + 44;
    if (ng === 3 || ng >= 25) hy = 47;
    addOrb(hx, hy, "Hell", 0xffffd108);

    addOrb(
      rng.Random(0, 6) + 12,
      rng.Random(0, 3) + 40,
      "Snowcave",
      0xffffd109,
    );
    addOrb(rng.Random(0, 4) + 51, rng.Random(0, 5) + 41, "Desert", 0xffffd110);
    addOrb(rng.Random(0, 5) + 58, rng.Random(0, 5) + 34, "Nuke", 0xffffd103);
    addOrb(rng.Random(0, 9) + 40, rng.Random(0, 11) + 21, "Orb 1", 0xffffd105);
    addOrb(rng.Random(0, 7) + 17, rng.Random(0, 8) + 21, "Orb 2", 0xffffd106);
    addOrb(rng.Random(0, 7) + 1, rng.Random(0, 9) + 24, "Orb 3", 0xffffd107);
  } else {
    addOrb(12, 19, "Vault", 0xffffd102);
    addOrb(51, 19, "Pyramid (Inside)", 0xffffd104);
    addOrb(31, 45, "Hell", 0xffffd108);
    addOrb(14, 42, "Snowcave", 0xffffd109);
    addOrb(52, 45, "Desert", 0xffffd110);
  }

  // Prevent these from getting overwritten by caves
  const color_end_room = 0xff50eed7;
  const color_boss_arena = 0xff14eed7;

  painter.set(44, 43, color_end_room);

  painter.rect(35, 38, 5, 2, color_boss_arena, 0);
  painter.set(37, 40, color_boss_arena);
  painter.set(38, 40, color_boss_arena);

  // Generate heaven/hell maps (literally just repeat first/last row)
  let heavenPixels = new Uint32Array(pixels.length);
  let hellPixels = new Uint32Array(pixels.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      heavenPixels[y * width + x] = pixels[x % width]; // Repeat first row
      hellPixels[y * width + x] = pixels[(height - 1) * width + (x % width)]; // Repeat last row
    }
  }

  return { pixels, heavenPixels, hellPixels, orbs };
}
