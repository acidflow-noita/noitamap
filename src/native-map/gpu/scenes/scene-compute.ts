/// <reference types="@webgpu/types" />
// Exact original-art GPU scene preparation. See PROVENANCE.txt.
import type { NativeScenePlacement, NativeSceneSource, NativeScenePreparationResources } from '../../composition/prepare-scenes';
import type { MaterialCoveragePoint } from '../../complete-materials';
import { materialAlpha } from '../../cook-inputs/atlas';
import { CLASSIC, CUSTOM } from '../materials/noise-tables.mjs';
import { makeBandAxes, packMaterialTables } from '../materials/material-compute.mjs';
import { readBuffer, uploadBuffer } from '../buffers';
import { sceneShader, patchShader } from './scene-shader.mjs';

export type SceneResources = Omit<NativeScenePreparationResources, 'bands'>;
export interface RawSceneRecord {
  placement: NativeScenePlacement; source: NativeSceneSource; airBackgroundIndex: number; order?: number;
  /** Trusted immutable asset revision/key/layer policy. Allows original art
   * reuse after a source loader evicts and decodes a new byte-array object. */
  sourceKey?: string;
}
export interface ResidentSceneRecord extends RawSceneRecord {
  pixelOffset: number; flagOffset: number; edgeOffset: number; bandOffset: number;
  /** Word offset of the exact whole-scene flag when edgeMaterialTable supplied. */
  edgeEligibilityOffset?: number;
  hasArt: boolean; skipEdges: boolean; colorBiome: number; gridBiome: number;
  grayBandPixels: number;
}
export interface ExactSceneBands { resolveCoverageBandPoints(points: readonly MaterialCoveragePoint[]): Int32Array }
class Words {
  size = 0; chunks: Uint32Array[] = [];
  add(chunk: Uint32Array) { const at = this.size; this.chunks.push(chunk); this.size += chunk.length; return at; }
  reserve(words: number) { const at = this.size; this.size += words; return at; }
  finish() { const out = new Uint32Array(this.size); let at = 0; for (const chunk of this.chunks) { out.set(chunk, at); at += chunk.length; } return out; }
}
function rgbaWords(bytes: Uint8Array | Uint8ClampedArray) { const copy = Uint8Array.from(bytes); return new Uint32Array(copy.buffer); }
function validImage(image: { width: number; height: number; data: Uint8Array | Uint8ClampedArray }, label: string) {
  if (![image.width, image.height].every(n => Number.isSafeInteger(n) && n > 0) || image.data.length !== image.width * image.height * 4)
    throw Error(`Invalid GPU scene ${label}`);
}

interface CachedImage { buffer: GPUBuffer; bytes: number; key?: string; pinned: boolean; destroyed: boolean }
/** Bounded original-image resources only. It stores no positions, variants,
 * recolored pixels, seed decisions, or material query results. */
function createSourceCache(device: GPUDevice, limit: number) {
  if (!Number.isSafeInteger(limit) || limit < 0) throw Error('Invalid GPU source cache budget');
  const identity = new WeakMap<object, CachedImage>(), named = new Map<string, CachedImage>(), lru = new Map<CachedImage, null>();
  let bytes = 0, peakBytes = 0, uploads = 0, uploadedBytes = 0, hits = 0, evictions = 0;
  function retire(entry: CachedImage) {
    if (entry.pinned) throw Error('Cannot retire an active source image');
    entry.destroyed = true; entry.buffer.destroy(); lru.delete(entry); bytes -= entry.bytes;
    if (entry.key !== undefined) named.delete(entry.key); evictions++;
  }
  return {
    acquire(data: Uint8Array | Uint8ClampedArray, key: string | undefined, pinned: Set<CachedImage>, temporary: GPUBuffer[]) {
      let entry = key === undefined ? identity.get(data) : named.get(key);
      if (entry && !entry.destroyed) {
        if (entry.bytes !== data.byteLength) throw Error('Immutable scene source identity changed dimensions');
        entry.pinned = true; pinned.add(entry); lru.delete(entry); lru.set(entry, null); hits++; return entry.buffer;
      }
      const size = data.byteLength;
      for (const candidate of lru.keys()) { if (bytes + size <= limit) break; if (!candidate.pinned) retire(candidate); }
      const buffer = uploadBuffer(device, data, GPUBufferUsage.COPY_SRC); uploads++; uploadedBytes += size;
      if (size > limit || bytes + size > limit) { temporary.push(buffer); return buffer; }
      entry = { buffer, bytes: size, key, pinned: true, destroyed: false }; pinned.add(entry); lru.set(entry, null);
      if (key === undefined) identity.set(data, entry); else named.set(key, entry);
      bytes += size; peakBytes = Math.max(peakBytes, bytes); return buffer;
    },
    release(pinned: Set<CachedImage>) { for (const entry of pinned) entry.pinned = false; },
    snapshot() { return { limitBytes: limit, residentBytes: bytes, peakBytes, images: lru.size, uploads, uploadedBytes, hits, evictions }; },
    destroy() { for (const entry of lru.keys()) { entry.pinned = false; retire(entry); } },
  };
}

function packRecipes(resources: SceneResources, edgeMaterialTable?: Int32Array) {
  const { atlas } = resources, recipeWords: number[] = [0, 0, 0, 0], recipeByName = new Map<string, number>();
  const displayColor = (name: string) => { const wang = parseInt(atlas.materialWangColors[name], 16) & 0xffffff; return atlas.materialColorConversion[wang] ?? wang; };
  const addRecipe = (entry: number, flat: number, alpha: number, targetFallback = false) => {
    const id = recipeWords.length / 4; recipeWords.push(entry, flat, alpha, +targetFallback); return id;
  };
  const namedRecipe = (name: string) => {
    let id = recipeByName.get(name); if (id !== undefined) return id;
    const known = atlas.materialWangColors[name] !== undefined;
    id = addRecipe(atlas.entryByMaterial.get(name) ?? 0, known ? displayColor(name) : 0, known ? materialAlpha(atlas, name) : 255, !known);
    recipeByName.set(name, id); return id;
  };
  const byMaterial = Uint32Array.from(resources.materialNames, name => name ? namedRecipe(name) : 0);
  for (const name of [...Object.values(resources.fillBiomeMaterials), ...Object.values(resources.fillLayerMaterials)]) namedRecipe(name);
  const wangNames = new Map(Object.entries(atlas.materialColorLookup).map(([hex, name]) => [parseInt(hex, 16) & 0xffffff, name]));
  const wangIDs = new Map(resources.wangMaterialIds), colors = new Set([...wangNames.keys(), ...wangIDs.keys(), ...Object.keys(atlas.materialColorConversion).map(Number)]);
  const lookup: number[] = [];
  for (const color of [...colors].sort((a, b) => a - b)) {
    const name = wangNames.get(color), recipe = name ? namedRecipe(name) : addRecipe(0, atlas.materialColorConversion[color] ?? color, 255);
    lookup.push(color, recipe, wangIDs.get(color) ?? 0x7ffe, 0);
  }
  const words = new Words(), header = new Uint32Array(16); words.add(header);
  header[0] = words.add(Uint32Array.from(lookup)); header[1] = colors.size;
  header[2] = words.add(byMaterial); header[3] = byMaterial.length;
  header[4] = words.add(Uint32Array.from(atlas.meta)); header[5] = words.add(rgbaWords(atlas.data)); header[6] = atlas.width;
  header[7] = words.add(Uint32Array.from(recipeWords));
  if (edgeMaterialTable) {
    if (!(edgeMaterialTable instanceof Int32Array) || !edgeMaterialTable.length || edgeMaterialTable.length % 3)
      throw Error('Invalid scene edge material table');
    const counts = Uint32Array.from({ length: edgeMaterialTable.length / 3 }, (_, id) => +(edgeMaterialTable[id * 3 + 1] > 0));
    header[8] = words.add(counts); header[9] = counts.length;
  }
  return { data: words.finish(), recipeByName, displayColor };
}

const pipelineCache = new WeakMap<GPUDevice, Promise<{ layout: GPUBindGroupLayout; band: GPUComputePipeline; prepare: GPUComputePipeline; flags: GPUComputePipeline; patch: GPUComputePipeline }>>();
function pipelines(device: GPUDevice) {
  let ready = pipelineCache.get(device); if (ready) return ready;
  ready = (async () => {
    const shader = device.createShaderModule({ code: sceneShader, label: 'runtime original-art scene preparation' });
    const info = await shader.getCompilationInfo();
    if (info.messages.some(m => m.type === 'error')) throw Error(info.messages.map(m => `${m.lineNum}:${m.linePos} ${m.message}`).join('\n'));
    const layout = device.createBindGroupLayout({ entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: 128 } },
      ...[1, 2, 3, 4].map(binding => ({ binding, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' as const } })),
      ...[5, 6, 7, 8].map(binding => ({ binding, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' as const } })),
    ] });
    const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [layout] });
    const [band, prepare, flags, patch] = await Promise.all([
      ...['select_bands', 'prepare', 'pack_flags'].map(entryPoint => device.createComputePipelineAsync({ layout: pipelineLayout, compute: { module: shader, entryPoint } })),
      device.createComputePipelineAsync({ layout: 'auto', compute: { module: device.createShaderModule({ code: patchShader }), entryPoint: 'apply_patches' } }),
    ]);
    return { layout, band, prepare, flags, patch };
  })(); pipelineCache.set(device, ready); return ready;
}

/** Original source art and small instance recipes only. Completion includes the
 * compact exact band repair; dense scene pixels never cross back to the CPU. */
export async function createGpuScenePreparer(device: GPUDevice, resources: SceneResources,
  exact: ExactSceneBands, options: { materialCount?: number; sourceCacheBytes?: number; edgeMaterialTable?: Int32Array } = {}) {
  const started = performance.now(), { data: recipeData, recipeByName, displayColor } = packRecipes(resources, options.edgeMaterialTable), tables = packMaterialTables([], CLASSIC, CUSTOM);
  const code = await pipelines(device), recipes = uploadBuffer(device, recipeData), table = uploadBuffer(device, tables.data);
  const sourceCache = createSourceCache(device, options.sourceCacheBytes ?? 32 * 1024 * 1024);
  const engineByColor = new Map(resources.engineBiomes.map((b, id) => [b.color & 0xffffff, id]));
  const materialIDs = new Map(resources.materialNames.map((name, id) => [name, id]));
  const histograms = new WeakMap<object, Map<number, number>>();
  const materialCount = options.materialCount ?? resources.atlas.materialTable.length / 4;
  let disposed = false, active = false;
  const initialization = { totalMs: performance.now() - started, sharedGpuBytes: recipes.size + table.size };
  function histogram(source: NativeSceneSource) {
    let result = histograms.get(source.data); if (result) return result;
    result = new Map(); const d = source.data;
    for (let p = 0; p < d.length; p += 4) {
      const color = ((d[p + 3] << 24) | (d[p] << 16) | (d[p + 1] << 8) | d[p + 2]) >>> 0;
      result.set(color, (result.get(color) ?? 0) + 1);
    }
    histograms.set(source.data, result); return result;
  }
  function instance(record: RawSceneRecord) {
    const { placement: p, source } = record; validImage(source, p.key);
    if (p.width !== source.width || p.height !== source.height || ![p.x, p.y, p.width, p.height].every(Number.isSafeInteger) ||
      Math.abs(p.x) + p.width + 17920 >= 2 ** 24 || Math.abs(p.y) + p.height + 7168 >= 2 ** 24)
      throw Error('Scene placement exceeds the certified coordinate range');
    if (source.visualArt) validImage(source.visualArt, 'visual art'); if (source.backgroundArt) validImage(source.backgroundArt, 'background art');
    let biome = p.key.split('/')[0]; const replacements: number[] = [];
    for (const part of (p.variantKey ?? '').split('&')) {
      const eq = part.indexOf('='); if (eq < 0) continue;
      if (part.slice(0, eq) === 'biome') biome = part.slice(eq + 1);
      else replacements.push(parseInt(part.slice(0, eq), 16) & 0xffffff, parseInt(part.slice(eq + 1), 16) & 0xffffff);
    }
    const at = biome.indexOf('@'), target = at < 0 ? biome : biome.slice(0, at), under = at < 0 ? null : biome.slice(at + 1);
    const colors = [target, under], grids = biome.split('@');
    const fill = (name: string | null, map: Readonly<Record<number, string>>) => {
      const config = name ? resources.generatorConfig[name] : undefined; return config ? map[config.color & 0xffffff] : undefined;
    };
    const fillColor = (name: string | null, map: Readonly<Record<number, string>>) => { const value = fill(name, map); return value === undefined ? undefined : displayColor(value); };
    const densityBiome = (names: readonly (string | null)[]) => {
      for (const name of names) { const config = name ? resources.generatorConfig[name] : undefined, id = config ? engineByColor.get(config.color & 0xffffff) : undefined;
        if (id !== undefined && resources.engineBiomes[id].bands.length) return id; }
      return -1;
    };
    const colorBiome = densityBiome(colors), gridBiome = densityBiome(grids);
    const targetColor = fillColor(target, resources.fillBiomeMaterials) ?? resources.biomeForegroundColors[target] ??
      (under ? fillColor(under, resources.fillBiomeMaterials) ?? resources.biomeForegroundColors[under] : undefined) ?? 0xff00ff;
    let backgroundColor = resources.biomeBackgroundColors[target] ?? (under ? resources.biomeBackgroundColors[under] : undefined) ?? 0;
    const underlyingFill = under && fillColor(under, resources.fillLayerMaterials) !== undefined ? under : null;
    const layer = fillColor(underlyingFill ?? target, resources.fillLayerMaterials);
    if (layer !== undefined && Math.max(...[16, 8, 0].map(shift => Math.abs(((backgroundColor >>> shift) & 255) - ((layer >>> shift) & 255)))) <= 24)
      backgroundColor = (Math.round(((layer >>> 16) & 255) * .45) << 16) | (Math.round(((layer >>> 8) & 255) * .45) << 8) | Math.round((layer & 255) * .45);
    const fillName = colors.map(n => fill(n, resources.fillBiomeMaterials)).find(n => n !== undefined);
    const gridFillName = grids.map(n => fill(n, resources.fillBiomeMaterials)).find(n => n !== undefined);
    let grayBandPixels = 0;
    if (colorBiome >= 0 || gridBiome >= 0) for (const [rgba, count] of histogram(source)) {
      if (!(rgba >>> 24)) continue; let rgb = rgba & 0xffffff;
      for (let i = 0; i < replacements.length; i += 2) if (rgb === replacements[i]) rgb = replacements[i + 1];
      const r = rgb >>> 16; if (r > 0 && r === ((rgb >>> 8) & 255) && r === (rgb & 255)) grayBandPixels += count;
    }
    return { replacements, colorBiome, gridBiome, targetColor, backgroundColor, grayBandPixels,
      fillRecipe: fillName === undefined ? 0 : recipeByName.get(fillName)!,
      gridFill: gridFillName === undefined ? 0x7ffe : materialIDs.get(gridFillName) ?? 0x7ffe };
  }
  return {
    initialization,
    get sourceCache() { return sourceCache.snapshot(); },
    async prepare(input: readonly RawSceneRecord[]) {
      if (disposed) throw Error('GPU scene preparer disposed'); if (active) throw Error('Prepare one bounded GPU scene batch at a time');
      active = true; const pinned = new Set<CachedImage>(), temporaryImages: GPUBuffer[] = [];
      try {
      const begin = performance.now(), cacheBefore = sourceCache.snapshot();
      const sources = new Words(), axes = new Words(), shape = new Words(), descriptors = new Uint32Array(input.length * 16); shape.reserve(descriptors.length);
      const imageOffsets = new Map<object | string, number>(), backgrounds = new Map<object | string, { sourceAt: number; outputAt: number; words: number }>();
      const sourceCopies: Array<{ buffer: GPUBuffer; offset: number; bytes: number }> = [], replacementSpans: Array<{ offset: number; data: Uint32Array }> = [];
      const appendImage = (data: Uint8Array | Uint8ClampedArray, key?: string) => {
        const identity = key ?? data; let at = imageOffsets.get(identity);
        if (at === undefined) {
          at = sources.reserve(data.byteLength / 4); imageOffsets.set(identity, at);
          sourceCopies.push({ buffer: sourceCache.acquire(data, key, pinned, temporaryImages), offset: at * 4, bytes: data.byteLength });
        }
        return at;
      };
      const stride = Math.ceil(128 / device.limits.minUniformBufferOffsetAlignment) * device.limits.minUniformBufferOffsetAlignment;
      const uniforms = new Uint32Array(Math.max(stride / 4, input.length * stride / 4)), records: ResidentSceneRecord[] = [], bandRecords: ResidentSceneRecord[] = [];
      const eligibilityWords = options.edgeMaterialTable ? input.length : 0;
      let edgeWords = eligibilityWords, bandPixels = 0, correctionCapacity = 0, axisFamilies = 0;
      for (let id = 0; id < input.length; id++) {
        const record = input[id], p = record.placement, s = record.source, detail = instance(record), count = p.width * p.height;
        const imageKey = (kind: string, width: number, height: number) => record.sourceKey === undefined ? undefined : `${record.sourceKey}/${kind}/${width}/${height}`;
        const sourceAt = appendImage(s.data, imageKey('instructions', s.width, s.height));
        const artAt = s.visualArt ? appendImage(s.visualArt.data, imageKey('visual', s.visualArt.width, s.visualArt.height)) : 0;
        const replacementAt = sources.reserve(detail.replacements.length), pixelOffset = shape.reserve(count), flagOffset = shape.reserve(Math.ceil(count / 16));
        if (detail.replacements.length) replacementSpans.push({ offset: replacementAt * 4, data: Uint32Array.from(detail.replacements) });
        const bandOffset = bandPixels, edgeOffset = edgeWords; edgeWords += count; correctionCapacity += detail.grayBandPixels;
        const resident = { placement: p, source: s, order: record.order, sourceKey: record.sourceKey, airBackgroundIndex: record.airBackgroundIndex,
          pixelOffset, flagOffset, edgeOffset, bandOffset, hasArt: !!s.visualArt, skipEdges: !!s.skipEdgeTextures,
          edgeEligibilityOffset: options.edgeMaterialTable ? id : undefined,
          colorBiome: detail.colorBiome, gridBiome: detail.gridBiome, grayBandPixels: detail.grayBandPixels };
        records.push(resident);
        let xAt = 0, yAt = 0, bandAt = 0;
        if (detail.grayBandPixels) {
          bandPixels += count; bandRecords.push(resident);
          const values = makeBandAxes(tables, new Set([detail.colorBiome, detail.gridBiome].filter(v => v >= 0)), p, axes.size);
          axes.add(values.data); xAt = values.xAt; yAt = values.yAt; bandAt = values.bandAt; axisFamilies += values.axisFamilies;
        }
        descriptors.set([p.x, p.y, p.width, p.height, pixelOffset, flagOffset], id * 16);
        if (s.backgroundArt) {
          const bg = s.backgroundArt, key = imageKey('background', bg.width, bg.height); let packed = backgrounds.get(key ?? bg.data);
          if (!packed) { packed = { sourceAt: appendImage(bg.data, key), outputAt: shape.reserve(bg.width * bg.height), words: bg.width * bg.height }; backgrounds.set(key ?? bg.data, packed); }
          descriptors.set([packed.outputAt, bg.width, bg.height], id * 16 + 6);
        }
        descriptors[id * 16 + 9] = materialCount + record.airBackgroundIndex;
        uniforms.set([p.width, p.height, p.x, p.y, sourceAt, artAt, s.visualArt?.width ?? 0, s.visualArt?.height ?? 0,
          replacementAt, detail.replacements.length / 2, detail.colorBiome, detail.gridBiome, detail.fillRecipe, detail.targetColor,
          detail.backgroundColor, detail.gridFill, pixelOffset, flagOffset, edgeOffset, bandOffset, xAt, yAt, bandAt, count,
          +!!s.visualArt, 0, id, +!!detail.grayBandPixels, +!!options.edgeMaterialTable, id, 0, 0], id * stride / 4);
      }
      for (let id = 0; id < input.length; id++) uniforms[id * stride / 4 + 25] = correctionCapacity;
      const axisWords = axes.finish(), sourceBytes = sources.size * 4;
      const sizes = [sourceBytes, axisWords.byteLength, shape.size * 4, edgeWords * 4, bandPixels * 8, 16 + correctionCapacity * 8];
      if (sizes.some(size => size > device.limits.maxStorageBufferBindingSize)) throw Error('Scene batch exceeds a GPU storage binding; split at scene boundaries');
      const own: GPUBuffer[] = [], keep = (buffer: GPUBuffer) => (own.push(buffer), buffer);
      const allocate = (size: number, label: string) => device.createBuffer({ size: Math.max(4, size), label, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC });
      const uniformBuffer = keep(uploadBuffer(device, uniforms, GPUBufferUsage.UNIFORM)), sourceBuffer = keep(allocate(sourceBytes, 'original scene image batch')), axisBuffer = keep(uploadBuffer(device, axisWords));
      for (const span of replacementSpans) device.queue.writeBuffer(sourceBuffer, span.offset, span.data.buffer as ArrayBuffer, span.data.byteOffset, span.data.byteLength);
      const bandBuffer = keep(allocate(bandPixels * 8, 'scene certified band IDs')), correctionBuffer = keep(allocate(16 + correctionCapacity * 8, 'scene compact band corrections'));
      const compositionBuffer = allocate(shape.size * 4, 'prepared scene composition'), edgeBuffer = allocate(edgeWords * 4, 'prepared scene edge and source flags');
      const all = [uniformBuffer, sourceBuffer, recipes, table, axisBuffer, bandBuffer, correctionBuffer, compositionBuffer, edgeBuffer];
      const group = device.createBindGroup({ layout: code.layout, entries: all.map((buffer, binding) => ({ binding, resource: { buffer, ...(binding === 0 ? { size: 128 } : {}) } })) });
      const encodeAt = performance.now();
      let bandDispatchMs = 0, correctionReadbackMs = 0, exactCorrectionMs = 0, patchUploadMs = 0, prepareDispatchMs = 0, corrected = 0, correctionQueries = 0;
      const reasons: Record<string, number> = {};
      try {
        if (descriptors.byteLength) device.queue.writeBuffer(compositionBuffer, 0, descriptors);
        const bandEncoder = device.createCommandEncoder();
        for (const copy of sourceCopies) bandEncoder.copyBufferToBuffer(copy.buffer, 0, sourceBuffer, copy.offset, copy.bytes);
        for (const bg of backgrounds.values()) bandEncoder.copyBufferToBuffer(sourceBuffer, bg.sourceAt * 4, compositionBuffer, bg.outputAt * 4, bg.words * 4);
        if (bandRecords.length) {
          const pass = bandEncoder.beginComputePass(); pass.setPipeline(code.band);
          for (let id = 0; id < records.length; id++) { const r = records[id]; if (!r.grayBandPixels) continue;
            pass.setBindGroup(0, group, [id * stride]); pass.dispatchWorkgroups(Math.ceil(r.placement.width / 8), Math.ceil(r.placement.height / 8)); }
          pass.end();
        }
        let at = performance.now(); device.queue.submit([bandEncoder.finish()]); await device.queue.onSubmittedWorkDone(); bandDispatchMs = performance.now() - at;
        if (bandRecords.length) {
          at = performance.now(); const header = new Uint32Array((await readBuffer(device, correctionBuffer, 16)).buffer);
          if (header[1] || header[0] > correctionCapacity) throw Error('Scene band correction list overflow'); corrected = header[0];
          if (corrected) {
            const list = new Uint32Array((await readBuffer(device, correctionBuffer, corrected * 8, 16)).buffer);
            correctionReadbackMs = performance.now() - at; at = performance.now();
            const patches = new Int32Array(corrected * 4), points: MaterialCoveragePoint[] = [], destinations: Array<[number, number]> = [];
            const flush = () => { if (!points.length) return; const values = exact.resolveCoverageBandPoints(points);
              if (!(values instanceof Int32Array) || values.length !== points.length || values.some(id => id < -1 || id > 0x7fff)) throw Error('Invalid exact GPU scene band correction');
              values.forEach((id, i) => { const [first, second] = destinations[i]; patches[first] = id; if (second >= 0) patches[second] = id; });
              correctionQueries += points.length; points.length = 0; destinations.length = 0;
            };
            for (let i = 0; i < corrected; i++) {
              const index = list[i * 2], reason = list[i * 2 + 1]; reasons[reason] = (reasons[reason] ?? 0) + 1;
              let lo = 0, hi = bandRecords.length; while (lo + 1 < hi) { const mid = (lo + hi) >> 1; if (bandRecords[mid].bandOffset <= index) lo = mid; else hi = mid; }
              const r = bandRecords[lo], p = r.placement, local = index - r.bandOffset;
              if (local >= p.width * p.height) throw Error('Invalid scene correction address');
              patches.set([index, -1, -1, reason], i * 4);
              const enqueue = (biomeId: number, first: number, second = -1) => { if (biomeId < 0) return;
                points.push({ biomeId, x: p.x + local % p.width, y: p.y + Math.floor(local / p.width), coverage: 1 }); destinations.push([first, second]); if (points.length === 4096) flush(); };
              if (r.colorBiome === r.gridBiome) enqueue(r.colorBiome, i * 4 + 1, i * 4 + 2);
              else { enqueue(r.colorBiome, i * 4 + 1); enqueue(r.gridBiome, i * 4 + 2); }
            }
            flush(); exactCorrectionMs = performance.now() - at; at = performance.now();
            const patchBuffer = keep(uploadBuffer(device, patches)), params = keep(uploadBuffer(device, Uint32Array.of(corrected, 0, 0, 0), GPUBufferUsage.UNIFORM));
            const patchGroup = device.createBindGroup({ layout: code.patch.getBindGroupLayout(0), entries: [params, patchBuffer, bandBuffer].map((buffer, binding) => ({ binding, resource: { buffer } })) });
            const encoder = device.createCommandEncoder(), pass = encoder.beginComputePass(); pass.setPipeline(code.patch); pass.setBindGroup(0, patchGroup); pass.dispatchWorkgroups(Math.ceil(corrected / 64)); pass.end();
            device.queue.submit([encoder.finish()]); patchUploadMs = performance.now() - at;
          } else correctionReadbackMs = performance.now() - at;
        }
        const finishEncoder = device.createCommandEncoder();
        if (records.length) {
          const pass = finishEncoder.beginComputePass(); pass.setPipeline(code.prepare);
          for (let id = 0; id < records.length; id++) { const p = records[id].placement; pass.setBindGroup(0, group, [id * stride]); pass.dispatchWorkgroups(Math.ceil(p.width / 8), Math.ceil(p.height / 8)); } pass.end();
          const flags = finishEncoder.beginComputePass(); flags.setPipeline(code.flags);
          for (let id = 0; id < records.length; id++) { const p = records[id].placement; flags.setBindGroup(0, group, [id * stride]); flags.dispatchWorkgroups(Math.ceil(p.width * p.height / 1024)); } flags.end();
        }
        at = performance.now(); device.queue.submit([finishEncoder.finish()]); await device.queue.onSubmittedWorkDone(); prepareDispatchMs = performance.now() - at;
        const temporaryGpuBytes = [...own, ...temporaryImages].reduce((sum, b) => sum + b.size, 0); for (const buffer of own) buffer.destroy();
        const cacheAfter = sourceCache.snapshot(), replacementUploadBytes = replacementSpans.reduce((sum, span) => sum + span.data.byteLength, 0);
        const stats = { scenes: input.length, pixels: edgeWords - eligibilityWords, edgeEligibilityBytes: eligibilityWords * 4,
          uniqueImages: imageOffsets.size, bandScenes: bandRecords.length, grayBandPixels: correctionCapacity,
          accepted: correctionCapacity - corrected, corrected, correctionQueries, reasons,
          sourceUploadBytes: cacheAfter.uploadedBytes - cacheBefore.uploadedBytes, sourceCopyBytes: sourceCopies.reduce((sum, value) => sum + value.bytes, 0), replacementUploadBytes,
          sourceCacheHits: cacheAfter.hits - cacheBefore.hits, sourceCacheMisses: cacheAfter.uploads - cacheBefore.uploads,
          sourceCacheEvictions: cacheAfter.evictions - cacheBefore.evictions, sourceCacheResidentBytes: cacheAfter.residentBytes, sourceCacheLimitBytes: cacheAfter.limitBytes, axesBytes: axisWords.byteLength,
          axisFamilies, correctionReadbackBytes: bandRecords.length ? 16 + corrected * 8 : 0, patchUploadBytes: corrected * 16,
          outputGpuBytes: compositionBuffer.size + edgeBuffer.size, temporaryGpuBytes, cpuMetadataAndUploadMs: encodeAt - begin,
          bandDispatchMs, correctionReadbackMs, exactCorrectionMs, patchUploadMs, prepareDispatchMs, totalMs: performance.now() - begin, ready: true };
        let destroyed = false;
        return { compositionBuffer, edgeBuffer, records, descriptors, stats,
          destroy() { if (!destroyed) { destroyed = true; compositionBuffer.destroy(); edgeBuffer.destroy(); } } };
      } catch (error) { for (const buffer of own) buffer.destroy(); compositionBuffer.destroy(); edgeBuffer.destroy(); throw error; }
      } finally { sourceCache.release(pinned); for (const buffer of temporaryImages) buffer.destroy(); active = false; }
    },
    destroy() { if (active) throw Error('Wait for scene preparation before disposing its resources'); if (!disposed) { disposed = true; sourceCache.destroy(); recipes.destroy(); table.destroy(); } },
  };
}
