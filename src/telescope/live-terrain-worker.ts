// @ts-ignore upstream JavaScript
import { buildTerrainCpuResources, dropPaletteClosure, terrainCpuResourceBuffers } from 'noita-telescope-full-pixels/gl/terrain_cpu_resources.js';
// @ts-ignore upstream JavaScript
import { GENERATOR_CONFIG } from 'noita-telescope-full-pixels/generator_config.js';
import { createPlaneOwnership } from './terrain-policy';
import { findLiquidSurfaces } from './liquid-surfaces';
import { packHostTerrainTable } from './live-terrain-resources';

self.onmessage = ({ data: { generation, options, liquidIds } }) => {
  try {
    const cpu = buildTerrainCpuResources(generation.tileLayers, generation.biomeData, {
      ...options, seed: generation.seed, isNGP: generation.isNGP,
      gameMode: generation.gameMode, generatorConfig: GENERATOR_CONFIG,
    });
    const ownership = createPlaneOwnership(generation.tileLayers, generation.biomeData.pixels,
      generation.biomeData.pixels, GENERATOR_CONFIG, cpu.mapWidth);
    const surfaces = findLiquidSurfaces(cpu.engine.lattice, new Set<number>(liquidIds), cpu.mapWidth);
    const packed = packHostTerrainTable(cpu.engTable, ownership, surfaces);
    cpu.engTable = packed.table;
    (self as unknown as DedicatedWorkerGlobalScope).postMessage({ cpu: dropPaletteClosure(cpu), hostTable: packed.base }, terrainCpuResourceBuffers(cpu));
  } catch (error) {
    self.postMessage({ error: String(error) });
  }
};

// Imports above perform asynchronous asset loads. The page must not send the
// generation until this handler exists: messages during module evaluation can
// otherwise be dispatched with no listener and silently lost.
self.postMessage({ type: 'ready' });
