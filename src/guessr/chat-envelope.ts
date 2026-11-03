// Printable encoding survives chat clients that discard invisible Unicode.
// Older envelopes remain readable while already-open tabs finish updating.
const START = '\u2063', END = '\u2064';
export function chatEnvelope(label: string, bytes: Uint8Array): string {
  const visible = label.replace(/[\p{C}\uFE00-\uFE0F]/gu, '').slice(0, 150);
  const payload = btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
  const message = `${visible} [noitaguessr:${payload}]`;
  if (message.length > 500) throw Error('Chat message exceeds its size limit');
  return message;
}
export function readChatEnvelope(message: string): Uint8Array | null {
  if (message.length > 500) return null;
  const printable = / \[(?:noitaguessr|ng):([A-Za-z0-9_-]+)\]$/.exec(message);
  if (printable) try { return Uint8Array.from(atob(printable[1].replaceAll('-', '+').replaceAll('_', '/')), c => c.charCodeAt(0)); } catch { return null; }
  const match = /\u2063([\uFE00-\uFE0F]+)\u2064$/.exec(message);
  if (!match || match[1].length % 2) return null;
  return Uint8Array.from({ length: match[1].length / 2 }, (_, i) =>
    (match[1].charCodeAt(i * 2) - 0xfe00) * 16 + match[1].charCodeAt(i * 2 + 1) - 0xfe00);
}
