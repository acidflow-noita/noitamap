import { encode } from 'fast-png';

self.onmessage = ({ data: { id, pixels, width, height } }) => {
  try {
    const png = encode({ data: pixels, width, height, channels: 4 });
    self.postMessage({ id, png }, { transfer: [png.buffer] });
  } catch (error) {
    self.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
  }
};
