export const DAY_MS = 86_400_000;
export const WORKER_FREE_REQUESTS = 100_000;
export const MINUTE = 60_000;
export const MAX_AGE = 3 * MINUTE;
type Mode = 'demo' | 'ranked' | 'stream' | 'pvp';
export type Snapshot = {
  day_start: number;
  measured_through: number;
  checked_at: number;
  used_requests: number;
  background_requests: number;
  peak_per_minute: number;
  held_requests: number;
  paused_until: number;
};

export function utcStart(now: number): number {
  return Math.floor(now / DAY_MS) * DAY_MS;
}
/** A seat needs a socket upgrade, a final result read, and room for a probe and reconnect in each remaining round.
 * Normal socket messages go straight to the game coordinator and do not invoke the HTTP Worker per move. */
export function seatRequests(rounds: number): number {
  return 2 + 2 * rounds;
}
export function gameRequests(mode: Mode, rounds: number): number {
  // Two requests cover an authenticated mutation including its possible cross-origin preflight.
  const start = 2;
  if (mode === 'stream' || mode === 'pvp') return start + (mode === 'pvp' ? 2 : 1) * seatRequests(rounds);
  // Each round budgets submit, advance/image, and a retry of those two calls; include a final resume/read.
  return start + 8 * rounds + 2;
}
export const minimumStart = Math.min(
  gameRequests('stream', 3),
  gameRequests('pvp', 3),
  gameRequests('demo', 3),
  gameRequests('ranked', 10)
);

export type GameAvailability = { state: 'open' | 'paused' | 'checking'; retryAt: number };
export function fresh(s: Snapshot | null, now: number): s is Snapshot {
  return (
    !!s &&
    s.day_start === utcStart(now) &&
    s.checked_at <= now + 1000 &&
    s.checked_at >= now - MAX_AGE &&
    s.measured_through >= s.day_start &&
    s.measured_through <= s.checked_at &&
    s.measured_through >= now - 2 * MAX_AGE
  );
}
/** Leave the measured account-wide peak enough requests for the reporting delay and the next refresh. */
export function available(s: Snapshot, now: number): number {
  return (
    WORKER_FREE_REQUESTS -
    s.used_requests -
    s.background_requests -
    s.held_requests -
    s.peak_per_minute * Math.ceil((Math.max(0, now - s.measured_through) + MAX_AGE) / MINUTE)
  );
}

export function disposition(s: Snapshot | null, now: number): GameAvailability {
  if (s && s.paused_until > now) return { state: 'paused', retryAt: s.paused_until };
  if (!fresh(s, now)) return { state: 'checking', retryAt: now + MINUTE };
  return available(s, now) < minimumStart
    ? { state: 'paused', retryAt: s.day_start + DAY_MS }
    : { state: 'open', retryAt: now + MINUTE };
}
