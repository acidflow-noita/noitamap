// Authored math controls only; never override the native-backed Noita catalog.
// Multipliers are relative to meditation's 0.35–2.55 second trail lifetime.
export const MATH_TRAIL_SCALE = Object.freeze({
  min: 0.5,
  max: 3,
  step: 0.1,
  default: 1.5,
});

export function validateMathTrailScale(value) {
  if (
    !Number.isFinite(value) ||
    value < MATH_TRAIL_SCALE.min ||
    value > MATH_TRAIL_SCALE.max
  )
    throw new RangeError("Math trail lifetime must be between 0.5× and 3×");
  return value;
}
