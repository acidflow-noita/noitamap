import edgeModuleUrl from "./core.wasm?url";
import edgeAtlasUrl from "../../../lib/noita-telescope-vm/data/edge_atlas.bin?url";
import { createEdgeStamper, type NativeEdgeStamper } from "./core";

let completed: NativeEdgeStamper | null = null;
let pending: Promise<NativeEdgeStamper | null> | undefined;
/** One immutable table set and one fixed-memory stamper per worker. No seed
 * inputs are retained by this optional download/initialization promise. */
function load(): Promise<NativeEdgeStamper | null> {
  return (pending ??= (async () => {
    if (typeof WebAssembly === "undefined") return null;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    try {
      const responses = await Promise.all([
        fetch(edgeModuleUrl, { signal: controller.signal }),
        fetch(edgeAtlasUrl, { signal: controller.signal }),
      ]);
      if (responses.some((response) => !response.ok)) return null;
      const [bytes, atlas] = await Promise.all(
        responses.map((response) => response.arrayBuffer()),
      );
      const native = await createEdgeStamper(bytes, new Uint8Array(atlas));
      completed = native.enabled ? native : null;
      return completed;
    } catch {
      return null;
    } finally {
      clearTimeout(timeout);
    }
  })());
}
export function warmNativeEdges(): void {
  void load();
}

/** A slow optional fetch/compile/table build continues for later contexts;
 * the caller can immediately retain the existing JS path after 50ms. */
export async function readyNativeEdges(): Promise<NativeEdgeStamper | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const native = await Promise.race([
      load(),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), 50);
      }),
    ]);
    return native?.enabled ? native : null;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** A slow initial download may finish while a large terrain is already cooking. */
export function currentNativeEdges(): NativeEdgeStamper | null {
  return completed?.enabled ? completed : null;
}
