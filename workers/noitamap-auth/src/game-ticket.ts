/** Game ticket issuer owned by the auth Worker so this folder can deploy alone.
 * The Guessr Worker verifies this protocol independently. Contract tests compare
 * the issued tokens against its public-key-only verifier. */
interface GameIdentity {
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
function encode(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

export async function signGameTicket(
  sub: string,
  name: string,
  privateKey: string,
  identityOrNow: number | { twitchUserId: string; twitchLogin: string } = Date.now(),
  now = typeof identityOrNow === "number" ? identityOrNow : Date.now(),
  purpose: GameIdentity["typ"] = "game",
): Promise<{ token: string; expiresAt: number }> {
  if (privateKey.length > 2048) throw new Error('Game signing key is not configured');
  const jwk = JSON.parse(privateKey) as JsonWebKey;
  if (jwk.kty !== 'EC' || jwk.crv !== 'P-256' || !jwk.d) throw new Error('Game signing key is not configured');
  const iat = Math.floor(now / 1000);
  const payload: GameIdentity = {
    v: 2,
    typ: purpose,
    aud: "noitamap-guessr",
    sub,
    name: name.replace(/[\p{Cc}\p{Cf}\p{Cs}<>]/gu, '').trim().slice(0, 48) || 'Player',
    pro: purpose === 'game',
    iat,
    exp: iat + 1200,
    ...(typeof identityOrNow === "object"
      ? { twitchUserId: identityOrNow.twitchUserId, twitchLogin: identityOrNow.twitchLogin }
      : {}),
  };
  const header = encode(encoder.encode(JSON.stringify({ alg: "ES256", typ: "JWT", kid: "game-v2" })));
  const body = encode(encoder.encode(JSON.stringify(payload)));
  const key = await crypto.subtle.importKey(
    "jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"],
  );
  const signature = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, encoder.encode(`${header}.${body}`)));
  return { token: `${header}.${body}.${encode(signature)}`, expiresAt: payload.exp * 1000 };
}
