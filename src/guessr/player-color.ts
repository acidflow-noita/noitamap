export const STREAMER_COLOR = '#9146FF';
export function twitchColor(value: unknown): string | undefined {
  return typeof value === 'string' && /^#[a-f0-9]{6}$/i.test(value) ? value.toUpperCase() : undefined;
}
export function playerColor(player: { id: string; color?: string }, hostId?: string): string {
  return player.id === hostId ? STREAMER_COLOR : twitchColor(player.color) ?? '#E2E8F0';
}
