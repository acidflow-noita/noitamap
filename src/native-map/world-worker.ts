import { createNativeWorldGenerator, type WorldRequest } from "./world";
import { browserNativeAssets } from "./browser-assets";

const worker = self as unknown as DedicatedWorkerGlobalScope;
let engine: ReturnType<typeof createNativeWorldGenerator> | undefined;
const requests = new Map<number, AbortController>();

function transferables(value: unknown, buffers = new Set<ArrayBuffer>(), visited = new Set<object>()): ArrayBuffer[] {
  if (!value || typeof value !== "object" || visited.has(value)) return [...buffers];
  visited.add(value);
  if (value instanceof ArrayBuffer) buffers.add(value);
  else if (ArrayBuffer.isView(value) && value.buffer instanceof ArrayBuffer) buffers.add(value.buffer);
  else for (const child of Object.values(value)) transferables(child, buffers, visited);
  return [...buffers];
}

worker.onmessage = async ({ data }: MessageEvent<{
  id: number; type: "prepare" | "generate" | "cancel"; request?: WorldRequest;
}>) => {
  if (data.type === "cancel") { requests.get(data.id)?.abort(); return; }
  const controller = new AbortController();
  requests.set(data.id, controller);
  try {
    engine ??= createNativeWorldGenerator(browserNativeAssets, () => new Promise(resolve => setTimeout(resolve, 0)));
    const generator = await engine;
    if (data.type === "prepare") worker.postMessage({ id: data.id, ok: true });
    else {
      if (!data.request) throw new Error("Missing world request");
      const world = await generator.generate(data.request, controller.signal);
      // Scene descriptors can reference immutable input masks. Never detach those.
      worker.postMessage({ id: data.id, ok: true, world }, transferables({
        biomeData: world.biomeData, tileLayers: world.tileLayers, elevatorShafts: world.elevatorShafts,
      }));
    }
  } catch (error) {
    worker.postMessage({ id: data.id, ok: false,
      error: error instanceof Error ? error.message : String(error) });
  } finally { requests.delete(data.id); }
};
