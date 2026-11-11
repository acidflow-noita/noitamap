import { signGameTicket as sign } from '../../workers/noitamap-auth/src/game-ticket';
import { verifyGameTicket as verify } from '../../workers/noitamap-guessr/src/tickets';

// Ephemeral fixture keys only. Nothing here can sign production tickets.
const pairs = new Map<string, Promise<{ privateKey: string; publicKey: string }>>();
export function testGameKeys(label: string) {
  let pending = pairs.get(label);
  if (!pending) {
    pending = (async () => {
      const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
      return { privateKey: JSON.stringify(await crypto.subtle.exportKey('jwk', pair.privateKey)),
        publicKey: JSON.stringify(await crypto.subtle.exportKey('jwk', pair.publicKey)) };
    })();
    pairs.set(label, pending);
  }
  return pending;
}
export async function signGameTicket(sub: string, name: string, label: string, identityOrNow?: number | { twitchUserId: string; twitchLogin: string }, now?: number) {
  return sign(sub, name, (await testGameKeys(label)).privateKey, identityOrNow, now);
}
export async function verifyGameTicket(token: string, label: string, now?: number) {
  return verify(token, (await testGameKeys(label)).publicKey, now);
}

export async function signResultManagementTicket(sub: string, name: string, label: string, identity: { twitchUserId: string; twitchLogin: string }, now: number) {
  return sign(sub, name, (await testGameKeys(label)).privateKey, identity, now, 'result-management');
}
