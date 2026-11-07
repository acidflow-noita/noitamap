export class TwitchTransportError extends Error {
  constructor(message: string, readonly retryable = false, readonly retryAfterMs = 0,
    readonly status?: number, readonly dropCode?: string) {
    super(message); this.name = 'TwitchTransportError';
  }
}

/** Respect Twitch's advertised cooldown; never spin on a rejected message. */
export function twitchRetryDelay(headers: Headers, now = Date.now()): number {
  const after = Number(headers.get('Retry-After'));
  const reset = Number(headers.get('Ratelimit-Reset')) * 1000 - now;
  return Math.max(3000, Number.isFinite(after) ? after * 1000 : 0, Number.isFinite(reset) ? reset : 0);
}
