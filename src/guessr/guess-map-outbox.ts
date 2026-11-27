import { decodeMapFrames, encodeMapFrames, MAP_PACKET_LIMIT, type MapFrame, type MapPacket, type MapPose, type MapReplayAction } from './guess-map-replay';

type Pending = { last: MapPose; through: number; frames: MapFrame[]; partial?: true };
/** Only attaches bytes to an existing clue or submission. It has no socket, timer or send callback. */
export class GuessMapOutbox {
  private rounds = new Map<string, Pending>();
  private sent = new Map<string, { round: string; through: number }>();
  constructor(private key: string) {
    try {
      const saved: [string, MapPacket][] = JSON.parse(sessionStorage.getItem(key) ?? '[]');
      for (const [id, packet] of saved.slice(-10)) {
        const frames = decodeMapFrames(packet.data, packet.base, MAP_PACKET_LIMIT), last = frames.at(-1);
        if (typeof id === 'string' && last) this.rounds.set(id, { frames, last: last.map, through: last.at, partial: packet.partial });
      }
    } catch { /* Gameplay does not depend on tab storage. */ }
  }
  private packet(row: Pending): MapPacket {
    const base = row.frames[0].at;
    return { base, data: encodeMapFrames(row.frames, base), ...(row.partial ? {partial:true} : {}) };
  }
  private save() {
    try {
      const rows = [...this.rounds].filter(([, row]) => row.frames.length).map(([id, row]) => [id, this.packet(row)]);
      if (rows.length) sessionStorage.setItem(this.key, JSON.stringify(rows)); else sessionStorage.removeItem(this.key);
    } catch {}
  }
  record(round: string, map: MapPose, action: MapReplayAction, now: number) {
    const previous = this.rounds.get(round);
    const last = previous?.last;
    if (last && last.x === map.x && last.y === map.y && last.w === map.w && last.h === map.h) return;
    const at = Math.max(Math.round(now), (previous?.through ?? 0) + 1);
    const row = previous ?? { last: map, through: at, frames: [] };
    if (row.frames.length >= MAP_PACKET_LIMIT) {
      row.frames = row.frames.filter((_, i) => i % 2 === 0);
      row.partial = true;
    }
    row.frames.push({ at, map, action }); row.last = map; row.through = at;
    this.rounds.set(round, row); this.save();
  }
  attach(round: string, key: string): MapPacket | undefined {
    const row = this.rounds.get(round);
    if (!row?.frames.length) return;
    // A clue flush immediately followed by a guess needs only one copy on an ordered connection.
    if ([...this.sent.values()].some(sent => sent.round === round && sent.through >= row.through)) return;
    this.sent.set(key, {round, through:row.through});
    return this.packet(row);
  }
  acknowledge(key: string, accepted: boolean) {
    const sent = this.sent.get(key);
    if (!sent) return;
    this.sent.delete(key);
    const row = this.rounds.get(sent.round);
    if (!accepted || !row) return;
    row.frames = row.frames.filter(f => f.at > sent.through);
    if (!row.frames.length) row.partial = undefined;
    this.save();
  }
  reconnect() { this.sent.clear(); }
  clear() { this.sent.clear(); this.rounds.clear(); this.save(); }
}
