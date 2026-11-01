import type { ImageGameConfig } from './image-game';
import type { PreparedRound } from './prepared-rounds';
import { ROUND_COUNT } from './rules';

/** Private CI publication. Only a round's relative frames are sent before its answer. */
export interface DailyImagePack {
  schemaVersion: 1;
  day: string;
  seed: number;
  version: string;
  renderId: string;
  generatedAt: string;
  config: ImageGameConfig;
  rounds: PreparedRound[];
}

export const DAILY_ROUNDS = ROUND_COUNT;
export const DAILY_PUBLISH_LIMIT = 1024 * 1024;
