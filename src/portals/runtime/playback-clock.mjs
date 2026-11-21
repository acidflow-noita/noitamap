export const FRAME_MS = 1000 / 60;

// Present the tick nearest the display timestamp. The caller keeps the signed
// remainder, so rounded browser timestamps cannot double or skip a normal tick.
export function playbackSteps(pending) {
  return Math.max(0, Math.min(2, Math.round(pending / FRAME_MS)));
}
