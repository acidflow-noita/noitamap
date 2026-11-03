// Variation selectors keep protocol bytes out of the visible chat text.
// They are encoding, not encryption. Parsers still bind messages to Twitch's sender.
const START = '\u2063', END = '\u2064';
export function chatEnvelope(label: string, bytes: Uint8Array): string {
  const visible = label.replace(/[\p{C}\uFE00-\uFE0F]/gu, '').slice(0, 150);
  const payload = Array.from(bytes, value => String.fromCharCode(0xfe00 + (value >> 4), 0xfe00 + (value & 15))).join('');
  const message = visible + START + payload + END;
  if (message.length > 500) throw Error('Chat message exceeds its size limit');
  return message;
}
export function readChatEnvelope(message: string): Uint8Array | null {
  if (message.length > 500) return null;
  const match = /\u2063([\uFE00-\uFE0F]+)\u2064$/.exec(message);
  if (!match || match[1].length % 2) return null;
  return Uint8Array.from({ length: match[1].length / 2 }, (_, i) =>
    (match[1].charCodeAt(i * 2) - 0xfe00) * 16 + match[1].charCodeAt(i * 2 + 1) - 0xfe00);
}
