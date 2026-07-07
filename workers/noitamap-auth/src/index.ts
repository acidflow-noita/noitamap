/**
 * Noitamap Auth Worker (Stateless)
 * Handles Patreon OAuth and issues short-lived JWTs. No database required.
 *
 * Environment Variables:
 * - PATREON_CLIENT_ID: OAuth Client ID
 * - PATREON_CLIENT_SECRET: OAuth Client Secret
 * - PATREON_CAMPAIGN_ID: The Campaign ID to check membership against
 * - WORKER_URL: The public URL of this worker (e.g., https://auth.noitamap.com)
 * - ALLOWED_ORIGINS: Comma-separated list of allowed origins
 * - JWT_SECRET: Secret for signing JWTs and HMAC state tokens
 */

// Secrets Store bindings return objects with .get(), plain vars are strings
interface SecretStoreSecret {
  get(): Promise<string>;
}

interface Env {
  // Secrets Store bindings
  PATREON_CLIENT_ID: SecretStoreSecret;
  PATREON_CLIENT_SECRET: SecretStoreSecret;
  PATREON_CAMPAIGN_ID: SecretStoreSecret;
  JWT_SECRET: SecretStoreSecret;
  CREATOR_USER_ID: SecretStoreSecret;

  // Plain environment variables (from wrangler.jsonc vars)
  WORKER_URL: string;
  ALLOWED_ORIGINS: string;

  // -- Twitch OAuth (piping present, UI dormant until platform approval) --
  // CLIENT_ID/SECRET exist in the Secrets Store now. The broadcaster bindings
  // are created only after the one-time /auth/twitch/broadcaster-setup grant,
  // so they are OPTIONAL here and every Twitch handler resolves them lazily and
  // degrades gracefully (is_subscriber=false) when absent. This keeps the shared
  // resolveSecrets() Patreon path unaffected and lets the worker deploy before
  // the broadcaster secrets exist.
  TWITCH_CLIENT_ID?: SecretStoreSecret;
  TWITCH_CLIENT_SECRET?: SecretStoreSecret;
  TWITCH_BROADCASTER_ID?: SecretStoreSecret;
  TWITCH_BROADCASTER_REFRESH_TOKEN?: SecretStoreSecret;
  // Optional shared-secret gate for the broadcaster-setup route.
  TWITCH_SETUP_KEY?: SecretStoreSecret;
}

// Resolved secrets for use throughout request handling
interface Secrets {
  patreonClientId: string;
  patreonClientSecret: string;
  patreonCampaignId: string;
  jwtSecret: string;
  creatorUserId: string;
}

// -- Types --

interface JWTPayload {
  sub: string; // user_id
  username: string;
  nickname: string | null;
  is_follower: boolean;
  is_subscriber: boolean;
  provider?: "patreon" | "twitch";
  iat: number;
  exp: number;
}

interface PatreonTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  scope: string;
  token_type: string;
}

interface PatreonIdentityResponse {
  data: {
    id: string;
    type: "user";
    attributes: {
      vanity?: string | null;
      image_url?: string;
    };
    relationships?: {
      memberships?: {
        data: Array<{ id: string; type: "member" }>;
      };
    };
  };
  included?: Array<{
    type: string;
    id: string;
    attributes: {
      patron_status: string | null;
      currently_entitled_amount_cents: number;
      campaign_lifetime_support_cents: number;
    };
    relationships?: {
      campaign?: {
        data: { type: "campaign"; id: string };
      };
    };
  }>;
}

// -- Constants --

// Short-lived access JWT (what auth-service.ts sends on every /auth/check).
const JWT_EXPIRY_SECONDS = 24 * 60 * 60; // 24 hours
// Long-lived refresh JWT. Carries the provider refresh_token AES-encrypted in
// its payload so the client can silently re-mint an access JWT for months
// without another OAuth round-trip. Worker stays stateless — no D1/KV.
const REFRESH_JWT_EXPIRY_SECONDS = 90 * 24 * 60 * 60; // 90 days
const STATE_EXPIRY_MS = 10 * 60 * 1000; // 10 minutes

// -- Refresh-token crypto (AES-GCM) --
// The provider refresh_token is a bearer credential for the user's Patreon/
// Twitch account, so it must NOT be readable from localStorage. We encrypt it
// with a key derived from JWT_SECRET before embedding it in the refresh JWT;
// only the worker can decrypt. AES-GCM gives us confidentiality + integrity.

async function aesKey(secret: string): Promise<CryptoKey> {
  // Derive a stable 256-bit key from JWT_SECRET via SHA-256.
  const enc = new TextEncoder();
  const hash = await crypto.subtle.digest("SHA-256", enc.encode(`refresh-enc:${secret}`));
  return crypto.subtle.importKey("raw", hash, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

async function encryptSecret(plaintext: string, secret: string): Promise<string> {
  const key = await aesKey(secret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(plaintext),
  );
  // iv.ciphertext, both base64url.
  return `${base64url(iv)}.${base64url(ct)}`;
}

async function decryptSecret(blob: string, secret: string): Promise<string | null> {
  try {
    const [ivB64, ctB64] = blob.split(".");
    if (!ivB64 || !ctB64) return null;
    const key = await aesKey(secret);
    const iv = base64urlToBytes(ivB64);
    const ct = base64urlToBytes(ctB64);
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
    return new TextDecoder().decode(pt);
  } catch {
    return null;
  }
}

// Refresh JWT payload: identifies the user + provider and carries the encrypted
// provider refresh_token. Kept separate from the access JWTPayload so an access
// token can never be replayed as a refresh token (different `typ`).
interface RefreshPayload {
  typ: "refresh";
  sub: string;
  provider: "patreon" | "twitch";
  enc: string; // encryptSecret(providerRefreshToken)
  iat: number;
  exp: number;
}

// -- Main Worker --

async function resolveSecrets(env: Env): Promise<Secrets> {
  const [patreonClientId, patreonClientSecret, patreonCampaignId, jwtSecret, creatorUserId] = await Promise.all([
    env.PATREON_CLIENT_ID.get(),
    env.PATREON_CLIENT_SECRET.get(),
    env.PATREON_CAMPAIGN_ID.get(),
    env.JWT_SECRET.get(),
    env.CREATOR_USER_ID.get(),
  ]);
  return { patreonClientId, patreonClientSecret, patreonCampaignId, jwtSecret, creatorUserId };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "";
    const allowedOrigin = getAllowedOrigin(origin, env);

    // CORS Preflight
    if (request.method === "OPTIONS") {
      return handleCORS(allowedOrigin);
    }

    try {
      const secrets = await resolveSecrets(env);

      switch (url.pathname) {
        case "/auth/login":
          return handlePatreonLogin(request, env, secrets);
        case "/auth/callback":
          return handlePatreonCallback(request, env, secrets);
        case "/auth/check":
          return handleAuthCheck(request, secrets, allowedOrigin);
        case "/auth/refresh":
          return handleRefresh(request, env, secrets, allowedOrigin);
        // -- Twitch (piping live, client UI hidden until platform approval) --
        case "/auth/twitch/login":
          return handleTwitchLogin(request, env, secrets);
        case "/auth/twitch/callback":
          return handleTwitchCallback(request, env, secrets);
        // One-time broadcaster grant: wuote hits this once to mint the
        // channel:read:subscriptions refresh token that the sub-check uses.
        case "/auth/twitch/broadcaster-setup":
          return handleBroadcasterSetup(request, env, secrets);
        case "/auth/twitch/broadcaster-callback":
          return handleBroadcasterCallback(request, env, secrets);
        default:
          return new Response("Not Found", { status: 404 });
      }
    } catch (error) {
      console.error("Worker Error:", error);
      return new Response("Internal Server Error", { status: 500 });
    }
  },
};

// -- Handlers --

async function handlePatreonLogin(request: Request, env: Env, secrets: Secrets): Promise<Response> {
  const url = new URL(request.url);
  const redirectUrl = url.searchParams.get("redirect") || "";

  // Create a signed state token: base64url(payload).base64url(hmac)
  const expiresAt = Date.now() + STATE_EXPIRY_MS;
  const statePayload = `${redirectUrl}|${expiresAt}`;
  const state = await signState(statePayload, secrets.jwtSecret);

  // Construct the callback URL
  const callbackUri = `${env.WORKER_URL}/auth/callback`;

  // Patreon OAuth V2 Authorization URL
  const authUrl = new URL("https://www.patreon.com/oauth2/authorize");
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("client_id", secrets.patreonClientId);
  authUrl.searchParams.set("redirect_uri", callbackUri);
  authUrl.searchParams.set("scope", "identity identity.memberships");
  authUrl.searchParams.set("state", state);

  return Response.redirect(authUrl.toString(), 302);
}

async function handlePatreonCallback(request: Request, env: Env, secrets: Secrets): Promise<Response> {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");

  // Validate & decode state
  if (!state) return redirectToError(env, "missing_state");

  const statePayload = await verifyState(state, secrets.jwtSecret);
  if (!statePayload) return redirectToError(env, "invalid_state");

  const [redirectUrl, expiresAtStr] = statePayload.split("|");
  const expiresAt = parseInt(expiresAtStr, 10);
  if (isNaN(expiresAt) || Date.now() > expiresAt) {
    return redirectToError(env, "expired_state");
  }

  // SECURITY: the signed state only proves WE signed the redirect — an attacker
  // can still request /auth/login?redirect=https://evil with their own browser
  // and get it signed. Validate the redirect's origin against ALLOWED_ORIGINS
  // before we ever append the token to it, or we hand the victim's JWT to any
  // site (open redirect → token exfiltration).
  const finalRedirectUrl = allowedRedirect(redirectUrl, env);

  if (error) {
    return Response.redirect(`${finalRedirectUrl}?auth_error=${encodeURIComponent(error)}`, 302);
  }
  if (!code) {
    return Response.redirect(`${finalRedirectUrl}?auth_error=missing_code`, 302);
  }

  try {
    // 1. Exchange Code for Token
    const tokenResponse = await fetch("https://www.patreon.com/api/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        grant_type: "authorization_code",
        client_id: secrets.patreonClientId,
        client_secret: secrets.patreonClientSecret,
        redirect_uri: `${env.WORKER_URL}/auth/callback`,
      }),
    });

    if (!tokenResponse.ok) {
      const errText = await tokenResponse.text();
      console.error("Patreon Token Error:", errText);
      return Response.redirect(`${finalRedirectUrl}?auth_error=token_exchange_failed`, 302);
    }

    const tokenData = (await tokenResponse.json()) as PatreonTokenResponse;

    // 2-3. Identity + membership status via the shared helper (also used by
    //      /auth/refresh so a renewed session re-checks the sub, catching
    //      cancellations without forcing the user to log in again).
    const membership = await fetchPatreonMembership(tokenData.access_token, secrets);
    if (!membership) {
      return Response.redirect(`${finalRedirectUrl}?auth_error=identity_fetch_failed`, 302);
    }

    // 4. Issue a short access JWT + a long refresh JWT. The refresh JWT carries
    //    the Patreon refresh_token AES-encrypted, so the client re-mints access
    //    tokens silently for 90 days (no re-login) while the worker stays
    //    stateless.
    const now = Math.floor(Date.now() / 1000);
    const jwt = await signJWT(
      {
        sub: membership.userId,
        username: membership.username,
        nickname: membership.nickname,
        is_follower: membership.isFollower,
        is_subscriber: membership.isSubscriber,
        provider: "patreon",
        iat: now,
        exp: now + JWT_EXPIRY_SECONDS,
      },
      secrets.jwtSecret,
    );
    const refreshJwt = await signRefreshJWT(
      {
        typ: "refresh",
        sub: membership.userId,
        provider: "patreon",
        enc: await encryptSecret(tokenData.refresh_token, secrets.jwtSecret),
        iat: now,
        exp: now + REFRESH_JWT_EXPIRY_SECONDS,
      },
      secrets.jwtSecret,
    );

    // 5. Redirect with tokens
    const redirectUrlObj = new URL(finalRedirectUrl);
    redirectUrlObj.searchParams.set("auth", "success");
    redirectUrlObj.searchParams.set("token", jwt);
    redirectUrlObj.searchParams.set("refresh_token", refreshJwt);

    return new Response(null, {
      status: 302,
      headers: { Location: redirectUrlObj.toString() },
    });
  } catch (err) {
    console.error("Callback Exception:", err);
    return Response.redirect(`${finalRedirectUrl}?auth_error=server_error`, 302);
  }
}

interface PatreonMembership {
  userId: string;
  username: string;
  nickname: string | null;
  isFollower: boolean;
  isSubscriber: boolean;
}

/**
 * Fetch a Patreon user's identity + campaign membership from an access token
 * and reduce it to our follower/subscriber flags. Shared by the login callback
 * and /auth/refresh so a renewed session re-evaluates sub status (a cancelled
 * pledge drops isSubscriber on the next daily refresh). Returns null on a failed
 * identity fetch. Privacy: requests only vanity + image, never full_name.
 */
async function fetchPatreonMembership(accessToken: string, secrets: Secrets): Promise<PatreonMembership | null> {
  const identityUrl = new URL("https://www.patreon.com/api/oauth2/v2/identity");
  identityUrl.searchParams.set("include", "memberships,memberships.campaign");
  identityUrl.searchParams.set("fields[user]", "vanity,image_url");
  identityUrl.searchParams.set(
    "fields[member]",
    "patron_status,currently_entitled_amount_cents,campaign_lifetime_support_cents",
  );

  const identityResponse = await fetch(identityUrl.toString(), {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!identityResponse.ok) {
    console.error("Patreon Identity Error:", await identityResponse.text());
    return null;
  }

  const identityData = (await identityResponse.json()) as PatreonIdentityResponse;
  const user = identityData.data;

  let isFollower = false;
  let isSubscriber = false;

  // Creator bypass — grant full access to the campaign owner.
  if (secrets.creatorUserId && user.id === secrets.creatorUserId) {
    isFollower = true;
    isSubscriber = true;
  } else if (identityData.included) {
    for (const item of identityData.included) {
      if (item.type !== "member") continue;
      const campaignId = item.relationships?.campaign?.data?.id;
      if (secrets.patreonCampaignId && campaignId !== secrets.patreonCampaignId) continue;
      isFollower = true;
      if (item.attributes.patron_status === "active_patron" && item.attributes.currently_entitled_amount_cents > 0) {
        isSubscriber = true;
      }
    }
  }

  return {
    userId: user.id,
    // Default to "Patron" if no vanity is set, so we never use/store full name.
    username: user.attributes.vanity || "Patron",
    nickname: user.attributes.vanity || null,
    isFollower,
    isSubscriber,
  };
}

async function handleAuthCheck(request: Request, secrets: Secrets, allowedOrigin: string): Promise<Response> {
  const authHeader = request.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return jsonResponse({ authenticated: false }, allowedOrigin);
  }

  const token = authHeader.substring(7);
  const payload = await verifyJWT(token, secrets.jwtSecret);
  if (!payload) {
    return jsonResponse({ authenticated: false }, allowedOrigin);
  }

  return jsonResponse(
    {
      authenticated: true,
      username: payload.username,
      isFollower: payload.is_follower,
      isSubscriber: payload.is_subscriber,
      provider: payload.provider || "patreon",
    },
    allowedOrigin,
  );
}

/**
 * Silent session renewal (stops the 24h logout). The client POSTs its refresh
 * JWT as `Authorization: Bearer <refreshJwt>` when its access JWT has expired.
 * We decrypt the stored provider refresh_token, exchange it for a fresh provider
 * access token, RE-CHECK membership (so a cancelled sub loses Pro on the next
 * renewal), and return a new access+refresh pair. Stateless — no session store.
 */
async function handleRefresh(request: Request, env: Env, secrets: Secrets, allowedOrigin: string): Promise<Response> {
  const authHeader = request.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) return jsonResponse({ authenticated: false }, allowedOrigin);

  const refresh = await verifyRefreshJWT(authHeader.substring(7), secrets.jwtSecret);
  if (!refresh) return jsonResponse({ authenticated: false }, allowedOrigin);

  const providerRefreshToken = await decryptSecret(refresh.enc, secrets.jwtSecret);
  if (!providerRefreshToken) return jsonResponse({ authenticated: false }, allowedOrigin);

  try {
    if (refresh.provider === "patreon") return await refreshPatreon(providerRefreshToken, secrets, allowedOrigin);
    if (refresh.provider === "twitch") return await refreshTwitch(env, providerRefreshToken, secrets, allowedOrigin);
    return jsonResponse({ authenticated: false }, allowedOrigin);
  } catch (err) {
    console.error("Refresh exception:", err);
    return jsonResponse({ authenticated: false }, allowedOrigin);
  }
}

/** Issue a fresh access+refresh pair as JSON (used by both refresh paths). */
async function issueSessionJson(
  payload: { sub: string; username: string; nickname: string | null; is_follower: boolean; is_subscriber: boolean; provider: "patreon" | "twitch" },
  providerRefreshToken: string,
  secrets: Secrets,
  allowedOrigin: string,
): Promise<Response> {
  const now = Math.floor(Date.now() / 1000);
  const token = await signJWT({ ...payload, iat: now, exp: now + JWT_EXPIRY_SECONDS }, secrets.jwtSecret);
  const refresh_token = await signRefreshJWT(
    {
      typ: "refresh",
      sub: payload.sub,
      provider: payload.provider,
      enc: await encryptSecret(providerRefreshToken, secrets.jwtSecret),
      iat: now,
      exp: now + REFRESH_JWT_EXPIRY_SECONDS,
    },
    secrets.jwtSecret,
  );
  return jsonResponse(
    {
      authenticated: true,
      token,
      refresh_token,
      username: payload.username,
      isFollower: payload.is_follower,
      isSubscriber: payload.is_subscriber,
      provider: payload.provider,
    },
    allowedOrigin,
  );
}

async function refreshPatreon(providerRefreshToken: string, secrets: Secrets, allowedOrigin: string): Promise<Response> {
  const tokenRes = await fetch("https://www.patreon.com/api/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: providerRefreshToken,
      client_id: secrets.patreonClientId,
      client_secret: secrets.patreonClientSecret,
    }),
  });
  if (!tokenRes.ok) {
    console.error("Patreon refresh failed:", await tokenRes.text());
    return jsonResponse({ authenticated: false }, allowedOrigin);
  }
  const tokenData = (await tokenRes.json()) as PatreonTokenResponse;
  const membership = await fetchPatreonMembership(tokenData.access_token, secrets);
  if (!membership) return jsonResponse({ authenticated: false }, allowedOrigin);

  // Patreon rotates the refresh_token (single-use); store the new one, or fall
  // back to the one we just used if a rotation wasn't returned.
  return issueSessionJson(
    {
      sub: membership.userId,
      username: membership.username,
      nickname: membership.nickname,
      is_follower: membership.isFollower,
      is_subscriber: membership.isSubscriber,
      provider: "patreon",
    },
    tokenData.refresh_token || providerRefreshToken,
    secrets,
    allowedOrigin,
  );
}

async function refreshTwitch(env: Env, viewerRefreshToken: string, secrets: Secrets, allowedOrigin: string): Promise<Response> {
  const twitch = await resolveTwitchSecrets(env);
  if (!twitch) return jsonResponse({ authenticated: false }, allowedOrigin);

  const tokenRes = await fetch(TWITCH_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: twitch.clientId,
      client_secret: twitch.clientSecret,
      grant_type: "refresh_token",
      refresh_token: viewerRefreshToken,
    }),
  });
  if (!tokenRes.ok) {
    console.error("Twitch viewer refresh failed:", await tokenRes.text());
    return jsonResponse({ authenticated: false }, allowedOrigin);
  }
  const tokenData = (await tokenRes.json()) as { access_token: string; refresh_token?: string };
  const viewer = await fetchTwitchUser(tokenData.access_token, twitch.clientId);
  if (!viewer) return jsonResponse({ authenticated: false }, allowedOrigin);

  const isSubscriber = await checkTwitchSubscription(env, twitch, viewer.id);
  return issueSessionJson(
    {
      sub: viewer.id,
      username: viewer.display_name || viewer.login || "Twitch user",
      nickname: viewer.display_name || null,
      is_follower: false,
      is_subscriber: isSubscriber,
      provider: "twitch",
    },
    tokenData.refresh_token || viewerRefreshToken,
    secrets,
    allowedOrigin,
  );
}

// -- Helpers --

function getAllowedOrigin(origin: string, env: Env): string {
  const allowed = env.ALLOWED_ORIGINS.split(",").map((o) => o.trim());
  return allowed.includes(origin) ? origin : allowed[0];
}

/**
 * Resolve the post-login redirect to a trusted absolute URL. The token is
 * appended to this URL, so it MUST point at an allowed origin — otherwise the
 * flow is an open redirect that leaks the JWT. Returns the original URL when
 * its origin is allowlisted, else the first allowed origin as a safe fallback.
 */
function allowedRedirect(redirectUrl: string, env: Env): string {
  const allowed = env.ALLOWED_ORIGINS.split(",").map((o) => o.trim()).filter(Boolean);
  const fallback = allowed[0] || "https://noitamap.com";
  if (!redirectUrl) return fallback;
  try {
    const u = new URL(redirectUrl);
    return allowed.includes(u.origin) ? redirectUrl : fallback;
  } catch {
    return fallback;
  }
}

function handleCORS(allowedOrigin: string): Response {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": allowedOrigin,
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Allow-Credentials": "true",
      "Access-Control-Max-Age": "86400",
    },
  });
}

function jsonResponse(data: unknown, allowedOrigin: string): Response {
  return new Response(JSON.stringify(data), {
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": allowedOrigin,
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Allow-Credentials": "true",
    },
  });
}

function redirectToError(env: Env, error: string): Response {
  const allowed = env.ALLOWED_ORIGINS.split(",").map((o) => o.trim());
  const fallback = allowed[0] || "https://noitamap.com";
  return Response.redirect(`${fallback}?auth_error=${error}`, 302);
}

// -- HMAC State Utils --

async function signState(payload: string, secret: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  const payloadB64 = base64url(enc.encode(payload));
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(payloadB64));
  return `${payloadB64}.${base64url(sig)}`;
}

async function verifyState(state: string, secret: string): Promise<string | null> {
  const parts = state.split(".");
  if (parts.length !== 2) return null;
  const [payloadB64, sigB64] = parts;

  const enc = new TextEncoder();
  try {
    const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
      "verify",
    ]);
    const sigStr = sigB64.replace(/-/g, "+").replace(/_/g, "/");
    const binSig = atob(sigStr);
    const sigBytes = new Uint8Array(binSig.length);
    for (let i = 0; i < binSig.length; i++) sigBytes[i] = binSig.charCodeAt(i);

    const valid = await crypto.subtle.verify("HMAC", key, sigBytes, enc.encode(payloadB64));
    if (!valid) return null;

    const payloadStr = atob(payloadB64.replace(/-/g, "+").replace(/_/g, "/"));
    return payloadStr;
  } catch {
    return null;
  }
}

// -- JWT Utils --

function base64url(data: ArrayBuffer | Uint8Array): string {
  const bytes = new Uint8Array(data);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64urlToBytes(b64url: string): Uint8Array {
  const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// Refresh JWT: same HS256 scheme as the access JWT but a distinct payload
// shape (typ:"refresh"). verifyRefreshJWT rejects anything without typ:"refresh"
// so an access token can't be replayed here and vice-versa.
async function signRefreshJWT(payload: RefreshPayload, secret: string): Promise<string> {
  const enc = new TextEncoder();
  const headerB64 = base64url(enc.encode(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const payloadB64 = base64url(enc.encode(JSON.stringify(payload)));
  const input = `${headerB64}.${payloadB64}`;
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(input));
  return `${input}.${base64url(sig)}`;
}

async function verifyRefreshJWT(token: string, secret: string): Promise<RefreshPayload | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [headerB64, payloadB64, sigB64] = parts;
  const enc = new TextEncoder();
  try {
    const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
    const valid = await crypto.subtle.verify("HMAC", key, base64urlToBytes(sigB64), enc.encode(`${headerB64}.${payloadB64}`));
    if (!valid) return null;
    const payload = JSON.parse(new TextDecoder().decode(base64urlToBytes(payloadB64))) as RefreshPayload;
    if (payload.typ !== "refresh") return null;
    if (payload.exp < Date.now() / 1000) return null;
    return payload;
  } catch {
    return null;
  }
}

async function signJWT(payload: JWTPayload, secret: string): Promise<string> {
  const enc = new TextEncoder();
  const header = { alg: "HS256", typ: "JWT" };
  const headerB64 = base64url(enc.encode(JSON.stringify(header)));
  const payloadB64 = base64url(enc.encode(JSON.stringify(payload)));
  const input = `${headerB64}.${payloadB64}`;

  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(input));
  return `${input}.${base64url(sig)}`;
}

async function verifyJWT(token: string, secret: string): Promise<JWTPayload | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [headerB64, payloadB64, sigB64] = parts;
  const input = `${headerB64}.${payloadB64}`;
  const enc = new TextEncoder();

  try {
    const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
      "verify",
    ]);
    const sigStr = sigB64.replace(/-/g, "+").replace(/_/g, "/");
    const binSig = atob(sigStr);
    const sigBytes = new Uint8Array(binSig.length);
    for (let i = 0; i < binSig.length; i++) sigBytes[i] = binSig.charCodeAt(i);

    const valid = await crypto.subtle.verify("HMAC", key, sigBytes, enc.encode(input));
    if (!valid) return null;

    const payloadStr = atob(payloadB64.replace(/-/g, "+").replace(/_/g, "/"));
    const payload = JSON.parse(payloadStr) as JWTPayload;

    if (payload.exp < Date.now() / 1000) return null;
    return payload;
  } catch {
    return null;
  }
}

// ============================================================================
// TWITCH AUTHENTICATION
// ============================================================================
// Pro unlock is granted on Patreon-sub OR Twitch-sub. The clever bit (per the
// Twitch API's asymmetric scopes): we DON'T ask viewers for
// user:read:subscriptions. Viewers log in with an EMPTY scope (just proves who
// they are); the BROADCASTER's token (wuote, channel:read:subscriptions) then
// answers "is viewer Y subscribed to channel X?" via
//   GET /helix/subscriptions?broadcaster_id=<wuote>&user_id=<viewer>
// So end users grant nothing. Any tier (1000/2000/3000) counts; gifted subs
// count. The broadcaster refresh token is minted once via
// /auth/twitch/broadcaster-setup and stored in the Secrets Store.

const TWITCH_AUTHORIZE_URL = "https://id.twitch.tv/oauth2/authorize";
const TWITCH_TOKEN_URL = "https://id.twitch.tv/oauth2/token";
const TWITCH_USERS_URL = "https://api.twitch.tv/helix/users";
const TWITCH_SUBS_URL = "https://api.twitch.tv/helix/subscriptions";

interface TwitchSecrets {
  clientId: string;
  clientSecret: string;
}

/** Resolve a Secrets Store binding to its string, or null if absent/unreadable. */
async function getSecret(binding?: SecretStoreSecret): Promise<string | null> {
  if (!binding || typeof binding.get !== "function") return null;
  try {
    return await binding.get();
  } catch {
    return null;
  }
}

/** Client id + secret, or null if the Twitch app isn't configured yet. */
async function resolveTwitchSecrets(env: Env): Promise<TwitchSecrets | null> {
  const [clientId, clientSecret] = await Promise.all([
    getSecret(env.TWITCH_CLIENT_ID),
    getSecret(env.TWITCH_CLIENT_SECRET),
  ]);
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

async function handleTwitchLogin(request: Request, env: Env, secrets: Secrets): Promise<Response> {
  const twitch = await resolveTwitchSecrets(env);
  if (!twitch) return new Response("Twitch login not configured", { status: 503 });

  const url = new URL(request.url);
  const redirectUrl = url.searchParams.get("redirect") || "";

  const expiresAt = Date.now() + STATE_EXPIRY_MS;
  const state = await signState(`${redirectUrl}|${expiresAt}`, secrets.jwtSecret);

  const authUrl = new URL(TWITCH_AUTHORIZE_URL);
  authUrl.searchParams.set("client_id", twitch.clientId);
  authUrl.searchParams.set("redirect_uri", `${env.WORKER_URL}/auth/twitch/callback`);
  authUrl.searchParams.set("response_type", "code");
  // Empty scope: we only need to identify the viewer via helix/users. The
  // subscription lookup is done with the broadcaster's token, not theirs.
  authUrl.searchParams.set("scope", "");
  authUrl.searchParams.set("state", state);

  return Response.redirect(authUrl.toString(), 302);
}

async function handleTwitchCallback(request: Request, env: Env, secrets: Secrets): Promise<Response> {
  const twitch = await resolveTwitchSecrets(env);
  if (!twitch) return redirectToError(env, "twitch_not_configured");

  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");

  if (!state) return redirectToError(env, "missing_state");
  const statePayload = await verifyState(state, secrets.jwtSecret);
  if (!statePayload) return redirectToError(env, "invalid_state");

  const [redirectUrl, expiresAtStr] = statePayload.split("|");
  const expiresAt = parseInt(expiresAtStr, 10);
  if (isNaN(expiresAt) || Date.now() > expiresAt) return redirectToError(env, "expired_state");

  // Same open-redirect defence as Patreon: the token is appended to this URL,
  // so it MUST point at an allowlisted origin.
  const finalRedirectUrl = allowedRedirect(redirectUrl, env);

  if (error) return Response.redirect(`${finalRedirectUrl}?auth_error=${encodeURIComponent(error)}`, 302);
  if (!code) return Response.redirect(`${finalRedirectUrl}?auth_error=missing_code`, 302);

  try {
    // 1. Exchange code for the viewer's user access token.
    const tokenRes = await fetch(TWITCH_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: twitch.clientId,
        client_secret: twitch.clientSecret,
        code,
        grant_type: "authorization_code",
        redirect_uri: `${env.WORKER_URL}/auth/twitch/callback`,
      }),
    });
    if (!tokenRes.ok) {
      console.error("Twitch token exchange failed:", await tokenRes.text());
      return Response.redirect(`${finalRedirectUrl}?auth_error=token_exchange_failed`, 302);
    }
    const viewerTokens = (await tokenRes.json()) as { access_token: string; refresh_token?: string };

    // 2. Identify the viewer (helix/users returns the token owner).
    const viewer = await fetchTwitchUser(viewerTokens.access_token, twitch.clientId);
    if (!viewer) return Response.redirect(`${finalRedirectUrl}?auth_error=identity_fetch_failed`, 302);

    // 3. Subscription check via the broadcaster token (may be dormant).
    const isSubscriber = await checkTwitchSubscription(env, twitch, viewer.id);

    // 4. Issue the same JWT shape as Patreon; is_subscriber is the unified gate.
    //    Also a refresh JWT (encrypted viewer refresh_token) so the session
    //    renews silently like Patreon's — no 24h re-login.
    const now = Math.floor(Date.now() / 1000);
    const jwt = await signJWT(
      {
        sub: viewer.id,
        username: viewer.display_name || viewer.login || "Twitch user",
        nickname: viewer.display_name || null,
        is_follower: false,
        is_subscriber: isSubscriber,
        provider: "twitch",
        iat: now,
        exp: now + JWT_EXPIRY_SECONDS,
      },
      secrets.jwtSecret,
    );

    const out = new URL(finalRedirectUrl);
    out.searchParams.set("auth", "success");
    out.searchParams.set("token", jwt);
    if (viewerTokens.refresh_token) {
      const refreshJwt = await signRefreshJWT(
        {
          typ: "refresh",
          sub: viewer.id,
          provider: "twitch",
          enc: await encryptSecret(viewerTokens.refresh_token, secrets.jwtSecret),
          iat: now,
          exp: now + REFRESH_JWT_EXPIRY_SECONDS,
        },
        secrets.jwtSecret,
      );
      out.searchParams.set("refresh_token", refreshJwt);
    }
    return new Response(null, { status: 302, headers: { Location: out.toString() } });
  } catch (err) {
    console.error("Twitch callback exception:", err);
    return Response.redirect(`${finalRedirectUrl}?auth_error=server_error`, 302);
  }
}

interface TwitchUser {
  id: string;
  login: string;
  display_name: string;
}

async function fetchTwitchUser(accessToken: string, clientId: string): Promise<TwitchUser | null> {
  const res = await fetch(TWITCH_USERS_URL, {
    headers: { Authorization: `Bearer ${accessToken}`, "Client-Id": clientId },
  });
  if (!res.ok) {
    console.error("Twitch users fetch failed:", await res.text());
    return null;
  }
  const data = (await res.json()) as { data: TwitchUser[] };
  return data.data?.[0] || null;
}

/**
 * Is `viewerId` subscribed to the broadcaster's channel? Uses the broadcaster's
 * channel:read:subscriptions token (refreshed on demand). Returns false — never
 * throws — when the broadcaster creds aren't set up yet, so login still works
 * with the Twitch UI dormant. The creator (broadcaster themself) is auto-Pro.
 */
async function checkTwitchSubscription(env: Env, twitch: TwitchSecrets, viewerId: string): Promise<boolean> {
  const broadcasterId = await getSecret(env.TWITCH_BROADCASTER_ID);
  if (!broadcasterId) return false; // dormant until the broadcaster id is set
  // Creator bypass first: a broadcaster is never "subscribed" to their own
  // channel per Twitch, so grant it explicitly. Needs only the ID — works even
  // before the refresh-token grant is done.
  if (viewerId === broadcasterId) return true;

  const refreshToken = await getSecret(env.TWITCH_BROADCASTER_REFRESH_TOKEN);
  if (!refreshToken) return false; // can't query subs without the broadcaster token

  const broadcasterToken = await refreshBroadcasterToken(twitch, refreshToken);
  if (!broadcasterToken) return false;

  const url = new URL(TWITCH_SUBS_URL);
  url.searchParams.set("broadcaster_id", broadcasterId);
  url.searchParams.set("user_id", viewerId);

  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${broadcasterToken}`, "Client-Id": twitch.clientId },
  });
  // 200 with a non-empty data array => subscribed (any tier). 404 => not
  // subscribed. Anything else => fail closed (treat as not subscribed).
  if (res.status === 404) return false;
  if (!res.ok) {
    console.error("Twitch subscriptions check failed:", res.status, await res.text());
    return false;
  }
  const data = (await res.json()) as { data: unknown[] };
  return Array.isArray(data.data) && data.data.length > 0;
}

/** Mint a fresh broadcaster access token from the stored refresh token. */
async function refreshBroadcasterToken(twitch: TwitchSecrets, refreshToken: string): Promise<string | null> {
  const res = await fetch(TWITCH_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: twitch.clientId,
      client_secret: twitch.clientSecret,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  });
  if (!res.ok) {
    console.error("Twitch broadcaster token refresh failed:", await res.text());
    return null;
  }
  return ((await res.json()) as { access_token: string }).access_token;
}

// -- One-time broadcaster grant --------------------------------------------
// wuote hits /auth/twitch/broadcaster-setup once (optionally ?key=<setup key>),
// authorizes channel:read:subscriptions, and the callback prints the
// broadcaster_id + refresh_token to paste into the Secrets Store as
// NOITAMAP_TWITCH_BROADCASTER_ID / NOITAMAP_TWITCH_BROADCASTER_REFRESH_TOKEN.

async function handleBroadcasterSetup(request: Request, env: Env, secrets: Secrets): Promise<Response> {
  const twitch = await resolveTwitchSecrets(env);
  if (!twitch) return new Response("Twitch not configured", { status: 503 });

  // Optional shared-secret gate (set NOITAMAP_TWITCH_SETUP_KEY to enable).
  const setupKey = await getSecret(env.TWITCH_SETUP_KEY);
  if (setupKey) {
    const provided = new URL(request.url).searchParams.get("key");
    if (provided !== setupKey) return new Response("Forbidden", { status: 403 });
  }

  const expiresAt = Date.now() + STATE_EXPIRY_MS;
  const state = await signState(`setup|${expiresAt}`, secrets.jwtSecret);

  const authUrl = new URL(TWITCH_AUTHORIZE_URL);
  authUrl.searchParams.set("client_id", twitch.clientId);
  authUrl.searchParams.set("redirect_uri", `${env.WORKER_URL}/auth/twitch/broadcaster-callback`);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", "channel:read:subscriptions");
  authUrl.searchParams.set("force_verify", "true");
  authUrl.searchParams.set("state", state);

  return Response.redirect(authUrl.toString(), 302);
}

async function handleBroadcasterCallback(request: Request, env: Env, secrets: Secrets): Promise<Response> {
  const twitch = await resolveTwitchSecrets(env);
  if (!twitch) return new Response("Twitch not configured", { status: 503 });

  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) return new Response("missing code/state", { status: 400 });

  const statePayload = await verifyState(state, secrets.jwtSecret);
  if (!statePayload || !statePayload.startsWith("setup|")) return new Response("invalid state", { status: 400 });
  const expiresAt = parseInt(statePayload.split("|")[1], 10);
  if (isNaN(expiresAt) || Date.now() > expiresAt) return new Response("expired state", { status: 400 });

  const tokenRes = await fetch(TWITCH_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: twitch.clientId,
      client_secret: twitch.clientSecret,
      code,
      grant_type: "authorization_code",
      redirect_uri: `${env.WORKER_URL}/auth/twitch/broadcaster-callback`,
    }),
  });
  if (!tokenRes.ok) return new Response(`token exchange failed: ${await tokenRes.text()}`, { status: 502 });

  const tokenData = (await tokenRes.json()) as { access_token: string; refresh_token: string };
  const broadcaster = await fetchTwitchUser(tokenData.access_token, twitch.clientId);
  if (!broadcaster) return new Response("failed to read broadcaster identity", { status: 502 });

  const body = [
    "Twitch broadcaster grant OK. Store these in the CF Secrets Store, then add",
    "the two bindings to wrangler.jsonc and redeploy:",
    "",
    `  NOITAMAP_TWITCH_BROADCASTER_ID            = ${broadcaster.id}   (${broadcaster.display_name})`,
    `  NOITAMAP_TWITCH_BROADCASTER_REFRESH_TOKEN = ${tokenData.refresh_token}`,
    "",
    "Do not share the refresh token. This page is not cached or indexed.",
  ].join("\n");

  return new Response(body, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Robots-Tag": "noindex, nofollow",
    },
  });
}
