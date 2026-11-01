import type { SunEffect } from './placements';

export interface SunFrameStats {
  particles: number; estimatedGPUBytes: number; gpuMS: number | null; cpuMS: number;
  draws: number; retainedSuns: number; device: string; steps: number; warm: boolean;
  outputSize: number; outputPixels: number;
}
export type SunRequest = { type: 'init'; seed: number } | {
  type: 'frame'; effect: SunEffect; x: number; y: number; elapsedMS: number; pixels: number;
};
export type SunResponse = { type: 'ready'; startupMS: number } | { type: 'error'; message: string } | {
  type: 'frame'; effect: SunEffect; bitmap: ImageBitmap; stats: SunFrameStats;
};
export interface SunWorker {
  onmessage: ((event: MessageEvent<SunResponse>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  postMessage(data: SunRequest): void;
  terminate(): void;
}
