import type { CameraMatrix } from './geometry';
import type { PortalPlacement } from './placements';

export const PORTAL_RENDERER_REVISION = '85d0740e7d592d9b65395fbdae68013f23c4acc7';
export const FRAME_MS = 1000 / 60;
export interface PortalCamera {
  matrix: CameraMatrix;
  width: number;
  height: number;
  resolution: number;
}
export interface PortalGPUStats {
  mode: 'experimental-gpu-particles';
  executionThread: 'worker';
  revision: string;
  total: number; visible: number; active: number; capped: number;
  particles: number; visibleParticles: number;
  cpuMS: number; gpuMS: number | null; gpuWaitMS: number; frameMS: number; fps: number;
  steps: number; simFPS: number; deliveryMS: number;
  estimatedGPUBytes: number; canvasPixels: number; device: string;
  suspended: boolean; slow: boolean;
}
export interface PortalWorkerOptions { minPixels: number; limit: number; fence?: boolean }
export type PortalWorkerRequest = {
  type: 'init'; resources: ArrayBuffer; portals: PortalPlacement[]; seed: number;
  options: PortalWorkerOptions;
} | {
  type: 'frame'; id: number; camera: PortalCamera; elapsed: number;
};
export interface PortalFrame {
  type: 'frame'; id: number; camera: PortalCamera;
  bitmap: ImageBitmap; stats: PortalGPUStats;
  activePortalIDs: string[];
}
export type PortalWorkerResponse = PortalFrame | { type: 'ready' } | { type: 'error'; message: string };
export interface PortalWorker {
  onmessage: ((event: MessageEvent<PortalWorkerResponse>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  postMessage(message: PortalWorkerRequest, transfer?: Transferable[]): void;
  terminate(): void;
}
