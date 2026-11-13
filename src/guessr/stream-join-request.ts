import { readChatEnvelope } from './chat-envelope';
import { gameIdFromCode } from './routes';

export function streamJoinRequest(message: string): { channel: string; gameId?: string } | null {
  if (message.length > 500) return null;
  const hidden = readChatEnvelope(message);
  const text = hidden?.[0] === 78 && hidden[1] === 71 && hidden[2] === 82 ? new TextDecoder().decode(hidden.subarray(3)) : message;
  const match = /^!noitaguessr_(?:sync|recover) ([a-z0-9_]{1,25}) ([0-9a-z]{26}|-) ([0-9a-f]{1,3})(?: ([0-9]:[0-9a-f]{16}(?:,[0-9]:[0-9a-f]{16}){0,9}))?$/.exec(text);
  if (!match) return null;
  return { channel: match[1], gameId: match[2] === '-' ? undefined : gameIdFromCode(match[2]) };
}
