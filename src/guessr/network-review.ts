import type { NetworkReviewFlag, StreamGame } from './stream-types';
import { streamStandings } from './stream-state';

/** Private fields. Never attach these records to public player/game DTOs. */
export interface PrivatePlayerReview {
  joined: string[];
  explored: Record<number, string>;
  submitted: Record<number, string>;
}
export const newPlayerReview = (): PrivatePlayerReview => ({ joined: [], explored: {}, submitted: {} });

function normalizedAddress(value: string | null): string | null {
  if (!value || value.length > 64 || !/^[0-9a-f:.]+$/i.test(value)) return null;
  if (/^\d+(\.\d+){3}$/.test(value)) {
    const parts = value.split('.').map(Number);
    return parts.every(n => n >= 0 && n <= 255) ? parts.join('.') : null;
  }
  try {
    const address = new URL(`http://[${value}]/`).hostname.slice(1, -1).toLowerCase();
    // This is Cloudflare's shared cross-zone Worker address, not a client IP.
    if (address === '2a06:98c0:3600::103') return null;
    const mapped = /^::ffff:([a-f0-9]{1,4}):([a-f0-9]{1,4})$/.exec(address);
    if (mapped) { const a = parseInt(mapped[1], 16), b = parseInt(mapped[2], 16); return [a >> 8, a & 255, b >> 8, b & 255].join('.'); }
    return address;
  } catch { return null; }
}
export function newNetworkKey(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), n => n.toString(16).padStart(2, '0')).join('');
}
export async function networkTag(key: string, gameId: string, address: string | null): Promise<string | undefined> {
  const normalized = normalizedAddress(address);
  if (!normalized || !/^[a-f0-9]{64}$/.test(key)) return;
  const bytes = Uint8Array.from(key.match(/../g)!, n => parseInt(n, 16));
  const signing = await crypto.subtle.importKey('raw', bytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const digest = new Uint8Array(await crypto.subtle.sign('HMAC', signing, new TextEncoder().encode(`network-review-v1\n${gameId}\n${normalized}`)));
  return Array.from(digest.slice(0, 16), n => n.toString(16).padStart(2, '0')).join('');
}

/** A review hint only. Scores and rankings are never modified by this signal. */
export function roundNetworkFlags(game: StreamGame, round: number, reviews: ReadonlyMap<string, PrivatePlayerReview>): NetworkReviewFlag[] {
  if (game.session.mode === 'pvp' || !game.reveals[round]) return [];
  const groups = new Map<string, string[]>();
  for (const player of game.participants) {
    if (player.id === game.session.host.id) continue;
    const tag = reviews.get(player.id)?.explored[round];
    if (tag) { const group = groups.get(tag) ?? []; group.push(player.id); groups.set(tag, group); }
  }
  const participants = new Map(game.participants.map(p => [p.id, p]));
  const targets = new Map<string, string[]>();
  for (const player of streamStandings(game.participants, game.reveals)) {
    if (player.id === game.session.host.id || !(player.rounds[round]?.score >= 4800)) continue;
    const tag = reviews.get(player.id)?.submitted[round];
    if (!tag) continue;
    const related = (groups.get(tag) ?? []).filter(id => id !== player.id);
    if (!related.length) continue;
    const high = targets.get(tag) ?? []; high.push(player.id); targets.set(tag, high);
  }
  return [...targets].map(([tag, highScorers]) => ({ round: round + 1, highScorers, explorers: groups.get(tag)!,
    nonSubmitting: groups.get(tag)!.filter(id => !participants.get(id)?.guesses[round]?.point) }));
}
