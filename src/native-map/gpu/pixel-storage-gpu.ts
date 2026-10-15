/// <reference types="@webgpu/types" />
import { PIXEL_STORAGE_ENCODE_WGSL, PIXEL_STORAGE_DECODE_WGSL, pixelStoragePlan } from './pixel-storage.ts';

interface EncodedGpuSurfaceBase {
  readonly width: number;
  readonly height: number;
  readonly stats: {
    storageKind: 'zero' | 'blocks';
    /** Logical scalar descriptor; JS object/driver allocator overhead is separate. */
    descriptorBytes: number;
    inputBytes: number;
    retainedBytes: number;
    retainedAllocatedBytes: number;
    planningBytes: number;
    peakConstructionBytes: number;
    planningAndSizeReadMs: number;
    encodeAndCompletionMs: number;
    totalMs: number;
  };
  destroy(): void;
}

export type EncodedGpuSurface = EncodedGpuSurfaceBase & ({
  readonly kind: 'zero';
  readonly directory: null;
  readonly payload: null;
  readonly payloadWords: 0;
} | {
  readonly kind: 'blocks';
  readonly directory: GPUBuffer;
  readonly payload: GPUBuffer;
  readonly payloadWords: number;
});

function storage(device: GPUDevice, size: number): GPUBuffer {
  return device.createBuffer({ size: Math.max(4, size), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
}

function uniform(device: GPUDevice, values: Uint32Array): GPUBuffer {
  const buffer = device.createBuffer({ size: values.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  device.queue.writeBuffer(buffer, 0, values as Uint32Array<ArrayBuffer>);
  return buffer;
}

export async function createGpuPixelStorage(device: GPUDevice) {
  const startup = performance.now();
  const module = device.createShaderModule({ code: PIXEL_STORAGE_ENCODE_WGSL, label: 'Final RGBA block storage' });
  const decodeModule = device.createShaderModule({ code: PIXEL_STORAGE_DECODE_WGSL, label: 'Final RGBA block read' });
  for (const shader of [module, decodeModule]) {
    const messages = (await shader.getCompilationInfo()).messages.filter(message => message.type === 'error');
    if (messages.length) throw new Error(messages.map(message => `${message.lineNum}:${message.linePos} ${message.message}`).join('\n'));
  }
  const layout = device.createBindGroupLayout({ entries: Array.from({ length: 7 }, (_, binding) => ({
    binding, visibility: GPUShaderStage.COMPUTE,
    buffer: { type: (binding === 0 ? 'uniform' : binding === 1 ? 'read-only-storage' : 'storage') as GPUBufferBindingType },
  })) });
  const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [layout] });
  const entries = ['analyze', 'scanBlocks', 'scanGroups', 'encode'] as const;
  const created = await Promise.all(entries.map(entryPoint => device.createComputePipelineAsync({
    layout: pipelineLayout, compute: { module, entryPoint },
  })));
  const [analyze, scanBlocks, scanGroups, encodePipeline] = created;
  const decodePipeline = await device.createComputePipelineAsync({ layout: 'auto', compute: { module: decodeModule, entryPoint: 'decode' } });

  return {
    startupMs: performance.now() - startup,
    /** Input ownership stays with the caller. Returned buffers contain only compact final pixels. */
    async encode(input: GPUBuffer, width: number, height: number): Promise<EncodedGpuSurface> {
      const started = performance.now(), plan = pixelStoragePlan(width, height);
      if (input.size < plan.inputBytes) throw new RangeError('GPU input does not cover the complete surface');
      const params = uniform(device, plan.uniform), info = storage(device, plan.blocks * 8);
      const offsets = storage(device, plan.blocks * 4), groups = storage(device, 65 * 4);
      // Neither output is needed by analysis or prefix. Delay actual retained
      // allocation until the count is known, including the exact all-zero case.
      const unusedDirectory = storage(device, 4), unusedPayload = storage(device, 4);
      const count = device.createBuffer({ size: 4, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
      const bindings = [params, input, info, offsets, groups, unusedPayload, unusedDirectory];
      const planningBytes = plan.gpuPlanningBytes + 16 + 4 + 4 + 4;
      const disposePlanning = () => {
        params.destroy(); info.destroy(); offsets.destroy(); groups.destroy();
        unusedPayload.destroy(); unusedDirectory.destroy();
      };
      const bind = () => device.createBindGroup({ layout, entries: bindings.map((buffer, binding) => ({ binding, resource: { buffer } })) });
      const initialGroup = bind(), commands = device.createCommandEncoder();
      for (const [pipeline, dispatches] of [[analyze, Math.ceil(plan.blocks / 64)], [scanBlocks, Math.ceil(plan.blocks / 256)], [scanGroups, 1]] as const) {
        const pass = commands.beginComputePass();
        pass.setPipeline(pipeline); pass.setBindGroup(0, initialGroup); pass.dispatchWorkgroups(dispatches); pass.end();
      }
      commands.copyBufferToBuffer(groups, 64 * 4, count, 0, 4);
      device.queue.submit([commands.finish()]);
      await count.mapAsync(GPUMapMode.READ);
      const words = new Uint32Array(count.getMappedRange())[0];
      count.unmap(); count.destroy();
      if (words * 4 > plan.maximumPayloadBytes) {
        disposePlanning();
        throw new RangeError('GPU payload count exceeds the proven block bound');
      }
      const planned = performance.now();
      if (words === 0) {
        // Only mode zero contributes no words. A zero sum over nonnegative
        // block sizes proves every stored RGBA value is exactly zero, including
        // hidden RGB; no directory, payload, or packing pass is necessary.
        disposePlanning();
        return {
          kind: 'zero', width, height, directory: null, payload: null, payloadWords: 0,
          stats: {
            storageKind: 'zero', descriptorBytes: 16, inputBytes: plan.inputBytes,
            retainedBytes: 0, retainedAllocatedBytes: 0, planningBytes,
            peakConstructionBytes: input.size + planningBytes,
            planningAndSizeReadMs: planned - started, encodeAndCompletionMs: 0,
            totalMs: performance.now() - started,
          },
          destroy() {},
        };
      }
      const payload = storage(device, words * 4), directory = storage(device, plan.directoryBytes);
      bindings[5] = payload;
      bindings[6] = directory;
      const outputCommands = device.createCommandEncoder(), outputPass = outputCommands.beginComputePass();
      outputPass.setPipeline(encodePipeline); outputPass.setBindGroup(0, bind());
      outputPass.dispatchWorkgroups(Math.ceil(plan.blocks / 64)); outputPass.end();
      device.queue.submit([outputCommands.finish()]);
      await device.queue.onSubmittedWorkDone();
      const finished = performance.now();
      disposePlanning();
      const retainedBytes = plan.directoryBytes + words * 4, retainedAllocatedBytes = directory.size + payload.size;
      return {
        kind: 'blocks', width, height, directory, payload, payloadWords: words,
        stats: {
          storageKind: 'blocks', descriptorBytes: 16,
          inputBytes: plan.inputBytes, retainedBytes, retainedAllocatedBytes,
          planningBytes,
          peakConstructionBytes: input.size + retainedAllocatedBytes + planningBytes,
          planningAndSizeReadMs: planned - started,
          encodeAndCompletionMs: finished - planned,
          totalMs: finished - started,
        },
        destroy() { directory.destroy(); payload.destroy(); },
      };
    },
    /** Test/readback or bounded tile decoding; display may use readCompletedPixel directly. */
    async decode(surface: EncodedGpuSurface): Promise<GPUBuffer> {
      const plan = pixelStoragePlan(surface.width, surface.height);
      if (surface.kind === 'zero') {
        const output = device.createBuffer({ size: plan.inputBytes,
          usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
        const commands = device.createCommandEncoder(); commands.clearBuffer(output);
        device.queue.submit([commands.finish()]);
        await device.queue.onSubmittedWorkDone();
        return output;
      }
      const params = uniform(device, plan.uniform);
      const output = storage(device, plan.inputBytes);
      const group = device.createBindGroup({ layout: decodePipeline.getBindGroupLayout(0), entries: [params, surface.directory, surface.payload, output]
        .map((buffer, binding) => ({ binding, resource: { buffer } })) });
      const commands = device.createCommandEncoder(), pass = commands.beginComputePass();
      pass.setPipeline(decodePipeline); pass.setBindGroup(0, group); pass.dispatchWorkgroups(Math.ceil(plan.width * plan.height / 64)); pass.end();
      device.queue.submit([commands.finish()]);
      await device.queue.onSubmittedWorkDone();
      params.destroy();
      return output;
    },
  };
}
