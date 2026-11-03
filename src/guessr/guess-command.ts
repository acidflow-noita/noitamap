import { within, type Bounds, type Point } from './rules';
import { chatEnvelope, readChatEnvelope } from './chat-envelope';

export const GUESS_CHAT_COMMAND = '!noitaguessr_guess';
const RUNES = 'ᚠᚢᚦᚨᚱᚲᚷᚹᚺᚾᛁᛃᛇᛈᛉᛊ';
const encodedPattern = new RegExp(`^!noitaguessr_guess ✦([${RUNES}]+)✦$`, 'i');
const roundIdPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export const isEncodedGuessCommand = (text: string) => !!readChatEnvelope(text) || encodedPattern.test(text.trim().replace(/\s+/gu, ' '));

export interface GuessCommand extends Point {
  round: number;
  maximum?: number;
  roundId?: string;
  userId?: string;
  nonce?: string;
}
export interface GuessIdentity { userId: string; nonce?: Uint8Array; label?: string }
/** Detects copy/paste errors only. This is deliberately obfuscation, not authentication. */
function checksum(bytes: Uint8Array): number {
  let crc = 0xffff;
  for (const byte of bytes) {
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit++) crc = ((crc << 1) ^ (crc & 0x8000 ? 0x1021 : 0)) & 0xffff;
  }
  return crc;
}

/** A compact runic payload hides all numbers and IDs; the prefix stays filterable. */
export function formatGuessCommand(round: number, point: Point, maximum?: number, roundId?: string, identity?: GuessIdentity): string {
  const x = Math.round(point.x), y = Math.round(point.y);
  if (!Number.isSafeInteger(round) || round < 1 || round > 99
    || !Number.isSafeInteger(x) || x < -2147483648 || x > 2147483647
    || !Number.isSafeInteger(y) || y < -2147483648 || y > 2147483647
    || maximum !== undefined && (!Number.isSafeInteger(maximum) || maximum < 0 || maximum > 5000)
    || roundId !== undefined && !roundIdPattern.test(roundId)
    || identity !== undefined && (!/^\d{1,30}$/.test(identity.userId) || identity.nonce !== undefined && identity.nonce.length !== 8))
    throw new Error('Invalid guess coordinates or round.');
  const id = identity ? new TextEncoder().encode(identity.userId) : undefined;
  const data = new Uint8Array((roundId ? 31 : 15) + (id ? id.length + 9 : 0)), view = new DataView(data.buffer);
  data[0] = identity ? 2 : 1; data[1] = round; data[2] = (maximum === undefined ? 0 : 1) | (roundId ? 2 : 0);
  view.setInt32(3, x); view.setInt32(7, y); view.setUint16(11, maximum ?? 5000);
  if (roundId) {
    const hex = roundId.replaceAll('-', '');
    for (let i = 0; i < 16; i++) data[13 + i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  if (id && identity) {
    const offset = roundId ? 29 : 13;
    data[offset] = id.length; data.set(id, offset + 1);
    data.set(identity.nonce ?? crypto.getRandomValues(new Uint8Array(8)), offset + 1 + id.length);
  }
  view.setUint16(data.length - 2, checksum(data.subarray(0, -2)));
  if (identity?.label) return chatEnvelope(identity.label, data);
  return `${GUESS_CHAT_COMMAND} ✦${Array.from(data, byte => RUNES[byte >> 4] + RUNES[byte & 15]).join('')}✦`;
}
function decodePayload(runes: string): GuessCommand | null {
  if (runes.length < 30 || runes.length > 140 || runes.length % 2) return null;
  const bytes = new Uint8Array(runes.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = RUNES.indexOf(runes[i * 2]) * 16 + RUNES.indexOf(runes[i * 2 + 1]);
  const view = new DataView(bytes.buffer), flags = bytes[2];
  if (![1, 2].includes(bytes[0]) || flags & ~3 || view.getUint16(bytes.length - 2) !== checksum(bytes.subarray(0, -2))) return null;
  const offset = flags & 2 ? 29 : 13;
  let userId: string | undefined, nonce: string | undefined;
  if (bytes[0] === 1) { if (bytes.length !== offset + 2) return null; }
  else {
    const length = bytes[offset];
    if (!length || length > 30 || bytes.length !== offset + length + 11) return null;
    userId = new TextDecoder().decode(bytes.subarray(offset + 1, offset + 1 + length));
    if (!/^\d{1,30}$/.test(userId)) return null;
    nonce = Array.from(bytes.subarray(offset + 1 + length, -2), byte => byte.toString(16).padStart(2, '0')).join('');
  }
  const hex = flags & 2 ? Array.from(bytes.subarray(13, 29), byte => byte.toString(16).padStart(2, '0')).join('') : '';
  return {
    round: bytes[1], x: view.getInt32(3), y: view.getInt32(7),
    ...(flags & 1 ? { maximum: view.getUint16(11) } : {}),
    ...(hex ? { roundId: `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}` } : {}),
    ...(userId ? { userId, nonce } : {}),
  };
}

/** Legacy plain commands remain readable for old sessions and the local simulator;
 * live games only admit the encoded format. Neither format attests client costs. */
export function parseGuessCommand(text: unknown, limits: { rounds: number; bounds: Bounds }): GuessCommand | null {
  if (typeof text !== 'string' || text.length > 500) return null;
  const plain = text.replace(/[\u2010-\u2015\u2212\ufe63\uff0d]/gu, '-').replace(/\s+/gu, ' ').trim();
  const hidden = readChatEnvelope(text);
  const encoded = encodedPattern.exec(plain);
  let guess: GuessCommand | null;
  if (hidden) guess = decodePayload(Array.from(hidden, byte => RUNES[byte >> 4] + RUNES[byte & 15]).join(''));
  else if (encoded) guess = decodePayload(encoded[1]);
  else {
    const match = /^!noitaguessr_guess (\d+) ((?:-{1,2} ?|\+ ?)?\d+) ((?:-{1,2} ?|\+ ?)?\d+)(?: (\d+))?(?: #([a-f0-9-]{36}))?$/i.exec(plain);
    if (!match) return null;
    const coordinate = (value: string) => Number(value.replace(' ', '').replace(/^--/, '-'));
    guess = { round: Number(match[1]), x: coordinate(match[2]), y: coordinate(match[3]),
      ...(match[4] === undefined ? {} : { maximum: Number(match[4]) }),
      ...(match[5] === undefined ? {} : { roundId: match[5].toLowerCase() }) };
  }
  if (!guess || ![guess.round, guess.x, guess.y, guess.maximum ?? 5000].every(Number.isSafeInteger)
    || guess.round < 1 || guess.round > limits.rounds
    || guess.maximum !== undefined && (guess.maximum < 0 || guess.maximum > 5000)
    || guess.roundId !== undefined && !roundIdPattern.test(guess.roundId) || !within(guess, limits.bounds)) return null;
  return guess;
}
