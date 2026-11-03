import type { StreamReveal } from './stream-types';
import { prepareAreaScorer } from './area-rules';
import { within, type Bounds, type Point } from './rules';

export interface ViewerSubmission { key: string; point: Point; maximum: number; status: 'pending' | 'received' | 'rejected' }
interface ViewerRoundRecord { submissions: ViewerSubmission[]; reveal?: StreamReveal }
interface ViewerGameHistory { gameId: string; playerId: string; rounds: ViewerRoundRecord[] }

/** Only this player's submissions and already released solutions are persisted.
 * Late joins have zero for unsubmitted rounds; unconfirmed sends remain explicit. */
export class StreamViewerHistory {
  private history?: ViewerGameHistory;
  constructor(private bounds: Bounds) {}
  identify(gameId: string | undefined, playerId: string | null): void {
    if (this.history?.gameId === gameId && this.history?.playerId === playerId) return;
    this.history = undefined;
    if (!gameId || !playerId) return;
    const empty: ViewerGameHistory = { gameId, playerId, rounds: Array.from({ length: 10 }, () => ({ submissions: [] })) };
    try {
      const raw = localStorage.getItem(this.key(gameId, playerId));
      const saved = raw && raw.length < 524_288 ? JSON.parse(raw) as ViewerGameHistory : null;
      if (saved?.gameId === gameId && saved.playerId === playerId && saved.rounds?.length === 10) {
        saved.rounds.forEach((round, i) => {
          if (Array.isArray(round.submissions)) empty.rounds[i].submissions = round.submissions.slice(-64).filter(value =>
            /^[a-f0-9]{16}$/.test(value.key) && within(value.point, this.bounds)
            && Number.isInteger(value.maximum) && value.maximum >= 0 && value.maximum <= 5000
            && ['pending', 'received', 'rejected'].includes(value.status));
          if (round.reveal && within(round.reveal.answer, this.bounds)) {
            prepareAreaScorer(round.reveal.area, round.reveal.answer); empty.rounds[i].reveal = round.reveal;
          }
        });
      }
    } catch { /* Malformed storage cannot block the current game. */ }
    this.history = empty;
  }
  private key(game: string, player: string) { return `noitamap-guessr-score:${game}:${player}`; }
  private save(): void {
    if (!this.history) return;
    try { localStorage.setItem(this.key(this.history.gameId, this.history.playerId), JSON.stringify(this.history)); } catch { /* Current tab retains the data. */ }
  }
  submit(round: number, key: string, point: Point, maximum: number): void {
    const record = this.history?.rounds[round]; if (!record) return;
    record.submissions.push({ key, point: { ...point }, maximum, status: 'pending' });
    record.submissions = record.submissions.slice(-64); this.save();
  }
  receipts(round: number, keys: string[], rejected = false): void {
    const record = this.history?.rounds[round]; if (!record) return;
    const set = new Set(keys);
    for (const value of record.submissions) if (set.has(value.key)) value.status = rejected ? 'rejected' : 'received';
    this.save();
  }
  reveal(round: number, reveal: StreamReveal): void {
    const record = this.history?.rounds[round]; if (!record || !within(reveal.answer, this.bounds)) return;
    prepareAreaScorer(reveal.area, reveal.answer); record.reveal = reveal; this.save();
  }
  round(round: number) {
    const record = this.history?.rounds[round];
    const received = record?.submissions.slice().reverse().find(value => value.status === 'received');
    const last = record?.submissions.at(-1);
    const pending = last?.status === 'pending';
    const score = record?.reveal ? prepareAreaScorer(record.reveal.area, record.reveal.answer)(received?.point ?? null, received?.maximum ?? 5000) : undefined;
    return { reveal: record?.reveal, received, pending, lastStatus: last?.status, submitted: !!record?.submissions.length, score };
  }
  recovery(revealed: number) {
    let missing = 0;
    const receipts: { round: number; key: string }[] = [];
    this.history?.rounds.forEach((value, round) => {
      if (value.submissions.length && !value.reveal && revealed & 1 << round) missing |= 1 << round;
      const last = value.submissions.at(-1);
      if (last?.status === 'pending') receipts.push({ round, key: last.key });
    });
    return { missing, receipts };
  }
  total(): number { return Array.from({ length: 10 }, (_, i) => this.round(i).score?.score ?? 0).reduce((a, b) => a + b, 0); }
}
