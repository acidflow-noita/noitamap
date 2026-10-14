import { expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createMaterialEdgePlanCompiler, materialEdgePlanKey, openMaterialEdgePlan } from '../src/native-map/prepared-materials/compiler';
import identity from '../src/native-map/prepared-materials/material-edge-plan.json';
import { CoverGrid, lookupCoord, setTopo2WorldOffX, sampleMaterialEdge, wangLookup } from '../lib/noita-telescope-vm/js/engine_resolve/topo2_resolve.js';

const root = new URL('../', import.meta.url);
const bytes = () => readFile(new URL('src/native-map/prepared-materials/material-edge-plan.wasm', root)).then(buffer => Uint8Array.from(buffer));

it('binds the checked-in preparation module to its arithmetic and codec sources', async () => {
  for (const [file, expected] of Object.entries(identity.sources))
    expect(createHash('sha256').update(await readFile(new URL(file, root))).digest('hex'), file).toBe(expected);
  expect(createHash('sha256').update(await bytes()).digest('hex')).toBe(identity.moduleHash);
});

it('prepares independently reusable fields for nine regions, both map widths and local shaft frames', async () => {
  const module = await bytes(), compiler = await createMaterialEdgePlanCompiler(module);
  const oracle: any = (await WebAssembly.instantiate(module)).instance.exports;
  const base = Math.ceil(oracle.heap_base() / 16) * 16;
  const coverage = new Float32Array(oracle.memory.buffer, base, 77), material = new Uint16Array(oracle.memory.buffer, base + 320, 77);
  const output = new Int32Array(oracle.memory.buffer, base + 480, 5);
  const grid = new CoverGrid(7, 11, coverage, material), F = Math.fround;
  oracle.configure(7, 11, base, base + 320, 0, 0, 17920);
  for (let i = 0; i < 77; i++) { coverage[i] = [-1, 0, .5, F(.50000006), 1][i % 5]; material[i] = [0, 1, 2, 65535][i % 4]; }
  const keys = new Set<string>();
  let first: ReturnType<typeof compiler.prepare> | undefined, original: number[] = [];
  for (const worldOffsetX of [17920, 16384]) for (const plane of [-1, 0, 1]) for (const pw of [-1, 0, 1]) {
    setTopo2WorldOffX(worldOffsetX);
    for (const originX of [undefined, 1433.6]) {
      const frame = { worldOffsetX, offsetY: plane * 24576, originX };
      const rectangle = { x: -4032 + pw * worldOffsetX * 2, y: frame.offsetY + 64, width: 32, height: 32 };
      const plan = compiler.prepare(frame, rectangle), field = openMaterialEdgePlan(plan);
      keys.add(materialEdgePlanKey(frame, rectangle));
      if (!first) { first = plan; original = Array.from({ length: field.length }, (_, i) => field.at(i)); }
      for (let i = 0; i < field.length; i++) {
        const x = rectangle.x + i % 32, y = rectangle.y + Math.floor(i / 32);
        const coords = (scale: number) => {
          const c = lookupCoord(scale, x, y);
          if (originX !== undefined) c[0] = F((c[0] - originX) - (Math.floor((x + worldOffsetX) / (worldOffsetX * 2)) * worldOffsetX * 2) / 10);
          c[1] = F(c[1] - frame.offsetY / 10); return c;
        };
        const z = coords(0), c = coords(F(.33));
        oracle.probe_material_edge_plan(...z, ...c, base + 480);
        const alive = sampleMaterialEdge(grid, c[0], c[1]);
        expect(field.at(i)).toBe(output[0]);
        expect(output[1]).toBe(alive);
        expect(output[2]).toBe(alive ? wangLookup(grid, c[0], c[1]) : 0);
      }
    }
  }
  expect(keys.size).toBe(36);
  expect(compiler.scratchBytes).toBeLessThanOrEqual(1024 * 1024);
  // Compiling later rectangles must not overwrite previously returned plans.
  const restored = openMaterialEdgePlan(structuredClone(first!));
  expect(Array.from({ length: restored.length }, (_, i) => restored.at(i))).toEqual(original);
});

it('rejects changed artifacts, revisions and unsupported preparation bounds', async () => {
  const module = await bytes(), corrupt = module.slice(); corrupt[corrupt.length - 1] ^= 1;
  await expect(createMaterialEdgePlanCompiler(corrupt)).rejects.toThrow('identity');
  const compiler = await createMaterialEdgePlanCompiler(module);
  const frame = { worldOffsetX: 17920, offsetY: 0 }, rectangle = { x: 0, y: 0, width: 32, height: 32 };
  expect(() => compiler.prepare(frame, { ...rectangle, width: 641 })).toThrow();
  expect(() => compiler.prepare({ ...frame, offsetY: NaN }, rectangle)).toThrow();
  expect(() => openMaterialEdgePlan({ ...compiler.prepare(frame, rectangle), revision: 'old' })).toThrow('revision');
  expect(materialEdgePlanKey(frame, rectangle)).not.toBe(materialEdgePlanKey({ ...frame, originX: 0 }, rectangle));
});

it('rebinds compact cell masks from current labels, coverage and sampler parameters', async () => {
  const w: any = (await WebAssembly.instantiate(await bytes())).instance.exports;
  const base = Math.ceil(w.heap_base() / 16) * 16;
  const cov = new Float32Array(w.memory.buffer, base, 77);
  const mat = new Uint16Array(w.memory.buffer, base + 320, 77);
  const params = new DataView(w.memory.buffer, base + 512, 20 * 16);
  const ids = new Uint32Array(w.memory.buffer, base + 832, 78);
  const masks = new Uint16Array(w.memory.buffer, base + 1200, 78);
  const F = Math.fround, wrap = (v: number, n: number) => (v % n + n) % n;
  const fractions = [[.75, .875], [.875, .75], [.125, .25], [.25, .125]];
  let state = 0x13abc731;
  const next = () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return state >>> 0; };
  for (const [width, height] of [[7, 11], [1, 1], [2, 3]]) {
    const count = width * height, grid = new CoverGrid(width, height, cov, mat);
    for (let pass = 0; pass < 8; pass++) {
      for (let i = 0; i < count; i++) {
        cov[i] = [-1, 0, F(.49999997), .5, F(.50000006), 1, NaN][next() % 7];
        mat[i] = [0, 1, 2, 18, 65535][next() % 5]; ids[i] = i;
      }
      ids[count] = 0xffffffff; masks.fill(0xffff);
      for (const id of [1, 17]) {
        params.setFloat32(id * 16, pass === 1 ? .28 : F(.33), true);
        params.setFloat32(id * 16 + 4, pass === 2 ? .51 : .5, true);
        params.setInt32(id * 16 + 8, pass === 3 ? 1 : 2, true);
        params.setInt32(id * 16 + 12, pass !== 4 ? 1 : 0, true);
      }
      w.configure(width, height, base, base + 320, base + 512, 20, 17920);
      const bound = w.bind_material_edge_groups(base + 832, count + 1, base + 1200);
      let eligible = 0;
      for (let cell = 0; cell < count; cell++) {
        // Use negative unwrapped coordinates so the oracle independently checks wrapping.
        const bx = cell % width - width, by = Math.floor(cell / width) - height;
        const needed = ![1, 2, 3, 4].includes(pass) && [0, 1, 2, 3].some(corner => {
          const stored = mat[wrap(by + (corner >> 1), height) * width + wrap(bx + (corner & 1), width)];
          return stored === 2 || stored === 18;
        });
        let expected = 0;
        if (needed) {
          eligible++;
          for (let k = 0; k < 16; k++) {
            const [fx, fy] = fractions[k >> 2];
            if (sampleMaterialEdge(grid, F(bx + (k & 1) - .5 + fx), F(by + ((k >> 1) & 1) - .5 + fy)))
              expected |= 1 << k;
          }
        }
        expect(masks[cell], `cell ${cell}, pass ${pass}`).toBe(expected);
      }
      expect(bound).toBe(eligible);
      expect(masks[count]).toBe(0);
    }
  }
  w.configure(0, 0, base, base + 320, base + 512, 20, 17920);
  masks.fill(0xffff);
  expect(w.bind_material_edge_groups(base + 832, 78, base + 1200)).toBe(0);
  expect([...masks].every(mask => mask === 0)).toBe(true);
});
