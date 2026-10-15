/// <reference types="@webgpu/types" />
import type { NativeAssets } from '../../asset-host';
import type { WorldRequest, NativeWorldDescription } from '../../world';
import type { CaveStateBinding } from '../../game-state';
import type { CompletedGpuMap } from '../completed-map-read';
import type { EncodedGpuSurface } from '../pixel-storage-gpu';
import { createWorldInputFactory, type WorldPage } from './inputs';
import { createCertifiedMaterialEngine, prepareCertifiedMaterialSetup } from '../materials/certified-engine';
import { createGpuScenePreparer, type RawSceneRecord } from '../scenes/scene-compute';
import { createBatchedGpuEdgeEngine } from '../edge-batch-compute.mjs';
import { createBatchedGpuComposition } from '../batch-composition';
import { createGpuComposition, packCompositionAssets, packCompositionPage } from '../composition-compute';
import { createGpuPixelStorage } from '../pixel-storage-gpu';
import { createGpuMipAtlas } from '../mip-atlas';
import { createGpuCoarseMap } from '../coarse-map';

export interface CompleteMapRequest extends WorldRequest { generationState?: CaveStateBinding }
export interface CompleteMapProgress {
  stage: 'preparing' | 'initializing' | 'cooking' | 'finishing' | 'complete';
  completedPages: number; totalPages: number; elapsedMs: number;
}
export interface CompleteMapRuntimeOptions {
  device: GPUDevice; assets: NativeAssets; materialModule: WebAssembly.Module;
  edgeModule: WebAssembly.Module; correctionModule: WebAssembly.Module;
}
export interface CompleteMapGrid { columns: number; rows: number; x: number; y: number; pageSize: number }
export interface CompleteMapResult {
  world: NativeWorldDescription; map: CompletedGpuMap; grid: CompleteMapGrid;
  timings: Record<string, number | Record<string, number>>;
  memory: { retainedBytes: number; coarseBytes: number; peakWorkingBytes: number; peakTotalGpuBytes: number;
    inputs: Record<string, number> };
}
type Inputs = Awaited<ReturnType<Awaited<ReturnType<typeof createWorldInputFactory>>['prepare']>>;
type MaterialEngine = Awaited<ReturnType<typeof createCertifiedMaterialEngine>>;
type MaterialJob = Awaited<ReturnType<MaterialEngine['resolvePage']>>;
type CoarseMap = Awaited<ReturnType<typeof createGpuCoarseMap>>;

function requestSnapshot(request: CompleteMapRequest): CompleteMapRequest {
  if (!Number.isInteger(request.seed) || request.seed < 0 || request.seed > 0xffffffff)
    throw new RangeError('Seed must be an unsigned 32-bit integer');
  if ((request.ngPlus ?? 0) !== 0 || (request.gameMode ?? 'normal') !== 'normal')
    throw new RangeError('The completed native map currently supports normal NG0 worlds');
  if (request.parallelWorlds && (request.parallelWorlds.length !== 3 || [-1, 0, 1].some(v => !request.parallelWorlds!.includes(v))))
    throw new RangeError('The completed native map requires all nine regions');
  if (request.unlocks != null && (!Array.isArray(request.unlocks) || request.unlocks.some(value => typeof value !== 'string')))
    throw new TypeError('Invalid world unlocks');
  const now = new Date(), calendar = request.calendar ? { ...request.calendar } : { month: now.getMonth() + 1, day: now.getDate() };
  if (!Number.isInteger(calendar.month) || calendar.month < 1 || calendar.month > 12 ||
      !Number.isInteger(calendar.day) || calendar.day < 1 || calendar.day > 31)
    throw new RangeError('Invalid seasonal calendar');
  return { ...request, ngPlus: 0, gameMode: 'normal', parallelWorlds: [-1, 0, 1],
    unlocks: request.unlocks?.slice() ?? request.unlocks, calendar };
}
function sameBytes(left: Uint8Array, right: Uint8Array) {
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i++) if (left[i] !== right[i]) return false;
  return true;
}

/** Worker-owned executor for all nine completed regions. Only a fully completed
 * map is returned. Starting another request retires the previous map after a
 * GPU fence; callers must stop presenting that map before the next generate().
 * Original assets/pipelines survive seed changes. No seed-history cache exists. */
export async function createCompleteMapRuntime(options: CompleteMapRuntimeOptions) {
  const { device, assets, correctionModule } = options, setupAt = performance.now();
  const factory = await createWorldInputFactory({ ...options,
    yieldControl: () => new Promise<void>(resolve => setTimeout(resolve, 0)) });
  try { await prepareCertifiedMaterialSetup(device); } catch (error) { factory.dispose(); throw error; }
  const initializationMs = performance.now() - setupAt;
  let composition: Awaited<ReturnType<typeof createGpuComposition>> | undefined;
  let batchComposition: Awaited<ReturnType<typeof createBatchedGpuComposition>> | undefined;
  let edges: Awaited<ReturnType<typeof createBatchedGpuEdgeEngine>> | undefined;
  let codec: Awaited<ReturnType<typeof createGpuPixelStorage>> | undefined;
  let packer: Awaited<ReturnType<typeof createGpuMipAtlas>> | undefined;
  let sceneEngine: Awaited<ReturnType<typeof createGpuScenePreparer>> | undefined;
  let materialCount = 0, disposed = false, queue: Promise<unknown> = Promise.resolve();
  let active: AbortController | undefined, disposal: Promise<void> | undefined;
  let current: { atlases: EncodedGpuSurface[]; coarse: CoarseMap } | undefined;
  const fence = () => device.queue.onSubmittedWorkDone();

  async function initializeGpu(input: Inputs) {
    if (composition && batchComposition && edges && codec && packer && sceneEngine) return;
    const packed = packCompositionAssets({ atlas: input.atlas, backgroundTextures: input.backgroundTextures, scenes: [] });
    materialCount = packed.materialCount;
    const settled = await Promise.allSettled([
      createGpuComposition(device, packed).then(value => { composition = value; }),
      createBatchedGpuComposition(device, packed).then(value => { batchComposition = value; }),
      createBatchedGpuEdgeEngine(device, input.edgeResources).then(value => { edges = value; }),
      createGpuPixelStorage(device).then(value => { codec = value; }),
      createGpuMipAtlas(device).then(value => { packer = value; }),
      createGpuScenePreparer(device, input.sceneResources, input.sceneBandResolver,
        { materialCount, edgeMaterialTable: input.edgeResources.tables.materialTable }).then(value => { sceneEngine = value; }),
    ]);
    const failed = settled.find(value => value.status === 'rejected');
    if (failed?.status === 'rejected') { await fence().catch(() => {}); releaseShared(); throw failed.reason; }
    if (edges!.maxPages < 1) { await fence().catch(() => {}); releaseShared(); throw new Error('Device cannot fit one complete native page'); }
  }
  function releaseShared() {
    composition?.dispose(); composition = undefined;
    batchComposition?.destroy(); batchComposition = undefined;
    edges?.destroy(); edges = undefined; sceneEngine?.destroy(); sceneEngine = undefined;
    // Storage/atlas engines retain pipelines only, and own no buffer allocation.
    codec = undefined; packer = undefined;
  }
  async function retireCurrent() {
    await fence();
    if (current) { current.atlases.forEach(atlas => atlas.destroy()); current.coarse.destroy(); current = undefined; }
  }

  async function generate(request: CompleteMapRequest, signal: AbortSignal,
    onProgress?: (progress: CompleteMapProgress) => void): Promise<CompleteMapResult> {
    const began = performance.now(); signal.throwIfAborted();
    const scratch = new Set<() => void>();
    const track = (release: () => void) => { scratch.add(release); return () => { if (scratch.delete(release)) release(); }; };
    let input: Inputs | undefined, materialEngine: MaterialEngine | undefined, coarse: CoarseMap | undefined;
    const retained: EncodedGpuSurface[] = [];
    let published = false, done = 0, lastProgress = -Infinity;
    const progress = (stage: CompleteMapProgress['stage'], force = false) => {
      const now = performance.now();
      if (force || now - lastProgress >= 100) { lastProgress = now; onProgress?.({ stage, completedPages: done, totalPages: 30240, elapsedMs: now - began }); }
    };
    const check = () => { signal.throwIfAborted(); if (disposed) throw new Error('Completed map runtime disposed'); };
    const timings = { retirementMs: 0, inputPreparationMs: 0, gpuInitializationMs: 0, backgroundGroupingMs: 0,
      sourceAndSceneMs: 0, materialInitializationMs: 0, materialReadyMs: 0, pageInputsMs: 0,
      commandMs: 0, finishMs: 0, storageMs: 0, upperMipsMs: 0 };
    let retainedBytes = 0, peakWorkingBytes = 0, peakTotalGpuBytes = 0;
    try {
      await retireCurrent(); timings.retirementMs = performance.now() - began; check(); progress('preparing', true);
      let t = performance.now();
      input = await factory.prepare(request.seed, { preparedSceneBytes: 0, generationState: request.generationState,
        unlocks: request.unlocks, dailySeed: request.dailySeed, calendar: request.calendar, signal });
      timings.inputPreparationMs = performance.now() - t; check(); progress('initializing', true);
      t = performance.now(); await initializeGpu(input); check();
      coarse = await createGpuCoarseMap(device, input.grid.columns, input.grid.rows, 6);
      timings.gpuInitializationMs = performance.now() - t;
      const manifest = new Uint32Array(input.pages.length); manifest.fill(0xffffffff);
      const zeros = input.pages.filter(page => input!.policies[page.id].kind === 'zero');
      const procedural = input.pages.filter(page => input!.policies[page.id].kind === 'procedural');
      type BackgroundGroup = { page: WorldPage; inputs: Awaited<ReturnType<Inputs['pageInputs']>>; aliases: WorldPage[] };
      const backgroundGroups = new Map<string, BackgroundGroup[]>(), backgroundList: BackgroundGroup[] = [];
      t = performance.now();
      for (const page of input.pages) {
        if (input.policies[page.id].kind !== 'background-only') continue;
        check(); const data = await input.pageInputs(page, undefined, { prepareScenes: false });
        const texture = input.backgroundTextures[data.backgroundIndex - 1], mod = (v: number, n: number) => ((v % n) + n) % n;
        const key = `${data.backgroundIndex}/${mod(page.x + data.backgroundPhase.x, texture.width)}/${mod(page.y + data.backgroundPhase.y, texture.height)}`;
        let candidates = backgroundGroups.get(key);
        if (!candidates) { candidates = []; backgroundGroups.set(key, candidates); }
        // Exact comparison replaces the fixture's Node SHA256 grouping key.
        // Only final ordinary cutouts affect an unowned background-only page.
        const found = candidates.find(group => sameBytes(group.inputs.ordinaryMask, data.ordinaryMask));
        if (found) found.aliases.push(page);
        else { const group = { page, inputs: data, aliases: [] }; candidates.push(group); backgroundList.push(group); }
      }
      timings.backgroundGroupingMs = performance.now() - t;
      const work = [...procedural, ...backgroundList.map(group => group.page)];
      const backgroundByID = new Map(backgroundList.map(group => [group.page.id, group]));
      for (const page of zeros) manifest[page.id] = 0;
      done = zeros.length; progress('cooking', true);
      const sharedBytes = () => composition!.sharedBytes + batchComposition!.sharedBytes + edges!.initialization.resourceBytes +
        sceneEngine!.initialization.sharedGpuBytes + sceneEngine!.sourceCache.residentBytes +
        (materialEngine?.initialization.gpu.resourceBytes ?? 0) + coarse!.buffer.size;
      let currentPlane: number | undefined;
      for (let start = 0; start < work.length;) {
        check();
        const group: WorldPage[] = [], sceneIDs = new Set<number>(); let sourcePixels = 0;
        for (let at = start; at < work.length && group.length < 24; at++) {
          const page = work[at]; if (group.length && page.vertical !== group[0].vertical) break;
          const fresh = input.policies[page.id].sceneIDs.filter(id => !sceneIDs.has(id));
          const added = fresh.reduce((n, id) => { const record = input!.sceneRecords[id];
            return n + record.placement.width * record.placement.height + (record.right - record.placement.x) * (record.bottom - record.placement.y); }, 0);
          if (group.length && sourcePixels + added > 2 * 1024 * 1024) break;
          group.push(page); fresh.forEach(id => sceneIDs.add(id)); sourcePixels += added;
        }
        if (!group.length) throw new Error('Empty complete-map batch'); start += group.length;
        if (group.some(page => input!.policies[page.id].kind === 'procedural') && currentPlane !== group[0].vertical) {
          t = performance.now(); materialEngine?.destroy(); materialEngine = undefined;
          materialEngine = await createCertifiedMaterialEngine(device, input.materialInputs.get(group[0].vertical)!,
            { correctionModule, legacy: input.legacyForPlane(group[0].vertical) });
          currentPlane = group[0].vertical; timings.materialInitializationMs += performance.now() - t; check();
        }
        t = performance.now(); const ordered = [...sceneIDs].sort((a, b) => a - b), raw: RawSceneRecord[] = [];
        for (const id of ordered) {
          check(); const { record, source } = await input.sceneSource(id);
          raw.push({ placement: record.placement, source, airBackgroundIndex: record.airBackgroundIndex, order: record.order,
            sourceKey: `${assets.revision}/${record.placement.key}/${+record.layers.mid}${+record.layers.visual}${+record.layers.background}` });
        }
        const sceneBatch = raw.length ? await sceneEngine!.prepare(raw) : null;
        const releaseScene = sceneBatch ? track(() => sceneBatch.destroy()) : () => {};
        timings.sourceAndSceneMs += performance.now() - t; check();
        const sceneBytes = sceneBatch ? sceneBatch.compositionBuffer.size + sceneBatch.edgeBuffer.size : 0;
        if (sceneBatch) {
          const sceneWorking = sceneBytes + sceneBatch.stats.temporaryGpuBytes;
          peakWorkingBytes = Math.max(peakWorkingBytes, sceneWorking);
          peakTotalGpuBytes = Math.max(peakTotalGpuBytes, sharedBytes() + sceneWorking + retainedBytes);
        }
        const localIDs = new Map(ordered.map((id, index) => [id, index]));
        const layouts = { scenes: raw.map(record => ({ prepared: { ...record.placement, backgroundArt: record.source.backgroundArt } })) };
        const batchSize = Math.min(8, edges!.maxPages);
        for (let offset = 0; offset < group.length; offset += batchSize) {
          check(); const pages = group.slice(offset, offset + batchSize), encoder = device.createCommandEncoder();
          const releaseBatch: Array<() => void> = [];
          t = performance.now();
          const resolved = await Promise.allSettled(pages.map(async page => {
            if (input!.policies[page.id].kind !== 'procedural') return null;
            const job = await materialEngine!.resolvePage(page, { legacy: input!.policies[page.id].ownsTerrain });
            releaseBatch.push(track(() => job.destroy())); return job;
          }));
          const materialFailure = resolved.find(result => result.status === 'rejected');
          if (materialFailure?.status === 'rejected') throw materialFailure.reason;
          const materials = resolved.map(result => (result as PromiseFulfilledResult<MaterialJob | null>).value);
          timings.materialReadyMs += performance.now() - t; check();
          const jobs: Array<{ page: WorldPage; material: MaterialJob | null; packed: ReturnType<typeof packCompositionPage>; edgeInput: any; aliases: WorldPage[] }> = [];
          let workingBytes = sceneBytes;
          for (let pageIndex = 0; pageIndex < pages.length; pageIndex++) {
            const page = pages[pageIndex], material = materials[pageIndex]; t = performance.now();
            const data = backgroundByID.get(page.id)?.inputs ?? await input.pageInputs(page,
              (x, y, width) => materialEngine!.resolveExactRect(x, y, width, 1), { prepareScenes: false });
            timings.pageInputsMs += performance.now() - t; check(); t = performance.now();
            const ids = data.globalSceneIDs.map(id => localIDs.get(id)!);
            if (ids.some(id => id === undefined)) throw new Error('Incomplete scene batch');
            const packed = packCompositionPage(layouts, { ...data, sceneIDs: ids }, materialCount);
            const edgeInput = { width: 576, height: 576, x: data.x, y: data.y, seed: request.seed, inset: 32,
              chunkShiftX: data.chunkShiftX, chunkShiftY: data.chunkShiftY, skipSeamAt: data.skipSeamAt,
              scenes: ids.map(id => { const record = sceneBatch!.records[id]; return { ...record.placement, skipEdges: record.skipEdges,
                gpu: { buffer: sceneBatch!.edgeBuffer, edgeOffset: record.edgeOffset, edgeEligibilityOffset: record.edgeEligibilityOffset } }; }) };
            workingBytes += material ? material.stats.outputBytes + material.stats.axesBytes + 64 : 0;
            jobs.push({ page, material, packed, edgeInput, aliases: backgroundByID.get(page.id)?.aliases ?? [] });
            timings.commandMs += performance.now() - t;
          }
          t = performance.now();
          const pixelCount = 576 * 576, size = pixelCount * pages.length * 4;
          const usage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST;
          const originals = device.createBuffer({ size, usage }); releaseBatch.push(track(() => originals.destroy()));
          const legacyColors = jobs.some(job => job.material?.legacyColorBuffer) ? device.createBuffer({ size, usage }) : undefined;
          if (legacyColors) releaseBatch.push(track(() => legacyColors.destroy()));
          jobs.forEach((job, i) => {
            if (!job.material) return;
            encoder.copyBufferToBuffer(job.material.materialBuffer, 0, originals, i * pixelCount * 4, pixelCount * 4);
            if (job.material.legacyColorBuffer) encoder.copyBufferToBuffer(job.material.legacyColorBuffer, 0, legacyColors!, i * pixelCount * 4, pixelCount * 4);
          });
          const edge = edges!.encodeBatch(encoder, { pages: jobs.map((job, i) => ({ ...job.edgeInput, materialBuffer: originals, materialOffsetWords: i * pixelCount })) });
          releaseBatch.push(track(() => edge.destroy()));
          const output = batchComposition!.encode(encoder, jobs.map(job => job.packed), {
            materials: originals, edges: edge.rgbaBuffer, scenes: sceneBatch?.compositionBuffer, legacy: legacyColors,
            materialOffsets: edge.pages.map((page: any) => page.pixelOffsetWords), hasLegacy: jobs.map(job => !!job.material?.legacyColorBuffer),
          });
          releaseBatch.push(track(() => { output.disposeInputs(); output.buffer.destroy(); }));
          workingBytes += originals.size + (legacyColors?.size ?? 0) + edge.stats.ownedBufferBytes + output.buffer.size + output.temporaryBytes;
          const overview = coarse.encodePages(encoder, output.buffer, jobs.flatMap((job, i) => [job.page, ...job.aliases].map(page => ({
            sourceWordOffset: output.pages[i].wordOffset + output.layout.levels[coarse!.pageLevel].wordOffset,
            column: page.gridColumn, row: page.gridRow,
          }))));
          releaseBatch.push(track(() => overview.disposeInputs())); workingBytes += overview.temporaryBytes;
          const atlasJobs: Array<{ atlas: ReturnType<NonNullable<typeof packer>['encode']>; jobs: typeof jobs; release: () => void }> = [];
          for (let i = 0; i < jobs.length; i += 3) {
            const chunk = jobs.slice(i, i + 3), atlas = packer!.encode(encoder, chunk.map(() => output.buffer), chunk.map((_, local) => output.pages[i + local].wordOffset));
            workingBytes += atlas.atlasBytes + atlas.uniformBytes;
            atlasJobs.push({ atlas, jobs: chunk, release: track(() => { atlas.disposeInputs(); atlas.destroy(); }) });
          }
          timings.commandMs += performance.now() - t;
          t = performance.now(); device.queue.submit([encoder.finish()]); await fence(); timings.finishMs += performance.now() - t;
          releaseBatch.forEach(release => release()); check();
          t = performance.now();
          const encoded = await Promise.allSettled(atlasJobs.map(job => codec!.encode(job.atlas.buffer, 1024, 1024)));
          const firstAtlas = retained.length;
          // Own every successful result even if another concurrent encode fails.
          encoded.forEach(result => { if (result.status === 'fulfilled') retained.push(result.value); });
          const encodeFailure = encoded.find(result => result.status === 'rejected');
          if (encodeFailure?.status === 'rejected') throw encodeFailure.reason;
          const stored = encoded.map(result => (result as PromiseFulfilledResult<EncodedGpuSurface>).value);
          timings.storageMs += performance.now() - t; check();
          const materialPeak = sceneBytes + materials.reduce((sum, material) => sum + (material ? material.stats.outputBytes + material.stats.axesBytes + 64 +
            Math.max(material.stats.correctionReadbackBytes, material.stats.patchUploadBytes + 32, material.stats.legacy?.peakTemporaryGpuBytes ?? 0) : 0), 0);
          const storagePeak = sceneBytes + atlasJobs.reduce((sum, job, i) => sum + job.atlas.atlasBytes + job.atlas.uniformBytes + stored[i].stats.planningBytes, 0);
          for (let i = 0; i < atlasJobs.length; i++) {
            retainedBytes += stored[i].stats.retainedAllocatedBytes;
            atlasJobs[i].jobs.forEach((job, local) => {
              for (const page of [job.page, ...job.aliases]) {
                if (manifest[page.id] !== 0xffffffff) throw new Error('Page completed twice');
                manifest[page.id] = (firstAtlas + i + 1) * 4 + local; done++;
              }
            });
            atlasJobs[i].release();
          }
          const peak = Math.max(workingBytes, materialPeak, storagePeak);
          peakWorkingBytes = Math.max(peakWorkingBytes, peak);
          peakTotalGpuBytes = Math.max(peakTotalGpuBytes, sharedBytes() + peak + retainedBytes);
        }
        releaseScene(); progress('cooking');
      }
      if (done !== input.pages.length || manifest.some(slot => slot === 0xffffffff)) throw new Error('Incomplete all-nine map');
      check(); progress('finishing', true); t = performance.now();
      const encoder = device.createCommandEncoder(), upper = composition!.reduceInPlace(encoder, coarse.buffer, coarse.width, coarse.height);
      const releaseUpper = track(() => upper.disposeInputs()); device.queue.submit([encoder.finish()]); await fence(); releaseUpper();
      timings.upperMipsMs = performance.now() - t; check();
      const slots = new Uint32Array(manifest.length);
      for (const page of input.pages) slots[page.gridRow * input.grid.columns + page.gridColumn] = manifest[page.id];
      const map: CompletedGpuMap = { complete: true, columns: input.grid.columns, rows: input.grid.rows, slots, atlases: retained,
        coarse: { buffer: coarse.buffer, width: coarse.width, height: coarse.height, pageLevel: coarse.pageLevel, layout: coarse.layout } };
      const result: CompleteMapResult = { world: input.world, map, grid: { ...input.grid },
        timings: { ...timings, preparation: { ...input.stages }, initializationMs, totalMs: performance.now() - began },
        memory: { retainedBytes, coarseBytes: coarse.buffer.size, peakWorkingBytes, peakTotalGpuBytes, inputs: { ...input.memory } } };
      progress('complete', true); check(); current = { atlases: retained, coarse }; published = true;
      return result;
    } finally {
      // An abort can arrive between GPU submission and an await. Never destroy
      // a source, scratch buffer or unfinished result while queued work uses it.
      // Successful publication already followed the final overview fence. Keep
      // its last abort check, publication and return in the same event-loop turn.
      if (!published) await fence().catch(() => {});
      for (const release of scratch) release(); scratch.clear();
      materialEngine?.destroy(); input?.dispose();
      if (!published) { retained.forEach(atlas => atlas.destroy()); coarse?.destroy(); }
    }
  }

  return {
    initializationMs,
    generate(request: CompleteMapRequest, { signal, onProgress }: { signal?: AbortSignal; onProgress?: (progress: CompleteMapProgress) => void } = {}): Promise<CompleteMapResult> {
      if (disposed) return Promise.reject(new Error('Completed map runtime disposed'));
      let snapshot: CompleteMapRequest;
      try { snapshot = requestSnapshot(request); signal?.throwIfAborted(); } catch (error) { return Promise.reject(error); }
      active?.abort(new DOMException('Superseded by another map request', 'AbortError'));
      const controller = new AbortController(); active = controller;
      const abort = () => controller.abort(signal?.reason); signal?.addEventListener('abort', abort, { once: true });
      const work = queue.then(() => generate(snapshot, controller.signal, onProgress));
      queue = work.catch(() => {});
      return work.finally(() => { signal?.removeEventListener('abort', abort); if (active === controller) active = undefined; });
    },
    dispose(): Promise<void> {
      if (disposal) return disposal;
      disposed = true; active?.abort(new DOMException('Completed map runtime disposed', 'AbortError'));
      disposal = (async () => { await queue; await fence().catch(() => {});
        if (current) { current.atlases.forEach(atlas => atlas.destroy()); current.coarse.destroy(); current = undefined; }
        releaseShared(); factory.dispose(); })();
      return disposal;
    },
  };
}
