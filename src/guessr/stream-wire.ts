import { gameCode, gameIdFromCode } from './routes';
import type { StreamChatMessage } from './stream-state';
import type { LiveRoomView } from './live-room-types';
import type { StreamReveal } from './stream-types';
import { chatEnvelope, readChatEnvelope } from './chat-envelope';

const PREFIX = '!noitaguessr_state';
const PART_SIZE = 420;
const HIDDEN_PART_BYTES = 210;
export const STREAM_RECEIPT_BATCH = 24;
const MAX_COMPRESSED = 32_768, MAX_DECODED = 98_304;
export type StreamWirePayload =
  | { type: 'state'; state: LiveRoomView }
  | { type: 'reveal'; round: number; reveal: StreamReveal }
  | { type: 'receipts'; round: number; keys: string[]; rejected?: boolean };

function base64(bytes: Uint8Array): string {
  let text = '';
  for (let i = 0; i < bytes.length; i += 8192) text += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(text).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}
function bytes(text: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/.test(text)) throw Error('Invalid broadcast encoding');
  return Uint8Array.from(atob(text.replaceAll('-', '+').replaceAll('_', '/')), c => c.charCodeAt(0));
}
async function bounded(stream: ReadableStream<Uint8Array>, limit: number): Promise<Uint8Array<ArrayBuffer>> {
  const reader = stream.getReader(), parts: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read(); if (next.done) break;
      size += next.value.byteLength;
      if (size > limit) throw Error('Broadcast exceeds its size limit');
      parts.push(next.value);
    }
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
  const result = new Uint8Array(size);
  let offset = 0; for (const part of parts) { result.set(part, offset); offset += part.byteLength; }
  return result;
}
/** Explicit public fields only: private round tokens and future answers never enter a snapshot. */
function pack(payload: StreamWirePayload): unknown[] | Uint8Array<ArrayBuffer> {
  if (payload.type === 'state') {
    const s = payload.state, t = s.timing;
    return [0, s.revision, s.hostId, s.phase, s.online, s.paused, s.round, s.roundId, s.clue, s.expiresAt, s.resultId,
      t ? { phase: t.phase, startsAt: t.startsAt, deadline: t.deadline, hostRound: t.hostRound, seconds: t.seconds, revealed: t.revealed } : undefined];
  }
  if (payload.type === 'receipts') {
    if (payload.keys.length > 35 || payload.keys.some(key => !/^[a-f0-9]{16}$/.test(key))) throw Error('Invalid receipts');
    const raw = Uint8Array.from(payload.keys.join('').match(/../g) ?? [], h => parseInt(h, 16));
    return new Uint8Array([payload.rejected ? 254 : 255, payload.round, ...raw]);
  }
  const { roundId, answer, area: a } = payload.reveal;
  return [1, payload.round, roundId, [answer.x, answer.y], {
    id: a.id, label: a.label, originY: a.originY, runs: a.runs, bounds: a.bounds, cells: a.cells,
    difficultyTier: a.difficultyTier, scoring: a.scoring, difficultyRule: a.difficultyRule,
  }];
}
export async function encodeStreamPacket(gameId: string, payload: StreamWirePayload): Promise<string[]> {
  const value = pack(payload);
  const raw = value instanceof Uint8Array ? value : new TextEncoder().encode(JSON.stringify(value));
  if (raw.length > MAX_DECODED) throw Error('Broadcast exceeds its size limit');
  const compressed = await bounded(new Blob([raw]).stream().pipeThrough(new CompressionStream('deflate')), MAX_COMPRESSED);
  const game = Uint8Array.from(gameId.replaceAll('-', '').match(/../g)!, h => parseInt(h, 16));
  const id = crypto.getRandomValues(new Uint8Array(4));
  const total = Math.ceil(compressed.length / HIDDEN_PART_BYTES);
  if (total > 96) throw Error('Too many broadcast parts');
  const label = payload.type === 'receipts' ? 'NoitaGuessr: receipts.' : payload.type === 'reveal' ? 'NoitaGuessr: solution.'
    : payload.state.phase === 'complete' ? 'NoitaGuessr: finished.' : payload.state.phase === 'waiting' ? 'NoitaGuessr: ready.'
    : `NoitaGuessr: round ${payload.state.round}.`;
  return Array.from({ length: total }, (_, i) => chatEnvelope(label,
    new Uint8Array([78, 71, 83, ...game, ...id, i, total, ...compressed.subarray(i * HIDDEN_PART_BYTES, (i + 1) * HIDDEN_PART_BYTES)])));
}

export function streamPacketText(message: string): string {
  const raw = readChatEnvelope(message);
  if (!raw || raw.length < 26 || raw[0] !== 78 || raw[1] !== 71 || raw[2] !== 83) return message;
  const hex = (bytes: Uint8Array) => Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
  const game = hex(raw.subarray(3, 19)), id = `${game.slice(0, 8)}-${game.slice(8, 12)}-${game.slice(12, 16)}-${game.slice(16, 20)}-${game.slice(20)}`;
  return `${PREFIX} ${gameCode(id)} ${hex(raw.subarray(19, 23))} ${raw[23].toString(36)}/${raw[24].toString(36)} ${base64(raw.subarray(25))}`;
}

interface Assembly { created: number; total: number; parts: Map<number, string>; gameId: string; sentAt: number }
/** Only the actual Twitch sender matching the requested channel can publish.
 * Bound partial assemblies and decompression before trusting any JSON. */
export class StreamPacketReader {
  private pending = new Map<string, Assembly>();
  constructor(private channel: string, private expectedGame?: string, private localTest = false) {}
  async receive(message: StreamChatMessage, now = Date.now()): Promise<{ gameId: string; payload: StreamWirePayload; sentAt: number } | null> {
    if (message.player.login !== this.channel || typeof message.text !== 'string' || message.text.length > 500) return null;
    const match = /^!noitaguessr_state ([0-9a-z]{26}) ([0-9a-f]{8}) ([0-9a-z]{1,2})\/([0-9a-z]{1,2}) ([A-Za-z0-9_-]+)$/.exec(streamPacketText(message.text));
    if (!match) return null;
    const gameId = gameIdFromCode(match[1]), part = parseInt(match[3], 36), total = parseInt(match[4], 36);
    if (!gameId || this.expectedGame && gameId !== this.expectedGame || total < 1 || total > 96 || part >= total || match[5].length > PART_SIZE) return null;
    for (const [id, entry] of this.pending) if (now - entry.created > 90_000) this.pending.delete(id);
    const id = `${message.player.id}/${match[1]}/${match[2]}`;
    let entry = this.pending.get(id);
    if (!entry) {
      if (this.pending.size >= 8) this.pending.delete(this.pending.keys().next().value!);
      entry = { created: now, total, parts: new Map(), gameId, sentAt: message.sentAt }; this.pending.set(id, entry);
    }
    if (entry.total !== total || entry.parts.has(part) && entry.parts.get(part) !== match[5]) { this.pending.delete(id); return null; }
    entry.parts.set(part, match[5]); entry.sentAt = Math.max(entry.sentAt, message.sentAt);
    if (entry.parts.size !== total) return null;
    this.pending.delete(id);
    try {
      const compressed = bytes(Array.from({ length: total }, (_, i) => entry!.parts.get(i)).join(''));
      if (compressed.length > MAX_COMPRESSED) return null;
      const decoded = await bounded(new Blob([compressed as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate')), MAX_DECODED);
      if (decoded[0] === 255 || decoded[0] === 254) {
        const round = decoded[1], raw = decoded.subarray(2);
        if (round >= 10 || raw.length % 8 || raw.length > 280) return null;
        const keys = Array.from({ length: raw.length / 8 }, (_, i) => Array.from(raw.subarray(i * 8, i * 8 + 8), b => b.toString(16).padStart(2, '0')).join(''));
        return { gameId, payload: { type: 'receipts', round, keys, ...(decoded[0] === 254 ? { rejected: true } : {}) }, sentAt: entry.sentAt };
      }
      const row = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(decoded));
      if (!Array.isArray(row)) return null;
      let payload: StreamWirePayload;
      if (row[0] === 0 && row.length === 12) {
        const [, revision, hostId, phase, online, paused, round, roundId, clue, expiresAt, resultId, timing] = row;
        if (!Number.isSafeInteger(revision) || revision < 0 || typeof hostId !== 'string' || !/^\d{1,30}$/.test(hostId)
          || !this.localTest && hostId !== message.player.id
          || !['waiting', 'guess', 'reveal', 'complete'].includes(phase) || typeof online !== 'boolean' || typeof paused !== 'boolean'
          || !Number.isInteger(round) || round < 1 || round > 10 || typeof roundId !== 'string' || !/^[a-f0-9-]{36}$/.test(roundId)
          || clue !== null && (typeof clue !== 'string' || !/^[A-Za-z0-9_-]{1,1024}$/.test(clue)) || !Number.isSafeInteger(expiresAt)
          || resultId !== null && resultId !== undefined && resultId !== gameId
          || !timing || !['lobby', 'warmup', 'play'].includes(timing.phase) || !Number.isSafeInteger(timing.startsAt)
          || timing.deadline !== null && !Number.isSafeInteger(timing.deadline)
          || !Number.isInteger(timing.hostRound) || timing.hostRound < 1 || timing.hostRound > 10
          || !Number.isInteger(timing.seconds) || timing.seconds < 0 || timing.seconds > 600) return null;
        payload = { type: 'state', state: { schema: 1, channel: this.channel, gameId, revision, hostId, hostPro: 'active', phase,
          online, paused, round, roundId, clue, expiresAt, ...(resultId ? { resultId } : {}), timing } };
      } else if (row[0] === 1 && row.length === 5 && Number.isInteger(row[1]) && row[1] >= 0 && row[1] < 10) {
        const [, round, roundId, point, area] = row;
        if (typeof roundId !== 'string' || !/^[a-f0-9-]{36}$/.test(roundId) || !Array.isArray(point) || point.length !== 2
          || !point.every(Number.isSafeInteger) || !area || typeof area.id !== 'string' || area.id.length > 256
          || typeof area.label !== 'string' || area.label.length > 256 || !Array.isArray(area.runs) || area.runs.length > 5000) return null;
        payload = { type: 'reveal', round, reveal: { roundId, answer: { x: point[0], y: point[1] }, area } };
      } else return null;
      return { gameId, payload, sentAt: entry.sentAt };
    } catch { return null; }
  }
}

/** Bind a receipt to its round, actual sender and submission nonce. */
export async function guessReceiptKey(roundId: string, userId: string, nonce: string): Promise<string> {
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${roundId}/${userId}/${nonce}`)));
  return Array.from(hash.subarray(0, 8), n => n.toString(16).padStart(2, '0')).join('');
}

interface Publication { frames: string[]; next: number; priority: number; done?: () => void; lost?: () => void }
/** At most 14 messages per rolling 30 seconds and at least 1.8 seconds apart.
 * Coalesce repeated snapshots; never create a response queue per viewer. */
export class StreamBroadcaster {
  private queue = new Map<string, Publication>();
  private serial = new Map<string, number>();
  private sent: number[] = [];
  private timer?: ReturnType<typeof setTimeout>;
  private busy = false;
  private stopped = false;
  private waiters = new Set<() => void>();
  private budgetKey: string;
  constructor(private gameId: string, private send: (message: string) => Promise<unknown>, private failed: (error: unknown) => void, senderId = gameId) {
    this.budgetKey = 'noitamap-guessr-broadcast-budget:' + senderId;
    try {
      const saved = JSON.parse(localStorage.getItem(this.budgetKey) ?? 'null');
      if (Array.isArray(saved)) this.sent = saved.filter(at => Number.isSafeInteger(at) && at > Date.now() - 30000 && at <= Date.now()).sort((a, b) => a - b).slice(-14);
    } catch { /* The live tab still enforces its budget without persistence. */ }
  }
  has(key: string): boolean { return this.queue.has(key); }
  async offer(key: string, payload: StreamWirePayload, priority = 1, done?: () => void, lost?: () => void): Promise<void> {
    if (this.stopped) return;
    const version = (this.serial.get(key) ?? 0) + 1; this.serial.set(key, version);
    const frames = await encodeStreamPacket(this.gameId, payload);
    if (this.stopped || this.serial.get(key) !== version) return;
    if (this.queue.size >= 64 && !this.queue.has(key)) throw Error('Broadcast queue is full');
    this.queue.set(key, { frames, next: 0, priority, done, lost }); this.pump();
  }
  private pump(): void {
    if (this.busy || this.stopped || !this.queue.size) return;
    clearTimeout(this.timer);
    const now = Date.now(); this.sent = this.sent.filter(at => at > now - 30_000);
    const wait = Math.max(0, (this.sent.at(-1) ?? 0) + 1800 - now, this.sent.length >= 14 ? this.sent[0] + 30_001 - now : 0);
    if (wait) { this.timer = setTimeout(() => this.pump(), wait); return; }
    const [key, entry] = [...this.queue].sort((a, b) => a[1].priority - b[1].priority)[0];
    this.busy = true; this.sent.push(now);
    try { localStorage.setItem(this.budgetKey, JSON.stringify(this.sent)); } catch { /* Optional refresh protection. */ }
    void this.send(entry.frames[entry.next]).then(() => {
      if (this.stopped || this.queue.get(key) !== entry) return;
      if (++entry.next === entry.frames.length) { this.queue.delete(key); entry.done?.(); }
    }).catch(error => {
      if (this.queue.get(key) === entry) this.queue.delete(key);
      if (!this.stopped) { entry.lost?.(); this.failed(error); }
    }).finally(() => { this.busy = false; this.pump(); if (!this.queue.size) this.resolveDrain(); });
  }
  drain(): Promise<void> {
    return !this.busy && !this.queue.size ? Promise.resolve() : new Promise(resolve => this.waiters.add(resolve));
  }
  private resolveDrain(): void { for (const done of this.waiters) done(); this.waiters.clear(); }
  dispose(): void { this.stopped = true; clearTimeout(this.timer); this.queue.clear(); this.serial.clear(); this.resolveDrain(); }
}
