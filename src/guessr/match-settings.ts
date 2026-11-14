export type MultiplayerMode = 'stream' | 'pvp';

/** New-match defaults. The selected value is persisted with the match, never
 * re-read from a browser preference while a game is running. */
export function defaultStreaming(mode: MultiplayerMode): boolean {
  return mode === 'stream';
}
export function streamsAhead(session: { mode?: MultiplayerMode; streaming?: boolean }): boolean {
  return session.streaming ?? defaultStreaming(session.mode ?? 'stream');
}
