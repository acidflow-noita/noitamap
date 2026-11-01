/** Game-only bearer tickets. Never use the login/refresh signing key here. */
export interface GameIdentity {
  sub: string;
  name: string;
  pro: true;
  iat: number;
  exp: number;
  aud: "noitamap-guessr";
  typ: "game";
  v: 1;
  twitchUserId?: string;
  twitchLogin?: string;
}
const encoder = new TextEncoder();
function encode(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}
function decode(value: string): Uint8Array {
  return Uint8Array.from(
    atob(value.replaceAll("-", "+").replaceAll("_", "/")),
    (c) => c.charCodeAt(0),
  );
}
export async function signGameTicket(
  sub: string,
  name: string,
  secret: string,
  identityOrNow:
    number | { twitchUserId: string; twitchLogin: string } = Date.now(),
  now = typeof identityOrNow === "number" ? identityOrNow : Date.now(),
): Promise<{ token: string; expiresAt: number }> {
  if (secret.length < 32) throw new Error("Game signing key is not configured");
  const iat = Math.floor(now / 1000);
  const payload: GameIdentity = {
    v: 1,
    typ: "game",
    aud: "noitamap-guessr",
    sub,
    name: name.slice(0, 48),
    pro: true,
    iat,
    exp: iat + 1200,
    ...(typeof identityOrNow === "object"
      ? {
          twitchUserId: identityOrNow.twitchUserId,
          twitchLogin: identityOrNow.twitchLogin,
        }
      : {}),
  };
  const header = encode(
    encoder.encode(JSON.stringify({ alg: "HS256", typ: "JWT" })),
  );
  const body = encode(encoder.encode(JSON.stringify(payload)));
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, encoder.encode(`${header}.${body}`)),
  );
  return {
    token: `${header}.${body}.${encode(sig)}`,
    expiresAt: payload.exp * 1000,
  };
}
export async function verifyGameTicket(
  token: string,
  secret: string,
  now = Date.now(),
): Promise<GameIdentity | null> {
  if (token.length > 4096 || secret.length < 32) return null;
  try {
    const parts = token.split(".");
    if (parts.length !== 3 || parts.some((p) => !/^[\w-]+$/.test(p)))
      return null;
    const header = JSON.parse(new TextDecoder().decode(decode(parts[0])));
    if (header.alg !== "HS256" || header.typ !== "JWT") return null;
    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    );
    if (
      !(await crypto.subtle.verify(
        "HMAC",
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
      p.v !== 1 ||
      p.typ !== "game" ||
      p.aud !== "noitamap-guessr" ||
      p.pro !== true ||
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
      p.name.length > 48 ||
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
