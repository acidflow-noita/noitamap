import { unpackSceneInputs } from "./unpack-scene-inputs";

self.onmessage = async ({
  data,
}: MessageEvent<{
  compressed: ArrayBuffer;
  provenance: string;
  bytes: number;
}>) => {
  try {
    const scenes = await unpackSceneInputs(
      data.compressed,
      data.bytes,
      data.provenance,
    );
    const buffers = new Set<ArrayBuffer>();
    function collect(value: any): void {
      if (ArrayBuffer.isView(value)) {
        buffers.add(value.buffer as ArrayBuffer);
        return;
      }
      if (value && typeof value === "object")
        for (const child of Object.values(value)) collect(child);
    }
    collect(scenes);
    (self as unknown as DedicatedWorkerGlobalScope).postMessage({ scenes }, [
      ...buffers,
    ]);
  } catch (error) {
    self.postMessage({
      error: error instanceof Error ? error.message : String(error),
    });
  }
};
