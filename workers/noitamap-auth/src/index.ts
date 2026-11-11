import { authKey, encryptCredential, decryptCredential, secretMatches, SESSION_FORMAT, SESSION_KEY_ID, type CredentialKeys } from './crypto';
import { createLoginSession, readSessionAccount, rotateRefresh, revokeLoginSession, type LoginSession, type SessionClaims, type SessionAccount } from './sessions';
import { signGameTicket } from './game-ticket';
import { readAccount, saveIdentity, unlinkIdentity, createLinkIntent, startLinkIntent, finishLinkOAuth, consumeLinkIntent, reviewLinkIntent,
  type Account, type Identity, type VerifiedIdentity, type Provider } from './accounts';

/**
 * Patreon/Twitch OAuth with durable account links and revocable v2 sessions.
 *
 * Environment Variables:
 * - PATREON_CLIENT_ID: OAuth Client ID
 * - PATREON_CLIENT_SECRET: OAuth Client Secret
 * - PATREON_CAMPAIGN_ID: The Campaign ID to check membership against
 * - WORKER_URL: The public URL of this worker (e.g., https://auth.noitamap.com)
 * - ALLOWED_ORIGINS: Comma-separated list of allowed origins
 * - SESSION_SIGNING_SECRET: Session/state master, separated by HKDF purpose
 * - CREDENTIAL_ENCRYPTION_SECRET: Independent provider-credential encryption key
 */

// Secrets Store bindings return objects with .get(), plain vars are strings
type SecretStoreSecret = string | { get(): Promise<string> };

interface Env extends Partial<Pick<AccountRegistryBindings, 'ACCOUNT_DB'>> {
  // Secrets Store bindings
  PATREON_CLIENT_ID: SecretStoreSecret;
  PATREON_CLIENT_SECRET: SecretStoreSecret;
  PATREON_CAMPAIGN_ID: SecretStoreSecret;
  SESSION_SIGNING_SECRET: SecretStoreSecret;
  CREDENTIAL_ENCRYPTION_SECRET: SecretStoreSecret;
  CREDENTIAL_KEY_ID?: string;
  PREVIOUS_CREDENTIAL_ENCRYPTION_SECRET?: SecretStoreSecret;
  PREVIOUS_CREDENTIAL_KEY_ID?: string;
  LEGACY_CREDENTIAL_SECRET?: SecretStoreSecret;
  CREATOR_USER_ID: SecretStoreSecret;
  // Primary-only signing key. The game Worker has the public verification key.
  GAME_TICKET_PRIVATE_KEY?: SecretStoreSecret;

  // Plain environment variables (from wrangler.jsonc vars)
  AUTH_ENABLED?: string;
  AUTH_RATE_LIMIT?: RateLimit;
  SESSION_RATE_LIMIT?: RateLimit;
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
  TWITCH_PRO_USER_IDS?: string;
  // Writable storage persists Twitch's rotated broadcaster credentials.
  TWITCH_TOKEN_STORE?: KVNamespace;
  // One-time shared-secret gate. Leave unbound after setup is complete.
  TWITCH_SETUP_KEY?: SecretStoreSecret;
}

// Resolved secrets for use throughout request handling
interface SessionSecrets {
  jwtSecret: string;
  credentials: CredentialKeys;
}

interface Secrets extends SessionSecrets {
  patreonClientId: string;
  patreonClientSecret: string;
  patreonCampaignId: string;
  creatorUserId: string;
}

// -- Types --

interface JWTPayload {
  typ: "access";
  v: 2;
  aud: "noitamap-auth";
  sid: string;
  sub: string; // user_id
  username: string;
  nickname: string | null;
  is_follower: boolean;
  is_subscriber: boolean;
  provider: "patreon" | "twitch";
  account_id: string;
  account_version: number;
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
    attributes?: {
      patron_status?: string | null;
      currently_entitled_amount_cents?: number | null;
      campaign_lifetime_support_cents?: number | null;
      is_gifted?: boolean;
      amount_cents?: number;
    };
    relationships?: {
      campaign?: {
        data: { type: "campaign"; id: string };
      };
      currently_entitled_tiers?: {
        data: Array<{ type: "tier"; id: string }>;
      };
    };
  }>;
}

// -- Constants --

// Short-lived access JWT (what auth-service.ts sends on every /auth/check).
const JWT_EXPIRY_SECONDS = 24 * 60 * 60; // 24 hours
// Registered refresh sessions have a fixed 90-day lifetime and rotate on use.
const STATE_EXPIRY_MS = 10 * 60 * 1000; // 10 minutes
const MAX_BEARER_TOKEN_LENGTH = 16 * 1024;
const OAUTH_STATE_COOKIE = "__Host-noitamap_oauth_state";

const encryptSecret = (value: string, secrets: SessionSecrets) => encryptCredential(value, secrets.credentials);
const decryptSecret = (value: string, secrets: SessionSecrets) => decryptCredential(value, secrets.credentials);

interface RefreshPayload extends SessionClaims {
  typ: 'refresh';
  v: 2;
  aud: 'noitamap-auth';
  rotation: number;
  sub: string;
  provider: Provider;
  iat: number;
  exp: number;
}

interface OAuthState {
  kind: "patreon" | "twitch" | "twitch-setup";
  redirectUrl: string;
  nonce: string;
  expiresAt: number;
  linkIntent?: string;
  chat?: boolean;
}

function twitchChatScopes(chat: boolean, announcements = false): string {
  return chat ? 'user:read:chat user:write:chat' + (announcements ? ' moderator:manage:announcements' : '') : '';
}

// -- Main Worker --

async function resolveSessionSecrets(env: Env): Promise<SessionSecrets> {
  const [jwtSecret, key, previousKey, legacyKey] = await Promise.all([
    getSecret(env.SESSION_SIGNING_SECRET), getSecret(env.CREDENTIAL_ENCRYPTION_SECRET),
    getSecret(env.PREVIOUS_CREDENTIAL_ENCRYPTION_SECRET), getSecret(env.LEGACY_CREDENTIAL_SECRET),
  ]);
  const id = env.CREDENTIAL_KEY_ID || '1';
  if (!jwtSecret || jwtSecret.length < 32 || !key || key.length < 32 || !/^[a-zA-Z0-9_-]{1,32}$/.test(id))
    throw Error('Authentication keys are not configured.');
  return { jwtSecret, credentials: { key, id, previousKey: previousKey ?? undefined, previousId: env.PREVIOUS_CREDENTIAL_KEY_ID, legacyKey: legacyKey ?? undefined } };
}
async function resolveSecrets(env: Env, existing?: SessionSecrets): Promise<Secrets> {
  const [patreonClientId, patreonClientSecret, patreonCampaignId, session, creatorUserId] = await Promise.all([
    getSecret(env.PATREON_CLIENT_ID), getSecret(env.PATREON_CLIENT_SECRET), getSecret(env.PATREON_CAMPAIGN_ID),
    existing ?? resolveSessionSecrets(env), getSecret(env.CREATOR_USER_ID),
  ]);
  if (!patreonClientId || !patreonClientSecret || !patreonCampaignId || !creatorUserId) throw Error('Patreon is not configured.');
  return { ...session, patreonClientId, patreonClientSecret, patreonCampaignId, creatorUserId };
}
function securityEvent(event: string, accountId?: string, provider?: string): void {
  console.log(JSON.stringify({ event, ...(accountId ? { accountId } : {}), ...(provider ? { provider } : {}) }));
}

export default {
  async scheduled(_event: ScheduledEvent, env: Env): Promise<void> {
    if (env.AUTH_ENABLED === 'false' || !env.ACCOUNT_DB) return;
    const now = Date.now();
    await env.ACCOUNT_DB.batch([
      env.ACCOUNT_DB.prepare('DELETE FROM auth_sessions WHERE id IN (SELECT id FROM auth_sessions WHERE expires_at<? OR revoked_at<? LIMIT 500)').bind(now, now - 86400000),
      env.ACCOUNT_DB.prepare('DELETE FROM auth_link_intents WHERE expires_at<?').bind(now),
    ]);
    const secrets = await resolveSessionSecrets(env);
    const rows = await env.ACCOUNT_DB.prepare("SELECT provider,provider_user_id,credentials FROM auth_identities WHERE credentials<>'' AND credentials NOT LIKE ? LIMIT 50")
      .bind('c2.' + secrets.credentials.id + '.%').all<Pick<Identity, 'provider' | 'provider_user_id' | 'credentials'>>();
    for (const row of rows.results) {
      const plaintext = await decryptSecret(row.credentials, secrets);
      if (plaintext) await env.ACCOUNT_DB.prepare('UPDATE auth_identities SET credentials=? WHERE provider=? AND provider_user_id=? AND credentials=?')
        .bind(await encryptSecret(plaintext, secrets), row.provider, row.provider_user_id, row.credentials).run();
    }
    if (env.TWITCH_TOKEN_STORE) await readBroadcasterTokenState(env, secrets);
    securityEvent('session_maintenance');
  },
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "";
    const allowedOrigin = getAllowedOrigin(origin, env);

    if (request.method === "OPTIONS") return handleCORS(allowedOrigin);
    if (env.AUTH_ENABLED === 'false') return textResponse("Authentication is not configured for this environment.", 503, allowedOrigin);
    if (origin && !allowedOrigin) return textResponse("Forbidden", 403);

    try {
      if (env.AUTH_RATE_LIMIT && !(await env.AUTH_RATE_LIMIT.limit({ key: url.pathname + ':' + (request.headers.get('CF-Connecting-IP') || 'unknown') })).success)
        return rateLimited(allowedOrigin);
      switch (url.pathname) {
        case "/auth/login":
          if (request.method !== "GET") return methodNotAllowed("GET");
          return await handlePatreonLogin(request, env, await resolveSecrets(env));
        case "/auth/callback":
          if (request.method !== "GET") return methodNotAllowed("GET");
          return await handlePatreonCallback(request, env, await resolveSecrets(env));
        case "/auth/check":
          if (request.method !== "GET") return methodNotAllowed("GET", allowedOrigin);
          return await handleAuthCheck(request, await resolveSessionSecrets(env), allowedOrigin, env);
        case "/auth/link/start":
        case "/auth/link/review":
        case "/auth/link/complete":
        case "/auth/unlink":
          if (request.method !== "POST") return methodNotAllowed("POST", allowedOrigin);
          return await handleAccountAction(request, env, await resolveSessionSecrets(env), allowedOrigin);
        case "/auth/link/continue":
          if (request.method !== "GET") return methodNotAllowed("GET");
          return await handleLinkContinue(request, env, await resolveSessionSecrets(env));
        case "/auth/twitch/chat-session":
          if (request.method !== "GET") return methodNotAllowed("GET", allowedOrigin);
          return await handleTwitchChatSession(request, env, await resolveSessionSecrets(env), allowedOrigin);
        case "/auth/result-ticket":
        case "/auth/game-ticket":
          if (request.method !== "POST") return methodNotAllowed("POST", allowedOrigin);
          return await handleGameTicket(request, env, (await resolveSessionSecrets(env)).jwtSecret, allowedOrigin);
        case "/auth/logout":
          if (request.method !== "POST") return methodNotAllowed("POST", allowedOrigin);
          return await handleLogout(request, env, await resolveSessionSecrets(env), allowedOrigin);
        case "/auth/refresh":
          if (request.method !== "POST") return methodNotAllowed("POST", allowedOrigin);
          return await handleRefresh(request, env, await resolveSessionSecrets(env), allowedOrigin);
        case "/auth/twitch/login":
          if (request.method !== "GET") return methodNotAllowed("GET");
          return await handleTwitchLogin(request, env, await resolveSessionSecrets(env));
        case "/auth/twitch/callback":
          if (request.method !== "GET") return methodNotAllowed("GET");
          return await handleTwitchCallback(request, env, await resolveSessionSecrets(env));
        case "/auth/twitch/broadcaster-setup":
          if (request.method !== "POST") return methodNotAllowed("POST");
          return await handleBroadcasterSetup(request, env, await resolveSessionSecrets(env));
        case "/auth/twitch/broadcaster-callback":
          if (request.method !== "GET") return methodNotAllowed("GET");
          return await handleBroadcasterCallback(request, env, await resolveSessionSecrets(env));
        default:
          return textResponse("Not Found", 404);
      }
    } catch (error) {
      securityEvent('request_failed');
      return textResponse("Internal Server Error", 500, allowedOrigin);
    }
  },
};

// -- Handlers --

async function handlePatreonLogin(request: Request, env: Env, secrets: Secrets): Promise<Response> {
  const url = new URL(request.url);
  const redirectUrl = allowedRedirect(url.searchParams.get("redirect") || "", env);
  if (!hasLoginNonce(redirectUrl)) return textResponse('Start sign-in from the map.', 400);
  if (!env.ACCOUNT_DB) return textResponse('Authentication is not configured.', 503);

  const nonce = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const state = await signState(
    JSON.stringify({ kind: "patreon", redirectUrl, nonce, expiresAt: Date.now() + STATE_EXPIRY_MS }),
    secrets.jwtSecret,
  );

  // Construct the callback URL
  const callbackUri = `${env.WORKER_URL}/auth/callback`;

  // Patreon OAuth V2 Authorization URL
  const authUrl = new URL("https://www.patreon.com/oauth2/authorize");
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("client_id", secrets.patreonClientId);
  authUrl.searchParams.set("redirect_uri", callbackUri);
  authUrl.searchParams.set("scope", "identity identity.memberships");
  authUrl.searchParams.set("state", state);

  return redirectResponse(authUrl.toString(), oauthStateCookie(nonce, request));
}

async function handlePatreonCallback(request: Request, env: Env, secrets: Secrets): Promise<Response> {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");

  if (!state) return redirectToError(env, "missing_state", request);

  const oauthState = await verifyOAuthState(state, request, "patreon", secrets.jwtSecret);
  if (!oauthState) return redirectToError(env, "invalid_state", request);
  const finalRedirectUrl = allowedRedirect(oauthState.redirectUrl, env);

  if (error) return redirectWithError(finalRedirectUrl, error, request);
  if (!code) return redirectWithError(finalRedirectUrl, "missing_code", request);

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
      console.error("Patreon token exchange failed:", tokenResponse.status);
      return redirectWithError(finalRedirectUrl, "token_exchange_failed", request);
    }

    const tokenData = (await tokenResponse.json()) as PatreonTokenResponse;

    // 2-3. Identity + membership status via the shared helper (also used by
    //      /auth/refresh so a renewed session re-checks the sub, catching
    //      cancellations without forcing the user to log in again).
    const membership = await fetchPatreonMembership(tokenData.access_token, secrets);
    if (!membership) {
      return redirectWithError(finalRedirectUrl, "identity_fetch_failed", request);
    }

    if (!env.ACCOUNT_DB) return textResponse('Account storage is not configured.', 503);
    {
      return completeProviderOAuth(request, env, secrets, oauthState, {
        provider: 'patreon', provider_user_id: membership.userId,
        username: membership.username, nickname: membership.nickname, login: null,
        is_follower: Number(membership.isFollower), is_subscriber: Number(membership.isSubscriber),
        checked_at: Date.now(), status: 'active', credentials: await encryptSecret(JSON.stringify({
          accessToken: tokenData.access_token, refreshToken: tokenData.refresh_token,
          expiresAt: Date.now() + tokenData.expires_in * 1000, scopes: tokenData.scope?.split(' ') || [],
        }), secrets),
      });
    }

  } catch (err) {
    securityEvent('oauth_callback_failed', undefined, 'patreon');
    return redirectWithError(finalRedirectUrl, "server_error", request);
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
  identityUrl.searchParams.set("include", "memberships,memberships.campaign,memberships.currently_entitled_tiers");
  identityUrl.searchParams.set("fields[user]", "vanity,image_url");
  identityUrl.searchParams.set(
    "fields[member]",
    "patron_status,currently_entitled_amount_cents,is_gifted",
  );
  identityUrl.searchParams.set("fields[tier]", "amount_cents");

  const identityResponse = await fetch(identityUrl.toString(), {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!identityResponse.ok) {
    console.error("Patreon identity fetch failed:", identityResponse.status);
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
    const paidTierIds = new Set(identityData.included
      .filter(item => item.type === "tier" && typeof item.attributes?.amount_cents === "number"
        && Number.isFinite(item.attributes.amount_cents) && item.attributes.amount_cents > 0)
      .map(item => item.id));
    for (const item of identityData.included) {
      if (item.type !== "member") continue;
      const campaignId = item.relationships?.campaign?.data?.id;
      if (!secrets.patreonCampaignId || campaignId !== secrets.patreonCampaignId) continue;
      isFollower = true;
      const attributes = item.attributes;
      const hasPaidMembership = attributes?.patron_status === "active_patron"
        && typeof attributes.currently_entitled_amount_cents === "number"
        && Number.isFinite(attributes.currently_entitled_amount_cents)
        && attributes.currently_entitled_amount_cents > 0;
      // A claimed gift may have no payment amount/history for its recipient.
      // Require a current paid-tier entitlement: a historical gift flag, an
      // unrelated included tier, or a free tier cannot unlock Pro. Patreon
      // permits a null patron_status; explicit former/declined states fail closed.
      // Verify this contract with a real claimed-gift payload before production rollout.
      const hasCurrentGift = attributes?.is_gifted === true
        && (attributes.patron_status === "active_patron" || attributes.patron_status === null)
        && item.relationships?.currently_entitled_tiers?.data?.some(tier => tier.type === "tier" && paidTierIds.has(tier.id));
      if (hasPaidMembership || hasCurrentGift) {
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

function hasLoginNonce(url: string): boolean {
  return /^[a-f0-9]{64}$/.test(new URL(url).searchParams.get('auth_nonce') || '');
}
function rateLimited(origin: string | null): Response {
  const response = jsonResponse({ error: 'Too many requests. Try again shortly.' }, origin, 429);
  response.headers.set('Retry-After', '60'); return response;
}
async function sessionRateAllowed(env: Env, id: string): Promise<boolean> {
  return !env.SESSION_RATE_LIMIT || (await env.SESSION_RATE_LIMIT.limit({ key: id })).success;
}
async function handleAuthCheck(request: Request, secrets: SessionSecrets, origin: string | null, env: Env): Promise<Response> {
  const token = getBearerToken(request), payload = token ? await verifyJWT(token, secrets.jwtSecret) : null;
  const account = payload ? await sessionAccount(env, payload) : null;
  if (!payload || !account) return jsonResponse({ authenticated: false }, origin);
  const data = accountData(account, payload.provider);
  if (data.isSubscriber !== payload.is_subscriber || data.isFollower !== payload.is_follower) {
    const updated = await issueAccessSession(account, secrets, account.session, payload.provider);
    return jsonResponse({ ...data, token: updated.token }, origin);
  }
  return jsonResponse(data, origin);
}

async function handleGameTicket(request: Request, env: Env, jwtSecret: string, allowedOrigin: string | null): Promise<Response> {
  const token = getBearerToken(request);
  const user = token ? await verifyJWT(token, jwtSecret) : null;
  if (!user) return jsonResponse({ error: 'Sign in to continue.' }, allowedOrigin, 401);
  if (!await sessionRateAllowed(env, user.sid)) return rateLimited(allowedOrigin);
  const account = await sessionAccount(env, user);
  if (!account) return jsonResponse({ error: 'Sign in again.' }, allowedOrigin, 401);
  const management = new URL(request.url).pathname === '/auth/result-ticket';
  if (!management && !accountData(account).isSubscriber) return jsonResponse({ error: 'Ranked games require Pro.' }, allowedOrigin, 403);
  const key = await getSecret(env.GAME_TICKET_PRIVATE_KEY);
  if (!key || key.length > 2048) return jsonResponse({ error: 'Ranked games are not available yet.' }, allowedOrigin, 503);
  const twitch = account?.identities.find(row => row.provider === 'twitch' && row.status === 'active');
  // Pro may come from Patreon, but a linked Twitch identity supplies the public
  // game name. These fields are already loaded from the verified provider record.
  const name = twitch?.login ? twitch.nickname || twitch.username || twitch.login : user.nickname || user.username;
  return jsonResponse(await signGameTicket(`account:${account.id}`,
    name, key, twitch?.login ? { twitchUserId: twitch.provider_user_id, twitchLogin: twitch.login } : undefined, Date.now(), management ? 'result-management' : 'game'), allowedOrigin);
}

/** Refresh a registered session exactly once; old stateless tokens never migrate. */
async function handleRefresh(request: Request, env: Env, secrets: SessionSecrets, origin: string | null): Promise<Response> {
  const token = getBearerToken(request);
  const refresh = token ? await verifyRefreshJWT(token, secrets.jwtSecret) : null;
  if (!origin || !refresh || !env.ACCOUNT_DB) return jsonResponse({ authenticated: false }, origin, 401);
  if (!await sessionRateAllowed(env, refresh.sid)) return rateLimited(origin);
  const account = await sessionAccount(env, refresh);
  if (!account) return jsonResponse({ authenticated: false }, origin, 401);
  const rotated = await rotateRefresh(env.ACCOUNT_DB, account.session, refresh.rotation);
  if (rotated !== 'ok') {
    if (rotated === 'revoked') securityEvent('refresh_reuse', account.id);
    return jsonResponse({ authenticated: false }, origin, rotated === 'retry' ? 409 : 401);
  }
  await refreshAccountMemberships(env, account, secrets);
  const current = await sessionAccount(env, refresh);
  if (!current || current.session.refresh_version !== refresh.rotation + 1) return jsonResponse({ authenticated: false }, origin, 401);
  securityEvent('refresh', current.id);
  return jsonResponse(await issueAccountSession(env, current, secrets, refresh.provider, current.session), origin);
}
async function handleLogout(request: Request, env: Env, secrets: SessionSecrets, origin: string | null): Promise<Response> {
  if (!origin) return textResponse('Forbidden', 403);
  const token = getBearerToken(request);
  const session = token ? await verifyJWT(token, secrets.jwtSecret) ?? await verifyRefreshJWT(token, secrets.jwtSecret) : null;
  if (session && env.ACCOUNT_DB) { await revokeLoginSession(env.ACCOUNT_DB, session.sid, session.account_id); securityEvent('logout', session.account_id); }
  return new Response(null, { status: 204, headers: responseHeaders(origin) });
}

// -- Helpers --

// Linked accounts keep refresh credentials server-side. Access JWTs retain
// is_subscriber for the versioned Pro asset contract.
const MEMBERSHIP_MAX_AGE = 24 * 60 * 60 * 1000;
const MEMBERSHIP_REFRESH_AFTER = 60 * 60 * 1000;
interface ProviderTokens { access_token: string; refresh_token?: string; expires_in?: number; scope?: string[] }
interface ProviderCredentials { accessToken: string; refreshToken: string; expiresAt: number; scopes: string[] }

async function twitchIdentity(viewer: TwitchUser, tokens: ProviderTokens, pro: boolean, secrets: SessionSecrets, oldRefresh = ''): Promise<VerifiedIdentity> {
  return {
    provider: 'twitch', provider_user_id: viewer.id, username: viewer.display_name || viewer.login,
    nickname: viewer.display_name || null, login: viewer.login,
    is_follower: 0, is_subscriber: Number(pro), checked_at: Date.now(), status: 'active',
    credentials: await encryptSecret(JSON.stringify({ accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token || oldRefresh, expiresAt: Date.now() + (tokens.expires_in || 3600) * 1000,
      scopes: tokens.scope || [] }), secrets),
  };
}

async function sessionAccount(env: Env, session: SessionClaims): Promise<SessionAccount | null> {
  return env.ACCOUNT_DB ? readSessionAccount(env.ACCOUNT_DB, session) : null;
}

function accountData(account: Account, preferred?: Provider) {
  const primary = account.identities.find(row => row.provider === preferred) || account.identities[0];
  const linkedAccounts = account.identities.map(row => ({
    provider: row.provider, userId: row.provider_user_id, username: row.username, login: row.login,
    isFollower: row.is_follower === 1,
    isSubscriber: row.status === 'active' && Date.now() - row.checked_at < MEMBERSHIP_MAX_AGE && row.is_subscriber === 1,
    membershipStatus: row.status === 'reconnect' ? 'reconnect'
      : Date.now() - row.checked_at >= MEMBERSHIP_MAX_AGE ? 'stale' : row.is_subscriber ? 'active' : 'inactive',
    checkedAt: row.checked_at,
  }));
  return { authenticated: true, accountId: account.id, linkingAvailable: true, username: primary.username,
    nickname: primary.nickname, provider: primary.provider, linkedAccounts,
    isSubscriber: linkedAccounts.some(row => row.isSubscriber), isFollower: linkedAccounts.some(row => row.isFollower) };
}

async function issueAccessSession(account: Account, secrets: SessionSecrets, session: LoginSession, preferred?: Provider) {
  const data = accountData(account, preferred);
  const primary = account.identities.find(row => row.provider === data.provider)!;
  const now = Math.floor(Date.now() / 1000);
  const newestGrant = Math.max(...account.identities.filter(row => row.status === 'active' && row.is_subscriber).map(row => row.checked_at));
  const expires = Math.min(now + JWT_EXPIRY_SECONDS, Math.floor(session.expires_at / 1000),
    data.isSubscriber ? Math.floor((newestGrant + MEMBERSHIP_MAX_AGE) / 1000) : Infinity);
  const claims = { v: SESSION_FORMAT, aud: 'noitamap-auth' as const, sid: session.id,
    sub: primary.provider_user_id, provider: primary.provider, account_id: account.id, account_version: account.version, iat: now } as const;
  const token = await signJWT({ ...claims, typ: 'access', exp: expires, username: data.username,
    nickname: data.nickname, is_follower: data.isFollower, is_subscriber: data.isSubscriber }, secrets.jwtSecret);
  return { data, claims, token };
}
async function issueAccountSession(env: Env, account: Account, secrets: SessionSecrets, preferred?: Provider, existing?: LoginSession) {
  const session = existing ?? await createLoginSession(env.ACCOUNT_DB!, account);
  const { data, claims, token } = await issueAccessSession(account, secrets, session, preferred);
  const refresh_token = await signRefreshJWT({ ...claims, typ: 'refresh', rotation: session.refresh_version,
    exp: Math.floor(session.expires_at / 1000) }, secrets.jwtSecret);
  if (!existing) securityEvent('login', account.id, data.provider);
  return { ...data, token, refresh_token };
}

async function completeProviderOAuth(request: Request, env: Env, secrets: SessionSecrets, state: OAuthState, identity: VerifiedIdentity): Promise<Response> {
  const target = new URL(allowedRedirect(state.redirectUrl, env));
  if (identity.provider === 'twitch' && !state.chat) {
    const previous = await env.ACCOUNT_DB!.prepare("SELECT * FROM auth_identities WHERE provider = 'twitch' AND provider_user_id = ?")
      .bind(identity.provider_user_id).first<Identity>();
    if (previous?.status === 'active' && (await readCredentials(previous, secrets))?.scopes.includes('user:read:chat')) {
      // A later ordinary sign-in must not discard earlier explicit chat
      // consent. The endpoint still validates/refreshes this token before use.
      identity.credentials = previous.credentials;
    }
  }
  if (state.linkIntent) {
    const completion = base64url(crypto.getRandomValues(new Uint8Array(32)));
    const saved = await finishLinkOAuth(env.ACCOUNT_DB!, state.linkIntent,
      await encryptSecret(JSON.stringify(identity), secrets), completion);
    if (!saved) return redirectWithError(target.href, 'invalid_link', request);
    // Do not attach or issue a session yet. Completion requires the ORIGINAL
    // browser's bearer session, defeating attacker-supplied OAuth link URLs.
    target.hash = new URLSearchParams({ auth: 'linked', link_token: completion }).toString();
  } else {
    const account = await saveIdentity(env.ACCOUNT_DB!, identity);
    await refreshAccountMemberships(env, account, secrets);
    const current = (await readAccount(env.ACCOUNT_DB!, account.id))!;
    const session = await issueAccountSession(env, current, secrets, identity.provider);
    target.hash = new URLSearchParams({ auth: 'success', token: session.token, refresh_token: session.refresh_token }).toString();
  }
  return redirectResponse(target.href, clearOAuthStateCookie(request));
}

async function readAccountBody(request: Request): Promise<Record<string, unknown> | null> {
  if (!request.headers.get('Content-Type')?.startsWith('application/json')) return null;
  // These endpoint bodies contain only a provider/redirect or a short nonce.
  const reader = request.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 8192) { await reader.cancel(); return null; }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  try { const value = JSON.parse(new TextDecoder().decode(bytes)); return value && typeof value === 'object' ? value : null; }
  catch { return null; }
}

async function handleAccountAction(request: Request, env: Env, secrets: SessionSecrets, origin: string | null): Promise<Response> {
  if (!origin) return jsonResponse({ error: 'A trusted site origin is required.' }, origin, 403);
  if (!env.ACCOUNT_DB) return jsonResponse({ error: 'Account connections are not configured yet.' }, origin, 503);
  const token = getBearerToken(request);
  const session = token ? await verifyJWT(token, secrets.jwtSecret) : null;
  if (session && !await sessionRateAllowed(env, session.sid)) return rateLimited(origin);
  const account = session ? await sessionAccount(env, session) : null;
  if (!session || !account) return jsonResponse({ error: 'Refresh your session before connecting accounts.' }, origin, 401);
  const body = await readAccountBody(request);
  if (!body) return jsonResponse({ error: 'Invalid request.' }, origin, 400);
  const path = new URL(request.url).pathname;
  if (path === '/auth/link/complete' || path === '/auth/link/review') {
    if (typeof body.linkToken !== 'string') return jsonResponse({ error: 'Invalid connection.' }, origin, 400);
    const reviewing = path.endsWith('/review');
    if (!reviewing && body.confirmed !== true) return jsonResponse({ error: 'Confirm the account connection first.' }, origin, 400);
    const intent = await (reviewing ? reviewLinkIntent : consumeLinkIntent)(env.ACCOUNT_DB, body.linkToken, account);
    const candidate = intent?.candidate ? await decryptSecret(intent.candidate, secrets) : null;
    if (!candidate) return jsonResponse({ error: 'This connection expired or belongs to a different session.' }, origin, 409);
    try {
      const identity = JSON.parse(candidate) as VerifiedIdentity;
      if (identity.provider !== intent!.provider) throw new Error('invalid_provider');
      if (reviewing) return jsonResponse({
        current: account.identities.map(row => ({ provider: row.provider, userId: row.provider_user_id, name: row.nickname || row.username })),
        target: { provider: identity.provider, userId: identity.provider_user_id, name: identity.nickname || identity.username },
      }, origin);
      const linked = await saveIdentity(env.ACCOUNT_DB, identity, { id: account.id, version: account.version });
      securityEvent('link', account.id, identity.provider);
      return jsonResponse(await issueAccountSession(env, linked, secrets, session.provider), origin);
    } catch {
      return jsonResponse({ error: 'That account already has a different connection. Unlink it there before connecting here.' }, origin, 409);
    }
  }
  const provider = body.provider;
  if (provider !== 'patreon' && provider !== 'twitch') return jsonResponse({ error: 'Invalid provider.' }, origin, 400);
  if (path === '/auth/unlink') {
    const remaining = await unlinkIdentity(env.ACCOUNT_DB, account, provider);
    if (!remaining) return jsonResponse({ error: 'Keep at least one connected sign-in method.' }, origin, 409);
    securityEvent('unlink', remaining.id, provider);
    return jsonResponse({ authenticated: false }, origin);
  }
  const redirect = typeof body.redirect === 'string' ? allowedRedirect(body.redirect, env) : origin;
  if (!hasLoginNonce(redirect)) return jsonResponse({ error: 'Start this connection from the map.' }, origin, 400);
  if (new URL(redirect).origin !== origin) return jsonResponse({ error: 'Return to the site that started this connection.' }, origin, 400);
  const id = base64url(crypto.getRandomValues(new Uint8Array(32)));
  await createLinkIntent(env.ACCOUNT_DB, { id, account_id: account.id, account_version: account.version,
    provider, chat: provider === 'twitch' && body.chat === true ? (body.announcements === true ? 2 : 1) : 0,
    redirect_url: redirect, expires_at: Date.now() + STATE_EXPIRY_MS });
  return jsonResponse({ url: `${env.WORKER_URL}/auth/link/continue?id=${encodeURIComponent(id)}` }, origin);
}

async function handleLinkContinue(request: Request, env: Env, secrets: SessionSecrets): Promise<Response> {
  if (!env.ACCOUNT_DB) return textResponse('Account connections are not configured', 503);
  const id = new URL(request.url).searchParams.get('id') || '';
  const intent = id.length <= 128 ? await startLinkIntent(env.ACCOUNT_DB, id) : null;
  if (!intent) return redirectToError(env, 'invalid_link', request);
  const account = await readAccount(env.ACCOUNT_DB, intent.account_id);
  if (!account || account.version !== intent.account_version) return redirectWithError(intent.redirect_url, 'link_session_changed', request);
  const nonce = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const state = await signState(JSON.stringify({ kind: intent.provider, redirectUrl: intent.redirect_url,
    nonce, expiresAt: intent.expires_at, linkIntent: intent.id, chat: intent.chat > 0 }), secrets.jwtSecret);
  const twitch = intent.provider === 'twitch' ? await resolveTwitchSecrets(env) : null;
  const clientId = intent.provider === 'twitch' ? twitch?.clientId : (await resolveSecrets(env, secrets)).patreonClientId;
  if (!clientId) return redirectWithError(intent.redirect_url, 'provider_not_configured', request);
  const authorize = new URL(intent.provider === 'twitch' ? TWITCH_AUTHORIZE_URL : 'https://www.patreon.com/oauth2/authorize');
  authorize.search = new URLSearchParams({ client_id: clientId, response_type: 'code', state,
    redirect_uri: env.WORKER_URL + (intent.provider === 'twitch' ? '/auth/twitch/callback' : '/auth/callback'),
    scope: intent.provider === 'patreon' ? 'identity identity.memberships' : twitchChatScopes(intent.chat > 0, intent.chat === 2),
  }).toString();
  if (intent.provider === 'twitch') authorize.searchParams.set('force_verify', 'true');
  return redirectResponse(authorize.href, oauthStateCookie(nonce, request));
}

async function readCredentials(identity: Identity, secrets: SessionSecrets): Promise<ProviderCredentials | null> {
  const value = await decryptSecret(identity.credentials, secrets);
  if (!value) return null;
  try { return JSON.parse(value) as ProviderCredentials; } catch { return null; }
}

async function refreshLinkedIdentity(env: Env, identity: Identity, secrets: SessionSecrets, forceToken = false): Promise<void> {
  if (identity.status !== 'active' || !env.ACCOUNT_DB) return;
  const lease = crypto.randomUUID();
  const acquired = await env.ACCOUNT_DB.prepare(`UPDATE auth_identities SET refresh_lock = ?, refresh_lock_until = ?
    WHERE account_id = ? AND provider = ? AND refresh_lock_until < ? RETURNING *`)
    .bind(lease, Date.now() + 30000, identity.account_id, identity.provider, Date.now()).first<Identity>();
  if (!acquired) return; // Another request is rotating this provider's token.
  identity = acquired; // The previous lock holder may have rotated credentials.
  const update = async (sql: string, values: (string | number | null)[]) => {
    await env.ACCOUNT_DB!.prepare(sql + ' WHERE account_id = ? AND provider = ? AND refresh_lock = ?')
      .bind(...values, identity.account_id, identity.provider, lease).run();
  };
  try {
    let credentials = await readCredentials(identity, secrets);
    if (!credentials) return;
    const twitch = identity.provider === 'twitch' ? await resolveTwitchSecrets(env) : null;
    const patreon = identity.provider === 'patreon' ? await resolveSecrets(env, secrets) : null;
    if (!twitch && !patreon) return;
    if (credentials.expiresAt <= Date.now() + 60000 || forceToken) {
      if (!credentials.refreshToken) return;
      const tokenRes = await fetch(twitch ? TWITCH_TOKEN_URL : 'https://www.patreon.com/api/oauth2/token', {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: credentials.refreshToken,
          client_id: twitch?.clientId || patreon!.patreonClientId, client_secret: twitch?.clientSecret || patreon!.patreonClientSecret }),
      });
      if (!tokenRes.ok) {
        if (tokenRes.status === 400 || tokenRes.status === 401) await update("UPDATE auth_identities SET status = 'reconnect', is_subscriber = 0, credentials = ''", []);
        return;
      }
      const tokens = await tokenRes.json() as { access_token: string; refresh_token?: string; expires_in?: number; scope?: string | string[] };
      credentials = { accessToken: tokens.access_token, refreshToken: tokens.refresh_token || credentials.refreshToken,
        expiresAt: Date.now() + (tokens.expires_in || 3600) * 1000,
        scopes: Array.isArray(tokens.scope) ? tokens.scope : tokens.scope?.split(' ') || credentials.scopes };
      // Persist rotation BEFORE identity/membership I/O, so a temporary outage
      // cannot strand a single-use Patreon refresh credential.
      await update('UPDATE auth_identities SET credentials = ?', [await encryptSecret(JSON.stringify(credentials), secrets)]);
    }
    const viewer = twitch ? await fetchTwitchUser(credentials.accessToken, twitch.clientId) : null;
    const patron = patreon ? await fetchPatreonMembership(credentials.accessToken, patreon) : null;
    const userId = viewer?.id || patron?.userId;
    if (!userId) return; // Keep cached entitlement only up to its original TTL.
    if (userId !== identity.provider_user_id) {
      await update("UPDATE auth_identities SET status = 'reconnect', is_subscriber = 0, credentials = ''", []);
      return;
    }
    const pro = viewer ? await checkTwitchProAccess(env, twitch!, viewer, secrets) : patron!.isSubscriber;
    await update(`UPDATE auth_identities SET username = ?, nickname = ?, login = ?, is_follower = ?, is_subscriber = ?, checked_at = ?`,
      [viewer?.display_name || viewer?.login || patron!.username, viewer?.display_name || patron?.nickname || null,
        viewer?.login || null, Number(patron?.isFollower || false), Number(pro), Date.now()]);
  } catch {
    console.error('Linked provider refresh unavailable', identity.provider);
  } finally {
    await update('UPDATE auth_identities SET refresh_lock = NULL, refresh_lock_until = 0', []);
  }
}

async function refreshAccountMemberships(env: Env, account: Account, secrets: SessionSecrets): Promise<void> {
  for (const identity of account.identities) {
    if (Date.now() - identity.checked_at >= MEMBERSHIP_REFRESH_AFTER) await refreshLinkedIdentity(env, identity, secrets);
  }
}

async function handleTwitchChatSession(request: Request, env: Env, secrets: SessionSecrets, origin: string | null): Promise<Response> {
  const token = getBearerToken(request);
  const session = token ? await verifyJWT(token, secrets.jwtSecret) : null;
  const account = session ? await sessionAccount(env, session) : null;
  if (!account) return jsonResponse({ error: 'Connect Twitch to this account first.' }, origin, 401);
  let identity = account.identities.find(row => row.provider === 'twitch' && row.status === 'active');
  if (!identity) return jsonResponse({ error: 'Connect Twitch to read your chat.' }, origin, 409);
  let credentials = await readCredentials(identity, secrets);
  if (!credentials?.scopes.includes('user:read:chat')) return jsonResponse({ error: 'Authorize Twitch chat access.' }, origin, 409);
  if (credentials.expiresAt <= Date.now() + 60000) {
    await refreshLinkedIdentity(env, identity, secrets, true);
    identity = (await sessionAccount(env, session!))?.identities.find(row => row.provider === 'twitch' && row.status === 'active');
    credentials = identity ? await readCredentials(identity, secrets) : null;
  }
  const twitch = await resolveTwitchSecrets(env);
  if (!identity || !credentials || !twitch) return jsonResponse({ error: 'Reconnect Twitch chat.' }, origin, 409);
  // Validate at connection time; long-running chat clients repeat this at
  // least hourly per Twitch's token validation requirement. Never send a
  // refresh token or a token carrying unrelated privileges to the browser.
  const validation = await fetch('https://id.twitch.tv/oauth2/validate', { headers: { Authorization: `OAuth ${credentials.accessToken}` } });
  if (!validation.ok) return jsonResponse({ error: 'Reconnect Twitch chat.' }, origin, 409);
  const verified = await validation.json() as { client_id: string; user_id: string; login: string; scopes: string[]; expires_in: number };
  if (verified.client_id !== twitch.clientId || verified.user_id !== identity.provider_user_id
    || !Array.isArray(verified.scopes) || !verified.scopes.includes('user:read:chat')
    || verified.scopes.some(scope => !['user:read:chat', 'user:write:chat', 'moderator:manage:announcements'].includes(scope))
    || !verified.login || !Number.isFinite(verified.expires_in) || verified.expires_in <= 60) {
    return jsonResponse({ error: 'Reconnect Twitch with chat read permission.' }, origin, 409);
  }
  return jsonResponse({ accessToken: credentials.accessToken, clientId: twitch.clientId,
    userId: verified.user_id, login: verified.login, scopes: verified.scopes, expiresAt: Date.now() + verified.expires_in * 1000 }, origin);
}

function allowedOrigins(env: Env): string[] {
  return env.ALLOWED_ORIGINS.split(",").map((origin) => origin.trim()).filter(Boolean);
}

function getAllowedOrigin(origin: string, env: Env): string | null {
  return origin && allowedOrigins(env).includes(origin) ? origin : null;
}

/**
 * Resolve the post-login redirect to a trusted absolute URL. The token is
 * appended to this URL, so it MUST point at an allowed origin — otherwise the
 * flow is an open redirect that leaks the JWT. Returns the original URL when
 * its origin is allowlisted, else the first allowed origin as a safe fallback.
 */
function allowedRedirect(redirectUrl: string, env: Env): string {
  const allowed = allowedOrigins(env);
  const fallback = allowed[0] || "https://noitamap.com";
  if (!redirectUrl) return fallback;
  try {
    const u = new URL(redirectUrl);
    if (!allowed.includes(u.origin) || u.username || u.password) return fallback;
    const page = u.pathname === '/' || u.pathname === '/index.html' || u.pathname === '/guess/' || u.pathname === '/guess/index.html'
      || /^\/guess\/[a-z0-9_]{1,25}\/?$/i.test(u.pathname)
      || /^\/guess\/[a-z0-9_]{1,25}\/[0-9abcdefghjkmnpqrstvwxyz]{26}\/?$/i.test(u.pathname)
      || /^\/guess\/stream\/[a-z0-9_]{1,25}\/?$/i.test(u.pathname)
      || /^\/guess\/results\/[a-f0-9-]{36}\/?$/i.test(u.pathname);
    if (!page) return fallback;
    // A link return must never import an attacker-supplied legacy session from
    // its query string before completing the authenticated connection.
    for (const name of ['auth', 'token', 'refresh_token', 'link_token', 'auth_error']) u.searchParams.delete(name);
    return u.href;
  } catch {
    return fallback;
  }
}

function responseHeaders(allowedOrigin: string | null = null): Headers {
  const headers = new Headers({
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
  });
  if (allowedOrigin) {
    headers.set("Access-Control-Allow-Origin", allowedOrigin);
    headers.set("Vary", "Origin");
  }
  return headers;
}

function handleCORS(allowedOrigin: string | null): Response {
  if (!allowedOrigin) return textResponse("Forbidden", 403);
  const headers = responseHeaders(allowedOrigin);
  headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  headers.set("Access-Control-Allow-Headers", "Authorization, Content-Type, X-Noitamap-Setup-Key");
  headers.set("Access-Control-Max-Age", "86400");
  return new Response(null, { status: 204, headers });
}

function jsonResponse(data: unknown, allowedOrigin: string | null, status = 200): Response {
  const headers = responseHeaders(allowedOrigin);
  headers.set("Content-Type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(data), { status, headers });
}

function textResponse(body: string, status: number, allowedOrigin: string | null = null): Response {
  const headers = responseHeaders(allowedOrigin);
  headers.set("Content-Type", "text/plain; charset=utf-8");
  return new Response(body, { status, headers });
}

function methodNotAllowed(allowedMethod: string, allowedOrigin: string | null = null): Response {
  const response = textResponse("Method Not Allowed", 405, allowedOrigin);
  response.headers.set("Allow", allowedMethod);
  return response;
}

function getBearerToken(request: Request): string | null {
  const match = request.headers.get("Authorization")?.match(/^Bearer\s+(\S+)$/i);
  const token = match?.[1] || "";
  return token && token.length <= MAX_BEARER_TOKEN_LENGTH ? token : null;
}

function oauthStateCookie(nonce: string, request: Request, maxAge = Math.ceil(STATE_EXPIRY_MS / 1000)): string {
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return `${secure ? OAUTH_STATE_COOKIE : "noitamap_oauth_state_local"}=${nonce}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

function clearOAuthStateCookie(request: Request): string {
  return oauthStateCookie("", request, 0);
}

function requestCookie(request: Request, name: string): string | null {
  for (const part of (request.headers.get("Cookie") || "").split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() === name) return part.slice(separator + 1).trim();
  }
  return null;
}

async function verifyOAuthState(
  state: string,
  request: Request,
  kind: OAuthState["kind"],
  secret: string,
): Promise<OAuthState | null> {
  if (state.length > MAX_BEARER_TOKEN_LENGTH) return null;
  const payload = await verifyState(state, secret);
  if (!payload) return null;
  try {
    const parsed = JSON.parse(payload) as OAuthState;
    const cookieNonce = requestCookie(request, new URL(request.url).protocol === "https:" ? OAUTH_STATE_COOKIE : "noitamap_oauth_state_local");
    const now = Date.now();
    if (
      parsed.kind !== kind ||
      typeof parsed.redirectUrl !== "string" ||
      typeof parsed.nonce !== "string" ||
      parsed.nonce.length < 32 ||
      !Number.isFinite(parsed.expiresAt) ||
      parsed.expiresAt < now ||
      parsed.expiresAt > now + STATE_EXPIRY_MS ||
      !cookieNonce ||
      cookieNonce !== parsed.nonce
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function redirectResponse(location: string, stateCookie?: string): Response {
  const headers = responseHeaders();
  headers.set("Location", location);
  if (stateCookie) headers.set("Set-Cookie", stateCookie);
  return new Response(null, { status: 302, headers });
}

function redirectWithError(redirectUrl: string, error: string, request: Request): Response {
  const target = new URL(redirectUrl);
  target.searchParams.set("auth_error", error);
  return redirectResponse(target.toString(), clearOAuthStateCookie(request));
}

function redirectToError(env: Env, error: string, request?: Request): Response {
  const fallback = allowedOrigins(env)[0] || "https://noitamap.com";
  if (request) return redirectWithError(fallback, error, request);
  const target = new URL(fallback);
  target.searchParams.set("auth_error", error);
  return redirectResponse(target.toString());
}

// -- HMAC State Utils --

async function signState(payload: string, secret: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await authKey(secret, "oauth-state");
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
    const key = await authKey(secret, "oauth-state");
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
  if (!/^[A-Za-z0-9_-]*$/.test(b64url) || b64url.length % 4 === 1) throw new Error("Invalid base64url");
  const unpadded = b64url.replace(/-/g, "+").replace(/_/g, "/");
  const b64 = unpadded.padEnd(unpadded.length + ((4 - (unpadded.length % 4)) % 4), "=");
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
  const headerB64 = base64url(enc.encode(JSON.stringify({ alg: "HS256", typ: "JWT", kid: SESSION_KEY_ID })));
  const payloadB64 = base64url(enc.encode(JSON.stringify(payload)));
  const input = `${headerB64}.${payloadB64}`;
  const key = await authKey(secret, "refresh");
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(input));
  return `${input}.${base64url(sig)}`;
}

function validSessionClaims(payload: JWTPayload | RefreshPayload): boolean {
  return payload.v === SESSION_FORMAT && payload.aud === 'noitamap-auth'
    && typeof payload.sid === 'string' && /^[a-f0-9-]{36}$/.test(payload.sid)
    && typeof payload.account_id === 'string' && /^[a-f0-9-]{36}$/.test(payload.account_id)
    && Number.isInteger(payload.account_version) && payload.account_version > 0;
}

async function verifyRefreshJWT(token: string, secret: string): Promise<RefreshPayload | null> {
  if (token.length > MAX_BEARER_TOKEN_LENGTH) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [headerB64, payloadB64, sigB64] = parts;
  const enc = new TextEncoder();
  try {
    if (!validJwtHeader(headerB64)) return null;
    const key = await authKey(secret, "refresh");
    const valid = await crypto.subtle.verify("HMAC", key, base64urlToBytes(sigB64), enc.encode(`${headerB64}.${payloadB64}`));
    if (!valid) return null;
    const payload = JSON.parse(new TextDecoder().decode(base64urlToBytes(payloadB64))) as RefreshPayload;
    const now = Date.now() / 1000;
    if (
      payload.typ !== "refresh" ||
      typeof payload.sub !== "string" ||
      !payload.sub ||
      (payload.provider !== "patreon" && payload.provider !== "twitch") ||
      !validSessionClaims(payload) || !Number.isInteger(payload.rotation) || payload.rotation < 0 ||
      !Number.isFinite(payload.iat) ||
      !Number.isFinite(payload.exp) ||
      payload.iat > now + 60 ||
      payload.exp <= now
    ) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}

async function signJWT(payload: JWTPayload, secret: string): Promise<string> {
  const enc = new TextEncoder();
  const header = { alg: "HS256", typ: "JWT", kid: SESSION_KEY_ID };
  const headerB64 = base64url(enc.encode(JSON.stringify(header)));
  const payloadB64 = base64url(enc.encode(JSON.stringify(payload)));
  const input = `${headerB64}.${payloadB64}`;

  const key = await authKey(secret, "access");
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(input));
  return `${input}.${base64url(sig)}`;
}

function validJwtHeader(headerB64: string): boolean {
  const header = JSON.parse(new TextDecoder().decode(base64urlToBytes(headerB64))) as Record<string, unknown>;
  return header.alg === "HS256" && header.typ === "JWT" && header.kid === SESSION_KEY_ID;
}

async function verifyJWT(token: string, secret: string): Promise<JWTPayload | null> {
  if (token.length > MAX_BEARER_TOKEN_LENGTH) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [headerB64, payloadB64, sigB64] = parts;
  const input = `${headerB64}.${payloadB64}`;
  const enc = new TextEncoder();

  try {
    if (!validJwtHeader(headerB64)) return null;
    const key = await authKey(secret, "access");
    const valid = await crypto.subtle.verify("HMAC", key, base64urlToBytes(sigB64), enc.encode(input));
    if (!valid) return null;

    const payload = JSON.parse(new TextDecoder().decode(base64urlToBytes(payloadB64))) as JWTPayload;
    const now = Date.now() / 1000;
    if (
      payload.typ !== "access" || !validSessionClaims(payload) ||
      typeof payload.sub !== "string" ||
      !payload.sub ||
      typeof payload.username !== "string" ||
      !(payload.nickname === null || typeof payload.nickname === "string") ||
      typeof payload.is_follower !== "boolean" ||
      typeof payload.is_subscriber !== "boolean" ||
      (payload.provider !== "patreon" && payload.provider !== "twitch") ||
      !Number.isFinite(payload.iat) ||
      !Number.isFinite(payload.exp) ||
      payload.iat > now + 60 ||
      payload.exp <= now
    ) {
      return null;
    }
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
// Owner-approved grants use stable, provider-verified user IDs. Names are presentation only.

interface TwitchSecrets {
  clientId: string;
  clientSecret: string;
}

interface BroadcasterTokenState {
  accessToken: string;
  accessTokenExpiresAt: number;
  refreshToken: string;
}

const TWITCH_BROADCASTER_TOKEN_KEY = "broadcaster-token-v1";
let broadcasterTokenCache: BroadcasterTokenState | null = null;
let broadcasterTokenRefresh: Promise<string | null> | null = null;

/** Resolve a Secrets Store binding to its string, or null if absent/unreadable. */
async function getSecret(binding?: SecretStoreSecret): Promise<string | null> {
  if (typeof binding === "string") return binding || null;
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

async function handleTwitchLogin(request: Request, env: Env, secrets: SessionSecrets): Promise<Response> {
  const twitch = await resolveTwitchSecrets(env);
  if (!twitch) return new Response("Twitch login not configured", { status: 503 });

  const url = new URL(request.url);
  const redirectUrl = allowedRedirect(url.searchParams.get("redirect") || "", env);
  if (!hasLoginNonce(redirectUrl)) return textResponse('Start sign-in from the map.', 400);
  if (!env.ACCOUNT_DB) return textResponse('Authentication is not configured.', 503);
  const chat = url.searchParams.get('chat') === '1';
  if (chat && !env.ACCOUNT_DB) return textResponse('Account connections are not configured', 503);

  const nonce = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const state = await signState(
    JSON.stringify({ kind: "twitch", redirectUrl, nonce, chat, expiresAt: Date.now() + STATE_EXPIRY_MS }),
    secrets.jwtSecret,
  );

  const authUrl = new URL(TWITCH_AUTHORIZE_URL);
  authUrl.searchParams.set("client_id", twitch.clientId);
  authUrl.searchParams.set("redirect_uri", `${env.WORKER_URL}/auth/twitch/callback`);
  authUrl.searchParams.set("response_type", "code");
  // Empty scope: we only need to identify the viewer via helix/users. The
  // subscription lookup is done with the broadcaster's token, not theirs.
  authUrl.searchParams.set("scope", twitchChatScopes(chat, url.searchParams.get('announcements') === '1'));
  if (chat) authUrl.searchParams.set('force_verify', 'true');
  authUrl.searchParams.set("state", state);

  return redirectResponse(authUrl.toString(), oauthStateCookie(nonce, request));
}

async function handleTwitchCallback(request: Request, env: Env, secrets: SessionSecrets): Promise<Response> {
  const twitch = await resolveTwitchSecrets(env);
  if (!twitch) return redirectToError(env, "twitch_not_configured");

  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");

  if (!state) return redirectToError(env, "missing_state", request);
  const oauthState = await verifyOAuthState(state, request, "twitch", secrets.jwtSecret);
  if (!oauthState) return redirectToError(env, "invalid_state", request);
  const finalRedirectUrl = allowedRedirect(oauthState.redirectUrl, env);

  if (error) return redirectWithError(finalRedirectUrl, error, request);
  if (!code) return redirectWithError(finalRedirectUrl, "missing_code", request);

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
      console.error("Twitch token exchange failed:", tokenRes.status);
      return redirectWithError(finalRedirectUrl, "token_exchange_failed", request);
    }
    const viewerTokens = (await tokenRes.json()) as ProviderTokens;

    // 2. Identify the viewer (helix/users returns the token owner).
    const viewer = await fetchTwitchUser(viewerTokens.access_token, twitch.clientId);
    if (!viewer) return redirectWithError(finalRedirectUrl, "identity_fetch_failed", request);

    // 3. Explicit Pro grants, then subscription check via the broadcaster token.
    const isSubscriber = await checkTwitchProAccess(env, twitch, viewer, secrets);

    if (!env.ACCOUNT_DB) return textResponse('Account storage is not configured.', 503);
    {
      if (oauthState.chat && !viewerTokens.scope?.includes('user:read:chat')) return redirectWithError(finalRedirectUrl, 'chat_permission_required', request);
      return completeProviderOAuth(request, env, secrets, oauthState, await twitchIdentity(viewer, viewerTokens, isSubscriber, secrets));
    }

  } catch (err) {
    securityEvent('oauth_callback_failed', undefined, 'twitch');
    return redirectWithError(finalRedirectUrl, "server_error", request);
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
    console.error("Twitch users fetch failed:", res.status);
    return null;
  }
  const data = (await res.json()) as { data: TwitchUser[] };
  return data.data?.[0] || null;
}

/**
 * Pro access for a verified Twitch identity: explicit grants, the creator, or a
 * subscription to the broadcaster's channel. Uses the broadcaster's
 * channel:read:subscriptions token (refreshed on demand). Explicit grants work
 * without broadcaster setup; other viewers need the subscription check or the
 * existing broadcaster-ID grant.
 */
async function checkTwitchProAccess(env: Env, twitch: TwitchSecrets, viewer: TwitchUser, secrets: SessionSecrets): Promise<boolean> {
  if ((env.TWITCH_PRO_USER_IDS ?? '564553302,241636').split(',').some(id => /^\d{1,30}$/.test(id.trim()) && id.trim() === viewer.id)) return true;
  const viewerId = viewer.id;
  const broadcasterId = await getSecret(env.TWITCH_BROADCASTER_ID);
  if (!broadcasterId) return false; // dormant until the broadcaster id is set
  // Creator bypass first: a broadcaster is never "subscribed" to their own
  // channel per Twitch, so grant it explicitly. Needs only the ID — works even
  // before the refresh-token grant is done.
  if (viewerId === broadcasterId) return true;

  const broadcasterToken = await getBroadcasterAccessToken(env, twitch, secrets);
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
    console.error("Twitch subscriptions check failed:", res.status);
    return false;
  }
  const data = (await res.json()) as { data: unknown[] };
  return Array.isArray(data.data) && data.data.length > 0;
}

async function readBroadcasterTokenState(env: Env, secrets: SessionSecrets): Promise<BroadcasterTokenState | null> {
  if (!env.TWITCH_TOKEN_STORE) return null;
  try {
    const raw = await env.TWITCH_TOKEN_STORE.get(TWITCH_BROADCASTER_TOKEN_KEY);
    if (!raw || raw.length > 32768) return null;
    const plaintext = raw.startsWith('{') ? raw : await decryptSecret(raw, secrets);
    if (!plaintext) return null;
    const state = JSON.parse(plaintext) as BroadcasterTokenState;
    if (
      typeof state.accessToken !== "string" ||
      !Number.isFinite(state.accessTokenExpiresAt) ||
      typeof state.refreshToken !== "string" ||
      !state.refreshToken
    ) {
      return null;
    }
    if (!raw.startsWith('c2.' + secrets.credentials.id + '.')) await writeBroadcasterTokenState(env, state, secrets);
    return state;
  } catch (error) {
    securityEvent('broadcaster_store_read_failed');
    return null;
  }
}

async function writeBroadcasterTokenState(env: Env, state: BroadcasterTokenState, secrets: SessionSecrets): Promise<boolean> {
  if (!env.TWITCH_TOKEN_STORE) return false;
  try {
    await env.TWITCH_TOKEN_STORE.put(TWITCH_BROADCASTER_TOKEN_KEY, await encryptSecret(JSON.stringify(state), secrets));
    broadcasterTokenCache = state;
    return true;
  } catch (error) {
    securityEvent('broadcaster_store_write_failed');
    return false;
  }
}

async function getBroadcasterAccessToken(env: Env, twitch: TwitchSecrets, secrets: SessionSecrets): Promise<string | null> {
  const now = Date.now();
  if (broadcasterTokenCache && broadcasterTokenCache.accessTokenExpiresAt > now + 60_000) {
    return broadcasterTokenCache.accessToken;
  }

  const stored = await readBroadcasterTokenState(env, secrets);
  if (stored?.accessToken && stored.accessTokenExpiresAt > now + 60_000) {
    broadcasterTokenCache = stored;
    return stored.accessToken;
  }

  if (broadcasterTokenRefresh) return broadcasterTokenRefresh;
  broadcasterTokenRefresh = (async () => {
    const refreshToken = stored?.refreshToken || (await getSecret(env.TWITCH_BROADCASTER_REFRESH_TOKEN));
    if (!refreshToken) return null;

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
      console.error("Twitch broadcaster token refresh failed:", res.status);
      return null;
    }

    const tokenData = (await res.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in?: number;
    };
    if (!tokenData.access_token) return null;
    const state: BroadcasterTokenState = {
      accessToken: tokenData.access_token,
      accessTokenExpiresAt: Date.now() + Math.max(60, tokenData.expires_in || 3600) * 1000,
      refreshToken: tokenData.refresh_token || refreshToken,
    };
    if (!(await writeBroadcasterTokenState(env, state, secrets))) {
      // A rotated token that cannot be persisted would strand the next refresh.
      if (state.refreshToken !== refreshToken) return null;
      broadcasterTokenCache = state;
    }
    return state.accessToken;
  })();

  try {
    return await broadcasterTokenRefresh;
  } finally {
    broadcasterTokenRefresh = null;
  }
}

// -- One-time broadcaster grant --------------------------------------------
// An explicitly enabled setup POST takes its key only in a header. Follow
// its returned authorization URL in the same browser; the callback persists
// encrypted credentials and never returns the refresh token.

async function handleBroadcasterSetup(request: Request, env: Env, secrets: SessionSecrets): Promise<Response> {
  const twitch = await resolveTwitchSecrets(env);
  if (!twitch) return new Response("Twitch not configured", { status: 503 });

  // Keep this sensitive route disabled unless an explicit one-time key exists.
  const setupKey = await getSecret(env.TWITCH_SETUP_KEY);
  if (!setupKey) return textResponse("Not Found", 404);
  const provided = request.headers.get("X-Noitamap-Setup-Key") || "";
  if (!await secretMatches(setupKey, provided)) return textResponse("Forbidden", 403);

  const nonce = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const state = await signState(
    JSON.stringify({ kind: "twitch-setup", redirectUrl: "", nonce, expiresAt: Date.now() + STATE_EXPIRY_MS }),
    secrets.jwtSecret,
  );

  const authUrl = new URL(TWITCH_AUTHORIZE_URL);
  authUrl.searchParams.set("client_id", twitch.clientId);
  authUrl.searchParams.set("redirect_uri", `${env.WORKER_URL}/auth/twitch/broadcaster-callback`);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", "channel:read:subscriptions");
  authUrl.searchParams.set("force_verify", "true");
  authUrl.searchParams.set("state", state);

  const response = jsonResponse({ url: authUrl.toString() }, getAllowedOrigin(request.headers.get('Origin') || '', env));
  response.headers.set('Set-Cookie', oauthStateCookie(nonce, request));
  return response;
}

async function handleBroadcasterCallback(request: Request, env: Env, secrets: SessionSecrets): Promise<Response> {
  const twitch = await resolveTwitchSecrets(env);
  if (!twitch) return new Response("Twitch not configured", { status: 503 });

  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) return new Response("missing code/state", { status: 400 });

  const oauthState = await verifyOAuthState(state, request, "twitch-setup", secrets.jwtSecret);
  if (!oauthState) return textResponse("invalid state", 400);

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
  if (!tokenRes.ok) {
    console.error("Twitch broadcaster token exchange failed:", tokenRes.status);
    return textResponse("token exchange failed", 502);
  }

  const tokenData = (await tokenRes.json()) as { access_token: string; refresh_token: string; expires_in?: number };
  const broadcaster = await fetchTwitchUser(tokenData.access_token, twitch.clientId);
  if (!broadcaster) return textResponse("failed to read broadcaster identity", 502);
  const expectedBroadcasterId = await getSecret(env.TWITCH_BROADCASTER_ID);
  if (expectedBroadcasterId && broadcaster.id !== expectedBroadcasterId) {
    return textResponse("wrong broadcaster account", 403);
  }

  const stored = await writeBroadcasterTokenState(env, {
    accessToken: tokenData.access_token,
    accessTokenExpiresAt: Date.now() + Math.max(60, tokenData.expires_in || 3600) * 1000,
    refreshToken: tokenData.refresh_token,
  }, secrets);
  if (!stored) return textResponse("failed to persist broadcaster token", 502);

  const body = [
    "Twitch broadcaster grant OK.",
    `Broadcaster: ${broadcaster.display_name} (${broadcaster.id})`,
    "The rotating broadcaster credentials were encrypted and stored in Workers KV.",
    "Remove the TWITCH_SETUP_KEY binding and redeploy to disable setup.",
  ].join("\n");

  return new Response(body, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Robots-Tag": "noindex, nofollow",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "Set-Cookie": clearOAuthStateCookie(request),
    },
  });
}
