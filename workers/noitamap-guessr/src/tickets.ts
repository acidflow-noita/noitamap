/** Game-only bearer tickets. Never use the login/refresh signing key here. */
export interface GameIdentity {
  sub: string;
  name: string;
  pro: boolean;
  iat: number;
  exp: number;
  aud: "noitamap-guessr";
  typ: "game" | "result-management";
  v: 2;
  twitchUserId?: string;
  twitchLogin?: string;
}
const encoder = new TextEncoder();
function decode(value: string): Uint8Array {
  return Uint8Array.from(
    atob(value.replaceAll("-", "+").replaceAll("_", "/")),
    (c) => c.charCodeAt(0),
  );
}
async function verifyTicket(
  token: string,
  publicKey: string,
  now = Date.now(),
  purpose: GameIdentity["typ"] = "game",
): Promise<GameIdentity | null> {
  if (token.length > 4096 || !publicKey || publicKey.length > 2048) return null;
  try {
    const parts = token.split(".");
    if (parts.length !== 3 || parts.some((p) => !/^[\w-]+$/.test(p)))
      return null;
    const header = JSON.parse(new TextDecoder().decode(decode(parts[0])));
    if (header.alg !== "ES256" || header.typ !== "JWT" || header.kid !== "game-v2") return null;
    const jwk = JSON.parse(publicKey) as JsonWebKey;
    if (jwk.kty !== 'EC' || jwk.crv !== 'P-256' || jwk.d) return null;
    const key = await crypto.subtle.importKey(
      "jwk",
      jwk,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    if (
      !(await crypto.subtle.verify(
        { name: "ECDSA", hash: "SHA-256" },
        key,
        decode(parts[2]).buffer as ArrayBuffer,
        encoder.encode(parts[0] + "." + parts[1]),
      ))
    )
      return null;
    const p = JSON.parse(
      new TextDecoder().decode(decode(parts[1])),
    ) as GameIdentity;
    const seconds = now / 1000;
    if (
      p.v !== 2 ||
      p.typ !== purpose ||
      p.aud !== "noitamap-guessr" ||
      p.pro !== (purpose === "game") ||
      typeof p.sub !== "string" ||
      !/^(twitch|patreon|account):[^\s:]{1,100}$/.test(p.sub) ||
      (p.twitchUserId !== undefined &&
        (typeof p.twitchUserId !== "string" ||
          !/^\d{1,30}$/.test(p.twitchUserId))) ||
      (p.twitchLogin !== undefined &&
        (typeof p.twitchLogin !== "string" ||
          !/^[a-z0-9_]{1,25}$/.test(p.twitchLogin))) ||
      (p.twitchUserId === undefined) !== (p.twitchLogin === undefined) ||
      typeof p.name !== "string" ||
      !p.name.trim() || p.name !== p.name.trim() || p.name.length > 48 || /[\p{Cc}\p{Cf}\p{Cs}<>]/u.test(p.name) ||
      !Number.isInteger(p.iat) ||
      !Number.isInteger(p.exp) ||
      p.iat > seconds + 30 ||
      p.exp <= seconds ||
      p.exp <= p.iat ||
      p.exp - p.iat > 1200
    )
      return null;
    return p;
  } catch {
    return null;
  }
}

export const verifyGameTicket = (token: string, publicKey: string, now = Date.now()) => verifyTicket(token, publicKey, now, 'game');
export const verifyResultManagementTicket = (token: string, publicKey: string, now = Date.now()) => verifyTicket(token, publicKey, now, 'result-management');
