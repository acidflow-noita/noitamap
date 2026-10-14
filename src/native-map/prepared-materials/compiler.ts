import identity from './material-edge-plan.json';
import { encodeStencilField, openStencilField } from './stencil-codec';

export interface MaterialEdgeFrame {
  /** Half the map width in world pixels: normal 17920, NG+/Nightmare 16384. */
  worldOffsetX: number;
  offsetY: number;
  /** A local shaft's origin in lattice coordinates; omit for the world grid. */
  originX?: number;
}
export interface MaterialEdgeRectangle { x: number; y: number; width: number; height: number }
export interface PreparedMaterialEdgePlan {
  revision: string;
  frame: MaterialEdgeFrame;
  rectangle: MaterialEdgeRectangle;
  field: Uint8Array;
}
interface Exports extends WebAssembly.Exports {
  memory: WebAssembly.Memory;
  heap_base(): number;
  material_edge_plan_abi(): number;
  prepare_material_edge_plan(x: number, y: number, width: number, height: number,
    offsetX: number, offsetY: number, originX: number, local: number, output: number): void;
}
const MAX_EDGE = 640;
export const MATERIAL_EDGE_PLAN_REVISION = `${identity.moduleHash}/${identity.sources['src/native-map/prepared-materials/stencil-codec.ts']}`;

function validate(frame: MaterialEdgeFrame, rect: MaterialEdgeRectangle): void {
  if (![16384, 17920].includes(frame.worldOffsetX)
    || !Number.isSafeInteger(frame.offsetY) || Math.abs(frame.offsetY) > 2 ** 29
    || (frame.originX !== undefined && (!Number.isFinite(frame.originX) || Math.abs(frame.originX) > 2 ** 27))
    || ![rect.x, rect.y, rect.width, rect.height].every(Number.isSafeInteger)
    || Math.abs(rect.x) > 2 ** 29 || Math.abs(rect.y) > 2 ** 29
    || rect.width < 1 || rect.height < 1 || rect.width > MAX_EDGE || rect.height > MAX_EDGE)
    throw new RangeError('Invalid material preparation coordinates');
}

/** Content identity intentionally excludes the seed: this field has no seed,
 * material-label, coverage or biome input. Changed coordinate frames do differ. */
export function materialEdgePlanKey(frame: MaterialEdgeFrame, rect: MaterialEdgeRectangle): string {
  validate(frame, rect);
  return [MATERIAL_EDGE_PLAN_REVISION, frame.worldOffsetX, frame.offsetY,
    frame.originX === undefined ? 'world' : `local:${frame.originX}`,
    rect.x, rect.y, rect.width, rect.height].join('/');
}

export function openMaterialEdgePlan(plan: PreparedMaterialEdgePlan) {
  validate(plan.frame, plan.rectangle);
  if (plan.revision !== MATERIAL_EDGE_PLAN_REVISION) throw new Error('Material preparation revision changed');
  return openStencilField(plan.field, plan.rectangle.width * plan.rectangle.height);
}

/** Create once in a preparation worker. Returned plans own only their packed
 * fields; the dense temporary buffer is reused. Delivery can use the normal
 * immutable asset URL or an explicit buffer supplied by a native host. */
export async function createMaterialEdgePlanCompiler(bytes?: BufferSource) {
  if (!bytes) {
    const response = await fetch(new URL('./material-edge-plan.wasm', import.meta.url));
    if (!response.ok) throw new Error('Material preparation module unavailable');
    bytes = await response.arrayBuffer();
  }
  const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
    .map(value => value.toString(16).padStart(2, '0')).join('');
  if (digest !== identity.moduleHash) throw new Error('Material preparation module identity changed');
  const { instance } = await WebAssembly.instantiate(bytes);
  const wasm = instance.exports as Exports;
  if (wasm.material_edge_plan_abi() !== identity.abi) throw new Error('Material preparation ABI');
  const output = Math.ceil(wasm.heap_base() / 16) * 16;
  const required = output + MAX_EDGE * MAX_EDGE * 2;
  if (required > wasm.memory.buffer.byteLength)
    wasm.memory.grow(Math.ceil((required - wasm.memory.buffer.byteLength) / 65536));
  return {
    scratchBytes: wasm.memory.buffer.byteLength,
    prepare(frame: MaterialEdgeFrame, rectangle: MaterialEdgeRectangle): PreparedMaterialEdgePlan {
      validate(frame, rectangle);
      wasm.prepare_material_edge_plan(rectangle.x, rectangle.y, rectangle.width, rectangle.height,
        frame.worldOffsetX, frame.offsetY, frame.originX ?? 0, Number(frame.originX !== undefined), output);
      const values = new Uint16Array(wasm.memory.buffer, output, rectangle.width * rectangle.height);
      return { revision: MATERIAL_EDGE_PLAN_REVISION, frame: { ...frame }, rectangle: { ...rectangle },
        field: encodeStencilField(values) };
    },
  };
}
