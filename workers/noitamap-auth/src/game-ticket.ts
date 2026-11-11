/** Game ticket issuer owned by the auth Worker so this folder can deploy alone.
 * The Guessr Worker verifies this protocol independently. Contract tests compare
 * the issued tokens with its signer and verifier. */
interface GameIdentity {
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

export async function signGameTicket(
  sub: string,
  name: string,
  secret: string,
  identityOrNow: number | { twitchUserId: string; twitchLogin: string } = Date.now(),
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
      ? { twitchUserId: identityOrNow.twitchUserId, twitchLogin: identityOrNow.twitchLogin }
      : {}),
  };
  const header = encode(encoder.encode(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const body = encode(encoder.encode(JSON.stringify(payload)));
  const key = await crypto.subtle.importKey(
    "raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(`${header}.${body}`)));
  return { token: `${header}.${body}.${encode(signature)}`, expiresAt: payload.exp * 1000 };
}
