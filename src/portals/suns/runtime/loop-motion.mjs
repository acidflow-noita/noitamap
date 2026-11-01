const TAU = Math.PI * 2;

// Optional export clock. Live motion (period = 0) keeps its original formulas.
// Complete turns close the pose AND its velocity, without reversing playback.
export function loopAngle(frame, rate, period = 0, minimumTurns = 1) {
  if (!period) return frame * rate;
  const turns = Math.sign(rate) * Math.max(minimumTurns, Math.round(Math.abs(rate) * period / TAU));
  return frame / period * TAU * turns;
}

export function loopAirTime(phase, period, initialTime = 0) {
  // A closed path through the native 3D noise field, with the original temporal
  // speed at the join. Particle integration itself always runs forwards.
  return Math.fround(initialTime + period / (60 * TAU) * Math.sin(phase / period * TAU));
}
