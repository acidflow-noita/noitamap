import { supportedCamera, type Camera, type ClueSource } from './clue-camera.ts';
import type { Point } from './rules.ts';
import { decodeMapFrames, type MapPose, type MapReplayAction } from './guess-map-replay.ts';

export const cameraActions = ['view', 'up', 'down', 'left', 'right', 'zoom-in', 'zoom-out', 'return'] as const;
export type CameraAction = (typeof cameraActions)[number];
export type ReplayFrame = [time: number, dx: number, dy: number, level: number, action?: CameraAction];
export type ReplayStep =
  | { action: CameraAction; second: number; camera: Camera }
  | { action: 'submit' | 'update' | 'automatic'; second: number; point: Point };
export interface MapReplayStep { action: MapReplayAction; second: number; map: MapPose; before: number }
export type PlaybackStep = ReplayStep | MapReplayStep;
/** This is the public response. Only whole seconds since the player's round opened leave the Worker. */
export interface ClueReplay {
  clue: ClueSource;
  steps: ReplayStep[];
  /** Additive for older viewers. Each index is the number of clue/guess steps preceding the move. */
  mapSteps?: MapReplayStep[];
  partial?: true;
}
export type ReplayLoader = (round: number, player: string, signal: AbortSignal) => Promise<ClueReplay | null>;
export const REPLAY_BATCH = 32;
export const REPLAY_LIMIT = 8192;
export const ENCODED_FRAME_SIZE = 12;

export function validReplayFrame(value: unknown, source: ClueSource): value is ReplayFrame {
  if (!Array.isArray(value) || (value.length !== 4 && value.length !== 5) || !Number.isSafeInteger(value[0]))
    return false;
  return (
    (value[4] === undefined || cameraActions.includes(value[4])) &&
    supportedCamera(source, { dx: value[1], dy: value[2], level: value[3] })
  );
}

// Private camera records. Action and zoom share the last byte so a labelled view still takes nine bytes.
export function encodeReplayFrames(frames: ReplayFrame[], origin: number): string {
  const bytes = new Uint8Array(frames.length * 9),
    view = new DataView(bytes.buffer);
  frames.forEach(([time, dx, dy, level, action], i) => {
    const p = i * 9;
    view.setUint32(p, time - origin);
    view.setInt16(p + 4, dx);
    view.setInt16(p + 6, dy);
    bytes[p + 8] = level | ((action ? cameraActions.indexOf(action) + 1 : 0) << 3);
  });
  return btoa(String.fromCharCode(...bytes));
}
export type StoredGuessStep = [at: number, x: number, y: number, automatic: number];
export interface StoredClueTrack {
  track: string;
  maps?: string;
  opens: number | null;
  guesses: StoredGuessStep[];
  partial?: boolean;
}

export function publicClueReplay(clue: ClueSource, stored: StoredClueTrack): ClueReplay | null {
  if (stored.track.length % ENCODED_FRAME_SIZE || stored.track.length > REPLAY_LIMIT * ENCODED_FRAME_SIZE)
    throw Error('Invalid clue replay');
  const bytes = Uint8Array.from(atob(stored.track), c => c.charCodeAt(0));
  const view = new DataView(bytes.buffer);
  const opens = stored.opens ?? (bytes.length ? view.getUint32(0) : (stored.guesses[0]?.[0] ?? 0));
  const second = (at: number) => Math.max(0, Math.floor((at - opens) / 1000));
  const steps: ReplayStep[] = [];
  const times: number[] | undefined = stored.maps ? [] : undefined;
  let guess = 0;
  const appendGuesses = (before: number) => {
    while (guess < stored.guesses.length && stored.guesses[guess][0] < before) {
      const [at, x, y, automatic] = stored.guesses[guess];
      times?.push(at);
      steps.push({
        second: second(at),
        action: automatic ? 'automatic' : guess ? 'update' : 'submit',
        point: { x, y },
      });
      guess++;
    }
  };
  for (let p = 0; p < bytes.length; p += 9) {
    const at = view.getUint32(p),
      tag = bytes[p + 8];
    const camera = { dx: view.getInt16(p + 4), dy: view.getInt16(p + 6), level: tag & 7 };
    if (!supportedCamera(clue, camera) || (p && at <= view.getUint32(p - 9))) throw Error('Invalid clue replay');
    appendGuesses(at);
    times?.push(at);
    steps.push({ second: second(at), action: cameraActions[(tag >> 3) - 1] ?? 'view', camera });
  }
  appendGuesses(Infinity);
  let before = 0;
  const mapSteps = stored.maps && times ? decodeMapFrames(stored.maps, 0, REPLAY_LIMIT).map(({ at, action, map }) => {
    while (before < times.length && (times[before] < at || (times[before] === at && 'camera' in steps[before]))) before++;
    return { before, second: second(at), action, map };
  }) : [];
  return steps.length || mapSteps.length ? { clue, steps, ...(mapSteps.length ? { mapSteps } : {}),
    ...(stored.partial ? { partial: true } : {}) } : null;
}

export function playbackSteps(data: ClueReplay): PlaybackStep[] {
  if (!data.mapSteps?.length) return data.steps;
  const result: PlaybackStep[] = [];
  let next = 0;
  for (let i = 0; i <= data.steps.length; i++) {
    while (next < data.mapSteps.length && data.mapSteps[next].before === i) result.push(data.mapSteps[next++]);
    if (i < data.steps.length) result.push(data.steps[i]);
  }
  return result;
}
