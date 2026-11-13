import type { StreamRoundView } from './stream-round-data';
import { within, type Bounds } from './rules';

/** Public, already released round views only. Credentials and future clues never
 * enter this optional refresh cache; the coordinator also replays these views. */
export class StreamRoundCache {
  readonly rounds = new Map<number, StreamRoundView>();
  private key: string;
  constructor(game: string, private bounds: Bounds) {
    this.key = 'noitaguessr-round-results:' + game;
    try {
      const raw = localStorage.getItem(this.key);
      if (raw && raw.length < 2 * 1024 * 1024) {
        const values = JSON.parse(raw); if (Array.isArray(values)) for (const value of values.slice(0, 10)) this.accept(value);
      }
    } catch { /* Replay from the existing socket restores unavailable storage. */ }
  }
  private accept(data: StreamRoundView): boolean {
    if (!data || !Number.isInteger(data.round) || data.round < 1 || data.round > 10 || !within(data.answer, this.bounds)
      || typeof data.label !== 'string' || data.label.length > 256 || !data.host || !Array.isArray(data.players) || data.players.length > 1500
      || !data.players.some(p => p.id === data.host.id) || data.players.some(p => !/^\d{1,30}$/.test(p.id) || typeof p.name !== 'string'
        || p.name.length > 512 || p.guess !== null && !within(p.guess, this.bounds) || !Number.isInteger(p.score) || p.score < 0 || p.score > 5000
        || !Number.isInteger(p.total) || p.total < 0 || p.total > 50000)) return false;
    this.rounds.set(data.round, data); return true;
  }
  save(data: StreamRoundView): void {
    if (!this.accept(data)) return;
    try {
      const text = JSON.stringify([...this.rounds.values()]);
      if (text.length < 2 * 1024 * 1024) localStorage.setItem(this.key, text);
    } catch { /* The open view and durable coordinator remain available. */ }
  }
}
