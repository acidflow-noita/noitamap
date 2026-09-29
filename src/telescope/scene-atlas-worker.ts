import { decode } from 'fast-png';
self.onmessage = async ({ data }: MessageEvent<Blob>) => {
  try {
    const decoded = decode(new Uint8Array(await data.arrayBuffer()));
    if (decoded.width !== 1024 || decoded.height !== 1024 || decoded.channels !== 4 || decoded.depth !== 8)
      throw new Error('Invalid source scene atlas');
    const pixels = decoded.data as Uint8Array<ArrayBuffer>;
    (self as unknown as DedicatedWorkerGlobalScope).postMessage({ pixels }, [pixels.buffer]);
  } catch (error) { self.postMessage({ error: String(error) }); }
};
