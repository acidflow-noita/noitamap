// Derived from noita-telescope by Lymm (MIT); see LICENSE.
// Source: Lymm 7fce46be8a5587fa88693d468046e236f862f5c7; algorithms unchanged
// except explicit input/state ownership and removal of discarded raster output.

// Bufferless fill-layer metadata is retained from the vitaminmoo render-perf
// fork 9c587750c361e88583fe8df406d74136bbcc1dde for the existing HD renderer.
import { NollaPrng } from "./random.js";
import { createWangGenerator } from "./wang.js";
import {
  applyMainBiomeHack,
  applyCoalmineHack,
  applyPostprocessingHacks,
  undoCoalmineHack,
} from "./postprocessing.js";
import { blockOutRooms } from "./rooms.js";
import {
  findMinPath,
  getPathStartSegment,
  usesMinesTemplate,
} from "./pathfinding.js";
import { CHUNK_SIZE, TILE_SIZE } from "./coordinates.js";

export function createTileGenerator({
  minesOverlay,
  blockedRoomColors,
  fillLayers,
}) {
  const {
    stbhw_generate_image,
    stbhw_build_tileset_from_image,
    StbhwTileset,
    stbhw_set_prng,
  } = createWangGenerator();

  //import { spawnWandAltar, spawnPotionAltar, spawnChest, spawnHeart } from './spell_generator.js';

  // Constants

  const MAX_PATHFINDING_ATTEMPTS = 99;
  const BIOME_PATH_HEIGHT_LIMIT_CHUNKS = 4;
  //const BIOME_PATH_FIND_WORLD_POS_MIN_X = 159;
  //const BIOME_PATH_FIND_WORLD_POS_MAX_X = 223;
  const BYPASS_PATHFINDING = false; // Debug
  const RESTORE_BLOCKED_ROOMS = true; // Debug, should be true, whether to restore blocked rooms after pathfinding (only for coalmine and excavationsite)

  const DEFAULT_OFFSET_Y = 4;
  const prng = new NollaPrng(0);
  const TILESET_CACHE = {};

  // Debug: Disable all but one biome for testing
  // const debugBiome = 'excavationsite';
  //Object.keys(GENERATOR_CONFIG).forEach(k => { if (k !== debugBiome) GENERATOR_CONFIG[k].enabled = false; });

  function calculateMapDimensions(bbox) {
    const [minX, minY, maxX, maxY] = bbox;
    // Chunks which have x % 5 == -1 have an extra pixel in width
    // Chunks which have y % 5 == -1 have an extra pixel in height
    /*
    let totalWidth = 0;
    for (let x = minX; x <= maxX; x++) {
        totalWidth += 51; // Base width for 1 chunk
        if (x % 5 === 4) totalWidth += 1; // Extra pixel for this chunk
    }
    let totalHeight = 0;
    for (let y = minY; y <= maxY; y++) {
        totalHeight += 51; // Base height for 1 chunk
        if (y % 5 === 4) totalHeight += 1; // Extra pixel for this chunk
    }
    */
    // Shortcut, equivalent
    const td = (n) => Math.trunc(n / 10);
    const totalWidth = td((maxX + 1) * 512) - td(minX * 512);
    const totalHeight = td((maxY + 1) * 512) - td(minY * 512);
    return { width: totalWidth, height: totalHeight };
  }

  function getCachedTileset(biomeName, wangData) {
    if (TILESET_CACHE[biomeName]) return TILESET_CACHE[biomeName];

    let ts = new StbhwTileset();
    if (wangData) {
      const rgba = wangData.data;
      const w = wangData.width;
      const h = wangData.height;
      const rgb = new Uint8Array(w * h * 3);
      for (let i = 0; i < w * h; i++) {
        rgb[i * 3] = rgba[i * 4];
        rgb[i * 3 + 1] = rgba[i * 4 + 1];
        rgb[i * 3 + 2] = rgba[i * 4 + 2];
      }

      //console.log(`[Generator] Building tileset for ${biomeName}...`);
      stbhw_build_tileset_from_image(ts, rgb, w * 3, w, h);
    }

    TILESET_CACHE[biomeName] = ts;
    return ts;
  }

  function generateRawTileBuffer(
    regionPoints,
    bbox,
    wangData,
    worldSeed,
    ngPlus,
    extraRerolls,
    biomeName,
    gameMode = "normal",
    wangFile = "",
  ) {
    const minX = bbox[0];
    const minY = bbox[1];
    //const [minX, minY, maxX, maxY] = bbox;
    //const wChunks = 1 + maxX - minX;
    //const hChunks = 1 + maxY - minY;
    //const mapW = getMapWidth(wChunks, biomeName);
    //const mapH = Math.ceil(512 * hChunks / 10);
    const mapDimensions = calculateMapDimensions(bbox);
    const mapW = mapDimensions.width;
    const mapH = mapDimensions.height;
    // Add offset per biome? Might not be necessary with fix actually
    //console.log(`[Generator] Calculated map dimensions for ${biomeName}: ${mapW}x${mapH} (chunks: ${wChunks}x${hChunks})`);
    const outH = mapH + 4;

    const ts = getCachedTileset(biomeName, wangData);
    if (ts.h_tiles.length === 0) return null;

    stbhw_set_prng(prng);
    prng.SetRandomFromWorldSeed(worldSeed + ngPlus);
    prng.Next();

    // The tile data repeats after 1024 pixels, and this also clamps the extra PRNG rolls.
    const effectiveMapWidth = Math.min(mapW, 1024);
    const iters =
      effectiveMapWidth +
      (worldSeed + ngPlus) -
      11 * Math.floor(effectiveMapWidth / 11) -
      12 * Math.floor((worldSeed + ngPlus) / 12);
    for (let i = 0; i < iters; i++) prng.Next();
    for (let i = 0; i < extraRerolls; i++) prng.Next();

    prng.Seed = prng.NextU();
    prng.Next();

    const rawBuffer = new Uint8Array(mapW * outH * 3);
    let coffee_hack = false;
    const tile_indices = stbhw_generate_image(
      ts,
      rawBuffer,
      mapW * 3,
      mapW,
      outH,
      coffee_hack,
    );
    if (!tile_indices) return null;

    // Missing step: block out rooms related to pixel scenes
    // Keyed on the wang template, so the towers built from those templates get it too.
    const isMines = usesMinesTemplate(wangFile);
    let shouldBlockOutRooms =
      isMines || (!!wangFile && wangFile.endsWith("excavationsite.png"));
    let pixelSceneRooms = [];
    if (shouldBlockOutRooms) {
      pixelSceneRooms = blockOutRooms(rawBuffer, mapW, outH, blockedRoomColors);
    }

    // Where the path is forced to start, and the area cleared for it. The mines
    // template starts at a fixed tile instead and clears nothing.
    const pathStart = getPathStartSegment(
      bbox,
      mapW,
      mapH,
      wangFile,
      ngPlus > 0,
      gameMode,
    );
    if (pathStart && !isMines) {
      applyMainBiomeHack(pathStart.x, rawBuffer, mapW, outH);
    }
    // Nightmare doesn't have coalmine hack
    if (isMines && gameMode !== "nightmare") {
      applyCoalmineHack(rawBuffer, mapW, outH, minesOverlay);
    }

    return {
      buffer: rawBuffer,
      width: mapW,
      height: outH,
      tileIndices: tile_indices.tileIndices,
      xmax: tile_indices.xmax,
      ymax: tile_indices.ymax,
      tileSize: ts.short_side_len,
      numHTiles: ts.num_h_tiles,
      numVTiles: ts.num_v_tiles,
      minX,
      minY,
      mapH,
      pixelSceneRooms: pixelSceneRooms,
      pathStart: pathStart,
    };
  }

  function findBiomeRegions(pixels, width, height, targetColor) {
    const visited = new Uint8Array(width * height);
    const regions = [];
    const bboxes = [];

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const idx = y * width + x;
        if (visited[idx] === 0 && pixels[idx] === targetColor) {
          const regionPoints = [];
          const queue = [[x, y]];
          visited[idx] = 1;
          let minX = width,
            maxX = 0,
            minY = height,
            maxY = 0;

          while (queue.length > 0) {
            const [cx, cy] = queue.shift();
            // Snowchasm hack (didn't work)
            //if (cy > maxY && maxY - minY == 19) continue;
            regionPoints.push([cx, cy]);
            if (cx < minX) minX = cx;
            if (cx > maxX) maxX = cx;
            if (cy < minY) minY = cy;
            if (cy > maxY) maxY = cy;

            const neighbors = [
              [1, 0],
              [-1, 0],
              [0, 1],
              [0, -1],
            ];
            for (const [dx, dy] of neighbors) {
              const nx = cx + dx;
              const ny = cy + dy;
              if (nx >= 0 && nx < width && ny >= 0 && ny < height) {
                const nIdx = ny * width + nx;
                if (visited[nIdx] === 0 && pixels[nIdx] === targetColor) {
                  visited[nIdx] = 1;
                  queue.push([nx, ny]);
                }
              }
            }
          }
          // Special consideration literally only for the 1x1 chunk of overgrown with diagonal pattern
          // Check other region boxes
          let valid = true;
          for (let i = 0; i < regions.length; i++) {
            const [rMinX, rMinY, rMaxX, rMaxY] = bboxes[i];
            if (
              minX >= rMinX &&
              maxX <= rMaxX &&
              minY >= rMinY &&
              maxY <= rMaxY
            ) {
              // This region is fully contained within an existing region
              // Attempt to merge
              for (const p of regionPoints) {
                regions[i].push(p);
              }
              valid = false;
            }
          }
          if (valid) {
            regions.push(regionPoints);
            bboxes.push([minX, minY, maxX, maxY]);
          }
        }
      }
    }
    return { regions, bboxes };
  }

  function applyMasking(pixels, mapW, bbox, validChunks, offsetY = 4) {
    const [minCX, minCY, maxCX, maxCY] = bbox;
    let tx = 0;
    for (let cx = minCX; cx <= maxCX; cx++) {
      let cw = 51;
      if (cx % 5 === 4) cw += 1;
      let ty = 0;
      for (let cy = minCY; cy <= maxCY; cy++) {
        let ch = 51;
        if (cy % 5 === 4) ch += 1;
        if (!validChunks.has(`${cx},${cy}`)) {
          for (let y = 0; y < ch; y++) {
            for (let x = 0; x < cw; x++) {
              const srcIdx = ((ty + y + offsetY) * mapW + (tx + x)) * 3;
              // Apply mask to original buffer as well to avoid getting false positive PoI scans in masked areas
              pixels[srcIdx] = 0;
              pixels[srcIdx + 1] = 0;
              pixels[srcIdx + 2] = 0;
            }
          }
        }
        ty += ch;
      }
      tx += cw;
    }
  }

  function generateStaticTile(biomeName, config, bbox) {
    //const wangFile = config.wangFile;
    // For static tiles, we can just load the image and convert it to the same format as the generated buffers

    const wangData = config.wangData;
    // Generate canvas and buffer
    const buffer = new Uint8Array(wangData.width * (wangData.height + 4) * 3);
    for (let y = 0; y < wangData.height; y++) {
      for (let x = 0; x < wangData.width; x++) {
        // Original data is RGBA, need to convert to canvas format
        const inIdx = (y * wangData.width + x) * 4;
        const outIdxBuffer = ((y + 4) * wangData.width + x) * 3;
        const r = wangData.data[inIdx],
          g = wangData.data[inIdx + 1],
          b = wangData.data[inIdx + 2];
        buffer[outIdxBuffer] = r;
        buffer[outIdxBuffer + 1] = g;
        buffer[outIdxBuffer + 2] = b;
      }
    }

    // Try to make corrected position...
    const div5x = Math.floor(bbox[0] / 5);
    const div5y = Math.floor(bbox[1] / 5);
    const mod5x = bbox[0] % 5;
    const mod5y = bbox[1] % 5;
    const correctedX = div5x * 5 * 512 + mod5x * 51 * 10;
    const correctedY = div5y * 5 * 512 + mod5y * 51 * 10;

    return {
      biomeName: biomeName,
      x: bbox[0] * CHUNK_SIZE,
      y: bbox[1] * CHUNK_SIZE,
      correctedX,
      correctedY,
      w: wangData.width * TILE_SIZE,
      h: wangData.height * TILE_SIZE,
      path: null,
      // Storage for independent PW scanning
      buffer: buffer,
      width: wangData.width,
      mapH: wangData.height,
      tileIndices: null,
      xmax: null,
      ymax: null,
      tileSize: null,
      numHTiles: null,
      numVTiles: null,
      chunkBasePos: { x: bbox[0], y: bbox[1] },
      minX: bbox[0], // TODO: Refactor references to these
      minY: bbox[1],
      validChunks: null, // Not needed for static tiles
      poisByPW: {}, // Initialize PW cache
      pixelSceneRooms: null,
    };
  }

  /**
   * Visual Generation Loop
   * Removed PoI scanning from here. It now stores the raw buffer for later use.
   */
  /** @param {(() => void | Promise<void>) | null} yieldControl */
  async function generateBiomeTiles(
    biomePixels,
    width,
    height,
    biomeConfig,
    worldSeed,
    ngPlus,
    global_extra_rerolls = 0,
    gameMode = "normal",
    yieldControl = null,
  ) {
    const layers = [];

    for (let biomeName of Object.keys(biomeConfig)) {
      const resume = yieldControl?.();
      if (resume) await resume;
      const conf = biomeConfig[biomeName];
      if (!conf.enabled) continue;
      if (!conf.wangFile) {
        if (!fillLayers || !conf.fillMaterial || conf.sceneOnly) continue;
        for (let i = 0; i < biomePixels.length; i++) {
          if (biomePixels[i] !== conf.color) continue;
          layers.push(
            generateFillLayer(
              biomeName,
              conf,
              i % width,
              Math.floor(i / width),
            ),
          );
        }
        continue;
      }

      const offsetY =
        conf.offsetY !== undefined ? conf.offsetY : DEFAULT_OFFSET_Y;
      const { regions, bboxes } = findBiomeRegions(
        biomePixels,
        width,
        height,
        conf.color,
      );

      for (let i = 0; i < regions.length; i++) {
        const resume = yieldControl?.();
        if (resume) await resume;
        if (
          bboxes[i][3] - bboxes[i][1] > 20 &&
          bboxes[i][2] - bboxes[i][0] > 20
        )
          console.log(
            `Generated 20+ chunk region for ${biomeName}: ${bboxes[i][0]},${bboxes[i][1]} to ${bboxes[i][2]},${bboxes[i][3]}`,
          );
        if (!biomeConfig[biomeName].wangFile) continue;
        if (biomeConfig[biomeName].wangFile.includes("static")) {
          // Static tile, just use the image as the whole region
          layers.push(
            generateStaticTile(biomeName, biomeConfig[biomeName], bboxes[i]),
          );
          continue;
        }
        let valid = false;
        let currentRerolls = conf.extraRerolls || 0;
        currentRerolls += global_extra_rerolls; // Global extra rerolls for all biomes
        let attempts = 0;
        let rawResult = null;
        let finalPath = null;

        while (!valid && attempts < MAX_PATHFINDING_ATTEMPTS) {
          const resume = yieldControl?.();
          if (resume) await resume;
          rawResult = generateRawTileBuffer(
            regions[i],
            bboxes[i],
            conf.wangData,
            worldSeed,
            ngPlus,
            currentRerolls,
            biomeName,
            gameMode,
            conf.wangFile,
          );
          if (!rawResult) break;
          let path =
            1 + bboxes[i][3] - bboxes[i][1] > BIOME_PATH_HEIGHT_LIMIT_CHUNKS
              ? []
              : findMinPath(
                  rawResult.buffer,
                  rawResult.width,
                  rawResult.height,
                  rawResult.pathStart,
                );
          if (BYPASS_PATHFINDING && !path) path = [];
          if (path) {
            valid = true;
            finalPath = path;
          } else {
            currentRerolls++;
            attempts++;
          }
        }

        //console.log(`[Generator] ${biomeName} region ${i} (${rawResult.width}x${rawResult.height-4}): ${valid ? 'Valid path found' : 'Failed to find valid path'} after ${attempts} attempts`);

        if (attempts == MAX_PATHFINDING_ATTEMPTS) {
          console.warn(
            `[Generator] Failed to generate valid tile buffer for ${biomeName} after ${MAX_PATHFINDING_ATTEMPTS} attempts`,
          );
          rawResult = generateRawTileBuffer(
            regions[i],
            bboxes[i],
            conf.wangData,
            worldSeed,
            ngPlus,
            currentRerolls,
            biomeName,
            gameMode,
            conf.wangFile,
          );
          valid = true;
          finalPath = [];
        }

        if (valid && rawResult) {
          // After pathfinding, restore blocked rooms
          if (rawResult.pixelSceneRooms && RESTORE_BLOCKED_ROOMS) {
            for (const room of rawResult.pixelSceneRooms) {
              for (let y = room.startY; y <= room.endY; y++) {
                for (let x = room.startX; x <= room.endX; x++) {
                  const idx = (y * rawResult.width + x) * 3;
                  rawResult.buffer[idx] = 0x00;
                  rawResult.buffer[idx + 1] = 0x00;
                  rawResult.buffer[idx + 2] = 0x00;
                }
              }
            }
          }

          // Replace coalmine hack blocked area with air
          if (usesMinesTemplate(conf.wangFile) && gameMode !== "nightmare") {
            undoCoalmineHack(
              rawResult.buffer,
              rawResult.width,
              rawResult.height,
              minesOverlay,
            );
          }

          // Clear path, fill coffee, randomize colors
          applyPostprocessingHacks(
            rawResult.buffer,
            rawResult.width,
            rawResult.height,
            worldSeed,
            ngPlus,
            finalPath,
            conf.randomColors,
          );

          // Extend region (fix for 20+ chunk width/height regions)
          // The final size of the output is 1024 x 1028 (I think) and the first 4 rows are ignored.
          // Then the 1024 part repeats in both directions.
          if (rawResult.width > 1024 || rawResult.height > 1028) {
            console.log(
              `[Generator] Applying extension hack for ${biomeName} region ${i} due to large dimensions (${rawResult.width}x${rawResult.height})`,
            );
            // Only the first 1024x1028 area is actually generated, the rest is empty.
            for (let y = 0; y < rawResult.height; y++) {
              for (let x = 0; x < rawResult.width; x++) {
                if (y < 4) continue; // This part is ignored anyway
                if (x < 1024 && y < 1028) continue; // This part is already generated
                const srcX = x % 1024;
                const srcY = 4 + ((y - 4) % 1024);
                const srcIdx = (srcY * rawResult.width + srcX) * 3;
                const dstIdx = (y * rawResult.width + x) * 3;
                rawResult.buffer[dstIdx] = rawResult.buffer[srcIdx];
                rawResult.buffer[dstIdx + 1] = rawResult.buffer[srcIdx + 1];
                rawResult.buffer[dstIdx + 2] = rawResult.buffer[srcIdx + 2];
              }
            }
          }

          const { minX, minY, width: mapW, mapH: renderH } = rawResult;
          const validChunks = new Set(regions[i].map((p) => `${p[0]},${p[1]}`));

          // Clear only the RGB cells outside the region; no discarded RGBA raster.
          applyMasking(rawResult.buffer, mapW, bboxes[i], validChunks);

          // Try to make corrected position...
          const div5x = Math.floor(bboxes[i][0] / 5);
          const div5y = Math.floor(bboxes[i][1] / 5);
          const mod5x = bboxes[i][0] % 5;
          const mod5y = bboxes[i][1] % 5;
          const correctedX = div5x * 5 * 512 + mod5x * 51 * 10;
          const correctedY = div5y * 5 * 512 + mod5y * 51 * 10;

          // TODO: Clean this up, I have a bunch of old unused/redundant things here
          layers.push({
            biomeName: biomeName,
            x: minX * CHUNK_SIZE,
            y: minY * CHUNK_SIZE,
            correctedX,
            correctedY,
            w: mapW * TILE_SIZE,
            h: renderH * TILE_SIZE,
            path: finalPath
              ? finalPath.map((p) => ({ x: p.x, y: p.y - offsetY }))
              : null,
            // Storage for independent PW scanning
            buffer: rawResult.buffer,
            width: mapW,
            mapH: renderH,
            tileIndices: rawResult.tileIndices,
            xmax: rawResult.xmax,
            ymax: rawResult.ymax,
            tileSize: rawResult.tileSize,
            numHTiles: rawResult.numHTiles,
            numVTiles: rawResult.numVTiles,
            chunkBasePos: { x: minX, y: minY },
            minX, // TODO: Refactor references to these
            minY,
            validChunks,
            poisByPW: {}, // Initialize PW cache
            pixelSceneRooms: rawResult.pixelSceneRooms,
          });
        }
      }
    }

    return layers;
  }

  function generateFillLayer(biomeName, config, cx, cy) {
    const { width, height } = calculateMapDimensions([cx, cy, cx, cy]);
    const correctedX =
      Math.floor(cx / 5) * 5 * CHUNK_SIZE + (cx % 5) * 51 * TILE_SIZE;
    const correctedY =
      Math.floor(cy / 5) * 5 * CHUNK_SIZE + (cy % 5) * 51 * TILE_SIZE;

    return {
      biomeName: biomeName,
      x: cx * CHUNK_SIZE,
      y: cy * CHUNK_SIZE,
      correctedX,
      correctedY,
      w: width * TILE_SIZE,
      h: height * TILE_SIZE,
      path: null,
      // No pixel data: `isFill` plus the biome's fillMaterial is the whole layer.
      buffer: null,
      isFill: true,
      fillMaterial: config.fillMaterial,
      width: width,
      mapH: height,
      tileIndices: null,
      xmax: null,
      ymax: null,
      tileSize: null,
      numHTiles: null,
      numVTiles: null,
      chunkBasePos: { x: cx, y: cy },
      minX: cx,
      minY: cy,
      validChunks: new Set([`${cx},${cy}`]),
      poisByPW: {},
      pixelSceneRooms: null,
    };
  }
  return generateBiomeTiles;
}
