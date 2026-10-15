// Derived from the owned Lymm Telescope edge core (MIT).
// See FINISHING.txt and LICENSE-telescope.txt for provenance and scope.
import { edgeShader } from './edge-shader.mjs';

const SIDE = 640, PAGE_WORDS = 20;
// A separate bounded copy pass keeps the ordered edge kernel at the portable
// eight-storage-binding limit. No scene grid or eligibility returns to CPU.
const sceneCopyShader = /* wgsl */ `
struct Clip {
  source_at:u32, source_width:u32, source_x:u32, source_y:u32,
  width:u32, height:u32, target_at:u32, source_eligible:u32,
  target_eligible:u32, unused0:u32, unused1:u32, unused2:u32,
};
@group(0) @binding(0) var<uniform> p:Clip;
@group(0) @binding(1) var<storage,read> source:array<u32>;
@group(0) @binding(2) var<storage,read_write> clipped:array<u32>;
@compute @workgroup_size(8,8)
fn copy_scene(@builtin(global_invocation_id) gid:vec3u) {
  if(gid.x==0u && gid.y==0u){clipped[p.target_eligible]=source[p.source_eligible];}
  if(gid.x>=p.width || gid.y>=p.height){return;}
  clipped[p.target_at+gid.y*p.width+gid.x]=source[p.source_at+(p.source_y+gid.y)*p.source_width+p.source_x+gid.x];
}
`;
const checkedInteger = (n, lo, hi) => Number.isSafeInteger(n) && n >= lo && n <= hi;
const byteView = data => new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
function upload(device, data, usage, label) {
  const buffer = device.createBuffer({ label, size: Math.max(4, Math.ceil(data.byteLength / 4) * 4), usage: usage | GPUBufferUsage.COPY_DST });
  if (data.byteLength) device.queue.writeBuffer(buffer, 0, data);
  return buffer;
}

/** Local half-open seam intervals, without enumerating pixels or shifting the
 * edge sampler's local coordinate system. */
function seamIntervals(origin, first, end) {
  const intervals = [];
  for (let boundary = Math.floor((origin + first) / 512) * 512 - 512; boundary < origin + end + 512; boundary += 512) {
    const left = Math.max(first, boundary - 8 - origin), right = Math.min(end, boundary + 8 - origin);
    if (right > left) intervals.push([left, right]);
  }
  return intervals;
}

function seamRectangles(originX, originY, left, top, right, bottom) {
  if (right <= left || bottom <= top) return [];
  const xs = seamIntervals(originX, left, right), ys = seamIntervals(originY, top, bottom), rectangles = [];
  for (const [y0, y1] of ys) rectangles.push([left, y0, right - left, y1 - y0]);
  let start = top;
  for (const [y0, y1] of [...ys, [bottom, bottom]]) {
    if (y0 > start) for (const [x0, x1] of xs) rectangles.push([x0, start, x1 - x0, y0 - start]);
    start = y1;
  }
  return rectangles;
}

/** Exact CPU work is fixed by runtime Math + supplied immutable source tables.
 * No generated seed, material grid, frame or scene is used here. */
export function prepareGpuEdgeTables({ tables: t, atlas, atlasWidth }) {
  if (!t || !checkedInteger(t.materialCount, 1, 1024) || !checkedInteger(t.entryCount, 0, 256) ||
      !checkedInteger(t.imageCount, 0, 512) || !checkedInteger(atlasWidth, 1, 262144) ||
      !(atlas instanceof Uint8Array) || atlas.length < 4 || atlas.length > 1048576 || atlas.length % (atlasWidth * 4))
    throw Error('Unsupported GPU edge resources');
  for (const [value, length] of [[t.materialTable, t.materialCount * 3], [t.entryTable, t.entryCount * 7], [t.imageTable, t.imageCount * 7]])
    if (!(value instanceof Int32Array) || value.length !== length) throw Error('Invalid GPU edge integer tables');
  for (const [value, length] of [[t.entryPercent, t.entryCount], [t.rayOx, 16], [t.rayOy, 16], [t.normalAngles, 65536]])
    if (!(value instanceof Float64Array) || value.length !== length || value.some(x => !Number.isFinite(x))) throw Error('Invalid GPU edge float tables');
  if (!(t.imageIndices instanceof Int32Array) || t.imageIndices.length > 4096 || t.imageIndices.some(x => x < 0 || x >= t.imageCount)) throw Error('Invalid GPU edge image indices');
  let maxEntries = 1, reach = 0;
  for (let id = 0; id < t.materialCount; id++) {
    const first = t.materialTable[id * 3], count = t.materialTable[id * 3 + 1];
    if (first < 0 || count < 0 || first + count > t.entryCount) throw Error('Invalid GPU material entry span');
    maxEntries = Math.max(maxEntries, count);
  }
  const entries = new Uint32Array(t.entryCount * 9);
  for (let id = 0; id < t.entryCount; id++) {
    const kind = t.entryTable[id * 7], first = t.entryTable[id * 7 + 5], count = t.entryTable[id * 7 + 6];
    if (first < 0 || count < 0 || first + count > t.imageIndices.length || (kind >= 1 && kind <= 3 && !count)) throw Error('Invalid GPU edge entry images');
    entries.set(t.entryTable.subarray(id * 7, id * 7 + 7), id * 9);
    // hash / 2^32 is exact binary64. Multiplication by 2^32 is a power-of-two
    // exponent shift, so floor yields the exact inclusive integer threshold.
    const percent = t.entryPercent[id];
    entries[id * 9 + 7] = percent >= 1 ? 0xffffffff : percent < 0 ? 0 : Math.min(0xffffffff, Math.floor(percent * 4294967296));
    entries[id * 9 + 8] = percent < 0 ? 1 : 0;
  }
  const atlasHeight = atlas.length / (atlasWidth * 4);
  for (let id = 0; id < t.imageCount; id++) {
    const at = id * 7, x = t.imageTable[at], y = t.imageTable[at + 1], width = t.imageTable[at + 2], height = t.imageTable[at + 3], flags = t.imageTable[at + 6];
    if (x < 0 || y < 0 || width < 1 || height < 1 || x + width > atlasWidth || y + height > atlasHeight) throw Error('GPU edge image is outside supplied atlas');
    reach = Math.max(reach, flags & 2 ? height >> 1 : flags & 4 ? width >> 1 : Math.max(width >> 1, height >> 1));
  }
  const samplesX = new Int32Array(SIDE * 64), samplesY = new Int32Array(SIDE * 64), angles = new Int32Array(65536);
  for (let c = 0; c < SIDE; c++) for (let ray = 0; ray < 16; ray++) for (let step = 1; step < 5; step++) {
    // Preserve local-coordinate addition before floor, including cardinal-ray
    // floating residuals. A translated floor(offset) table is not equivalent.
    const sx = Math.floor(c + (t.rayOx[ray] / 5) * step), sy = Math.floor(c + (t.rayOy[ray] / 5) * step);
    if (!checkedInteger(sx, -32768, 32767) || !checkedInteger(sy, -32768, 32767)) throw Error('GPU ray lookup exceeds the owned core int16 range');
    samplesX[c * 64 + ray * 4 + step - 1] = sx;
    samplesY[c * 64 + ray * 4 + step - 1] = sy;
  }
  for (let i = 0; i < angles.length; i++) {
    if (Math.abs(t.normalAngles[i]) > 0x3fffffff) throw Error('Invalid GPU edge angle range');
    // Every image-angle endpoint and stripe-shift cutoff is integral. Flooring
    // preserves all ordered comparisons with these endpoints exactly.
    angles[i] = Math.floor(t.normalAngles[i]);
  }
  const fields = [t.materialTable, entries, t.imageIndices, t.imageTable, angles, samplesX, samplesY, atlas];
  const header = new Uint32Array(16); header.set([t.materialCount, t.entryCount, t.imageCount, atlasWidth, maxEntries]);
  let word = header.length;
  for (let i = 0; i < fields.length; i++) { header[5 + i] = word; word += fields[i].byteLength / 4; }
  const data = new Uint32Array(word); data.set(header);
  for (let i = 0; i < fields.length; i++) new Uint8Array(data.buffer, header[5 + i] * 4, fields[i].byteLength).set(byteView(fields[i]));
  return { data, maxEntries, stampReach: 1 + reach, materialCount: t.materialCount, materialTable: t.materialTable.slice() };
}

/** Native/Dawn and browser WebGPU share this entry. It owns immutable GPU
 * tables/pipelines. encodePage only records compute; the caller submits and
 * consumes returned buffers, then calls destroy after the GPU fence. */
export async function createGpuEdgeEngine(device, resources) {
  const began = performance.now(), prepared = prepareGpuEdgeTables(resources), prepareMs = performance.now() - began;
  const shader = device.createShaderModule({ label: 'deterministic ordered edge compute', code: edgeShader });
  const compilation = await shader.getCompilationInfo();
  const errors = compilation.messages.filter(m => m.type === 'error');
  if (errors.length) throw Error(errors.map(m => `${m.lineNum}:${m.linePos} ${m.message}`).join('\n'));
  const layoutEntries = [
    { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: PAGE_WORDS * 4 } },
    { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
    ...[2, 3, 4, 5, 6].map(binding => ({ binding, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } })),
    { binding: 7, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
    { binding: 8, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
  ];
  const layout = device.createBindGroupLayout({ entries: layoutEntries });
  // The indirect argument buffer must not remain bound as writable storage in
  // the dispatch that consumes it. Resolve has no argument-buffer binding.
  const resolveLayout = device.createBindGroupLayout({ entries: layoutEntries.slice(0, 8) });
  const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [layout] });
  const resolvePipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [resolveLayout] });
  const compileAt = performance.now();
  const pipelineNames = ['prepare_phase', 'mutate_only', 'scatter', 'resolve_winners'];
  const pipelines = Object.fromEntries(await Promise.all(pipelineNames.map(async name => [name, await device.createComputePipelineAsync({ label: `edges:${name}`, layout: name === 'resolve_winners' ? resolvePipelineLayout : pipelineLayout, compute: { module: shader, entryPoint: name } })])));
  const clipLayout = device.createBindGroupLayout({ entries: [
    { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: 48 } },
    { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
    { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
  ] });
  const clipPipeline = await device.createComputePipelineAsync({ label: 'edges:copy resident scene clips',
    layout: device.createPipelineLayout({ bindGroupLayouts: [clipLayout] }),
    compute: { module: device.createShaderModule({ code: sceneCopyShader }), entryPoint: 'copy_scene' } });
  const pipelineMs = performance.now() - compileAt;
  const tableBuffer = upload(device, prepared.data, GPUBufferUsage.STORAGE, 'immutable edge tables');
  let destroyed = false;
  return {
    stampReach: prepared.stampReach,
    initialization: { prepareMs, pipelineMs, totalMs: performance.now() - began, resourceBytes: prepared.data.byteLength, maxEntries: prepared.maxEntries },
    encodePage(encoder, input) {
      if (destroyed) throw Error('GPU edge engine is disposed');
      const started = performance.now();
      const { width, height, x, y, seed, materialBuffer } = input;
      const shiftX = input.chunkShiftX ?? 0, shiftY = input.chunkShiftY ?? 0, inset = input.inset ?? 0;
      const scenes = input.scenes ?? [], skipSeamAt = input.skipSeamAt;
      if (![width, height].every(v => checkedInteger(v, 1, SIDE)) || ![x, y].every(v => checkedInteger(v, -0x3fffefff, 0x3fffefff)) ||
          !checkedInteger(seed, -Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER) || ![shiftX, shiftY].every(v => checkedInteger(v, -511, 511)) ||
          !checkedInteger(inset, -640, 640) || !Array.isArray(scenes) || typeof skipSeamAt !== 'function') throw Error('Unsupported GPU edge page');
      const count = width * height;
      if (!materialBuffer && (!(input.materials instanceof Int16Array) || input.materials.length !== count)) throw Error('Missing GPU edge material input');
      if (materialBuffer && input.materials) throw Error('Supply one GPU edge material input');
      const margin = Math.max(1, inset - prepared.stampReach), phaseData = [], updates = [{ at: 0, data: new Uint32Array(16) }], gpuClips = [];
      const endX = Math.max(margin, width - margin), endY = Math.max(margin, height - margin);
      const generationCandidates = (endX - margin) * (endY - margin);
      const rectangles = seamRectangles(x + shiftX, y + shiftY, margin, margin, endX, endY);
      const seamRecords = new Uint32Array(1 + rectangles.length * 5); seamRecords[0] = rectangles.length;
      let seamCandidates = 0;
      rectangles.forEach((rectangle, i) => {
        seamCandidates += rectangle[2] * rectangle[3]; seamRecords.set([...rectangle, seamCandidates], 1 + i * 5);
      });
      updates.push({ at: 16, data: seamRecords });
      const baseX = Math.floor((x + shiftX) / 512), baseY = Math.floor((y + shiftY) / 512);
      for (let cy = baseY; cy <= Math.floor((y + height - 1 + shiftY) / 512); cy++) for (let cx = baseX; cx <= Math.floor((x + width - 1 + shiftX) / 512); cx++) {
        const skip = skipSeamAt(cx, cy); if (typeof skip !== 'boolean') throw Error('Unresolved GPU edge seam policy');
        updates[0].data[(cy - baseY) * 4 + cx - baseX] = +skip;
      }
      const base = [width, height, x, y, seed >>> 0, shiftX, shiftY, margin];
      phaseData.push({ words: [...base, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0], paint: true, candidates: generationCandidates });
      phaseData.push({ words: [...base, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 16], paint: true, candidates: seamCandidates });
      let updateWords = 16 + seamRecords.length;
      for (const scene of scenes) {
        const n = scene.width * scene.height, resident = scene.gpu;
        if (![scene.x, scene.y].every(v => checkedInteger(v, -0x3fffefff, 0x3fffefff)) ||
            ![scene.width, scene.height].every(v => checkedInteger(v, 0, 0x3fffefff)) || !Number.isSafeInteger(n)) throw Error('Unsupported GPU edge scene');
        if (resident) {
          if (scene.grid || scene.artMask || !resident.buffer || !(resident.buffer.usage & GPUBufferUsage.STORAGE) ||
              !checkedInteger(resident.edgeOffset, 0, 0xffffffff) || !checkedInteger(resident.edgeEligibilityOffset, 0, 0xffffffff) ||
              (resident.edgeOffset + n) * 4 > resident.buffer.size || (resident.edgeEligibilityOffset + 1) * 4 > resident.buffer.size)
            throw Error('Invalid resident GPU edge scene');
          if (resident.buffer === materialBuffer) throw Error('GPU edge scene aliases material input');
        } else {
          if (!(scene.grid instanceof Int16Array) || scene.grid.length !== n ||
              (scene.artMask && (!(scene.artMask instanceof Uint8Array) || scene.artMask.length !== Math.ceil(n / 8)))) throw Error('Unsupported GPU edge scene');
          if (input.materials && (scene.grid.buffer === input.materials.buffer || scene.artMask?.buffer === input.materials.buffer)) throw Error('GPU edge scene aliases material input');
        }
        const bx = scene.x - x, by = scene.y - y, left = Math.max(0, bx), top = Math.max(0, by), right = Math.min(width, bx + scene.width), bottom = Math.min(height, by + scene.height);
        const cw = right - left, ch = bottom - top; if (cw <= 0 || ch <= 0) continue;
        let eligible = resident ? 2 : scene.edgeEligible;
        if (!resident && eligible === undefined) {
          eligible = false;
          for (let i = 0; i < n; i++) { const id = scene.grid[i]; if (id > 0 && id < prepared.materialCount && prepared.materialTable[id * 3 + 1] && !(scene.artMask && scene.artMask[i >> 3] & (0x80 >> (i & 7)))) { eligible = true; break; } }
        }
        eligible = scene.skipEdges ? 0 : resident ? 2 : +!!eligible;
        let eligibleAt = 0;
        if (resident) {
          eligibleAt = updateWords++;
          gpuClips.push({ buffer: resident.buffer, words: [resident.edgeOffset, scene.width, left - bx, top - by,
            cw, ch, updateWords, resident.edgeEligibilityOffset, eligibleAt, 0, 0, 0] });
        } else {
          const values = new Uint32Array(cw * ch);
          for (let row = 0; row < ch; row++) for (let col = 0; col < cw; col++) {
            const p = (top - by + row) * scene.width + left - bx + col;
            values[row * cw + col] = (scene.grid[p] & 65535) | ((scene.artMask && scene.artMask[p >> 3] & (0x80 >> (p & 7))) ? 65536 : 0);
          }
          updates.push({ at: updateWords, data: values });
        }
        const candidateWidth = Math.max(0, Math.min(endX, bx + scene.width - 1) - Math.max(margin, bx + 1));
        const candidateHeight = Math.max(0, Math.min(endY, by + scene.height - 1) - Math.max(margin, by + 1));
        const candidates = eligible ? candidateWidth * candidateHeight : 0;
        phaseData.push({ words: [...base, 2, bx, by, scene.width, scene.height, left, top, cw, ch, updateWords, eligible, eligibleAt], paint: !!eligible && candidates > 0, candidates });
        updateWords += cw * ch;
      }
      const actionBytes = count * prepared.maxEntries * 8;
      if (count * prepared.maxEntries >= 0x7fffffff) throw Error('GPU edge priority exceeds the sparse winner representation');
      if (actionBytes > device.limits.maxStorageBufferBindingSize || updateWords * 4 > device.limits.maxStorageBufferBindingSize) throw Error('GPU edge buffers exceed device binding limit');
      const alignment = device.limits.minUniformBufferOffsetAlignment, stride = Math.ceil(PAGE_WORDS * 4 / alignment) * alignment;
      const uniforms = new Int32Array(phaseData.length * stride / 4);
      phaseData.forEach((phase, index) => uniforms.set(phase.words, index * stride / 4));
      const buffers = [], own = buffer => (buffers.push(buffer), buffer);
      const materials = materialBuffer ?? own(upload(device, Int32Array.from(input.materials), GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC, 'edge materials'));
      if (materials.size < count * 4) throw Error('GPU edge material buffer is too small');
      const storage = (size, label) => own(device.createBuffer({ label, size, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST }));
      const rgba = storage(count * 4, 'edge RGBA'), painted = storage(count * 4, 'edge painted');
      const winners = storage(count * 12 + 24, 'edge winner priorities and touched destinations'), actions = storage(actionBytes, 'edge stamp descriptors');
      const indirect = own(device.createBuffer({ label: 'edge sparse resolve dispatch', size: 12, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.INDIRECT }));
      const params = own(upload(device, uniforms, GPUBufferUsage.UNIFORM, 'edge phase parameters')), sceneData = storage(updateWords * 4, 'edge seam and scene data');
      for (const update of updates) if (update.data.length) device.queue.writeBuffer(sceneData, update.at * 4, update.data);
      if (gpuClips.length) {
        const clipUniforms = new Uint32Array(gpuClips.length * stride / 4);
        gpuClips.forEach((clip, i) => clipUniforms.set(clip.words, i * stride / 4));
        const clipParams = own(upload(device, clipUniforms, GPUBufferUsage.UNIFORM, 'resident scene clips'));
        const pass = encoder.beginComputePass({ label: 'copy resident scene grids and whole-scene eligibility' }); pass.setPipeline(clipPipeline);
        const groups = new Map();
        gpuClips.forEach((clip, i) => {
          let clipGroup = groups.get(clip.buffer);
          if (!clipGroup) { clipGroup = device.createBindGroup({ layout: clipLayout, entries: [
            { binding: 0, resource: { buffer: clipParams, size: 48 } },
            { binding: 1, resource: { buffer: clip.buffer } }, { binding: 2, resource: { buffer: sceneData } },
          ] }); groups.set(clip.buffer, clipGroup); }
          pass.setBindGroup(0, clipGroup, [i * stride]); pass.dispatchWorkgroups(Math.ceil(clip.words[4] / 8), Math.ceil(clip.words[5] / 8));
        }); pass.end();
      }
      const bindings = [params, tableBuffer, materials, rgba, painted, winners, actions, sceneData, indirect];
      const bindingEntries = bindings.map((buffer, binding) => ({ binding, resource: { buffer, ...(binding === 0 ? { size: PAGE_WORDS * 4 } : {}) } }));
      const group = device.createBindGroup({ layout, entries: bindingEntries });
      const resolveGroup = device.createBindGroup({ layout: resolveLayout, entries: bindingEntries.slice(0, 8) });
      let dispatches = 0, computePasses = 0, indirectDispatches = 0, candidateInvocations = 0, candidateWorkgroupInvocations = 0, mutationInvocations = 0;
      for (let index = 0; index < phaseData.length; index++) {
        const pass = encoder.beginComputePass({ label: 'ordered edge scatter' }); computePasses++;
        const phase = phaseData[index]; pass.setBindGroup(0, group, [index * stride]);
        if (phase.words[8] === 2) {
          pass.setPipeline(pipelines.mutate_only); pass.dispatchWorkgroups(Math.ceil(phase.words[15] / 8), Math.ceil(phase.words[16] / 8));
          dispatches++; mutationInvocations += phase.words[15] * phase.words[16];
          if (!phase.paint) { pass.end(); continue; }
        } else { pass.setPipeline(pipelines.prepare_phase); pass.dispatchWorkgroups(1); dispatches++; }
        pass.setPipeline(pipelines.scatter); pass.dispatchWorkgroups(Math.ceil(phase.candidates / 64)); dispatches++;
        candidateInvocations += phase.candidates; candidateWorkgroupInvocations += Math.ceil(phase.candidates / 64) * 64;
        pass.end();
        const resolvePass = encoder.beginComputePass({ label: 'ordered sparse edge resolve' }); computePasses++;
        resolvePass.setBindGroup(0, resolveGroup, [index * stride]); resolvePass.setPipeline(pipelines.resolve_winners);
        resolvePass.dispatchWorkgroupsIndirect(indirect, 0); dispatches++; indirectDispatches++; resolvePass.end();
      }
      let disposed = false;
      return {
        materialBuffer: materials, rgbaBuffer: rgba, paintedBuffer: painted,
        // Optional validation readback only. Generation never maps this buffer.
        // First six u32: final count, total touched, generation, seam, scenes,
        // nonempty resolve phases. Remaining cells are implementation-private.
        diagnosticBuffer: winners,
        stats: {
          cpuPreparationMs: performance.now() - started, phases: phaseData.length, scenePhases: phaseData.length - 2,
          dispatches, computePasses, indirectDispatches, candidateInvocations, candidateWorkgroupInvocations, mutationInvocations,
          generationCandidates, seamCandidates, seamRectangles: rectangles.length,
          winnerBytes: count * 8, worklistBytes: count * 4 + 24, indirectBytes: 12,
          // Count new zero initialization once, not as eliminated work.
          semanticInitialZeroBytes: count * 16 + 24,
          zeroInitializedBufferCapacityBytes: count * 20 + 24 + actionBytes + 12,
          priorWholeFramePrepareResolveLowerBoundBytes: phaseData.filter(p => p.paint).length * count * 12,
          priorWholeFramePrepareResolveUpperBoundBytes: phaseData.filter(p => p.paint).length * count * 16,
          actionBytes, ownedBufferBytes: buffers.reduce((sum, buffer) => sum + buffer.size, 0), sceneUpdateBytes: updateWords * 4,
          sceneUploadBytes: updates.reduce((sum, update) => sum + update.data.byteLength, 0), sceneClipDispatches: gpuClips.length,
        },
        destroy() { if (!disposed) { disposed = true; for (const buffer of buffers) buffer.destroy(); } },
      };
    },
    destroy() { if (!destroyed) { destroyed = true; tableBuffer.destroy(); } },
  };
}
