export interface DailyAssetRequest {
  baseUrl: string;
  fullPixels: boolean;
}

export type DailyAssetReply =
  | { type: 'failure'; asset: string; error: string }
  | { type: 'stage'; stage: string; state: 'started' | 'finished'; elapsedMs: number; failures: number }
  | { type: 'done'; prepared: number; failures: number; elapsedMs: number };
