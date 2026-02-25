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

interface Env {
  PATREON_CLIENT_ID: string;
  PATREON_CLIENT_SECRET: string;
  PATREON_CAMPAIGN_ID: string;
  WORKER_URL: string;
  ALLOWED_ORIGINS: string;
  JWT_SECRET: string;

  // -- Twitch OAuth (Future Use) --
  // TWITCH_CLIENT_ID: string;
  // TWITCH_CLIENT_SECRET: string;
  // WUOTE_USER_ID: string;
}

// -- Types --

interface JWTPayload {
  sub: string; // user_id
  username: string;
  is_follower: boolean;
  is_subscriber: boolean;
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
    type: 'user';
    attributes: {
      full_name: string;
      image_url?: string;
    };
    relationships?: {
      memberships?: {
        data: Array<{ id: string; type: 'member' }>;
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
        data: { type: 'campaign'; id: string };
      };
    };
  }>;
}

// -- Constants --

const JWT_EXPIRY_SECONDS = 24 * 60 * 60; // 24 hours
const STATE_EXPIRY_MS = 10 * 60 * 1000; // 10 minutes

// -- Main Worker --

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') || '';
    const allowedOrigin = getAllowedOrigin(origin, env);

    // CORS Preflight
    if (request.method === 'OPTIONS') {
      return handleCORS(allowedOrigin);
    }

    try {
      switch (url.pathname) {
        case '/auth/login':
          return handlePatreonLogin(request, env);
        case '/auth/callback':
          return handlePatreonCallback(request, env);
        case '/auth/check':
          return handleAuthCheck(request, env, allowedOrigin);
        default:
          return new Response('Not Found', { status: 404 });
      }
    } catch (error) {
      console.error('Worker Error:', error);
      return new Response('Internal Server Error', { status: 500 });
    }
  },
};

// -- Handlers --

async function handlePatreonLogin(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const redirectUrl = url.searchParams.get('redirect') || '';

  // Create a signed state token: base64url(payload).base64url(hmac)
  const expiresAt = Date.now() + STATE_EXPIRY_MS;
  const statePayload = `${redirectUrl}|${expiresAt}`;
  const state = await signState(statePayload, env.JWT_SECRET);

  // Construct the callback URL
  const callbackUri = `${env.WORKER_URL}/auth/callback`;

  // Patreon OAuth V2 Authorization URL
  const authUrl = new URL('https://www.patreon.com/oauth2/authorize');
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('client_id', env.PATREON_CLIENT_ID);
  authUrl.searchParams.set('redirect_uri', callbackUri);
  authUrl.searchParams.set('scope', 'identity identity.memberships');
  authUrl.searchParams.set('state', state);

  return Response.redirect(authUrl.toString(), 302);
}

async function handlePatreonCallback(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const error = url.searchParams.get('error');

  // Validate & decode state
  if (!state) return redirectToError(env, 'missing_state');

  const statePayload = await verifyState(state, env.JWT_SECRET);
  if (!statePayload) return redirectToError(env, 'invalid_state');

  const [redirectUrl, expiresAtStr] = statePayload.split('|');
  const expiresAt = parseInt(expiresAtStr, 10);
  if (isNaN(expiresAt) || Date.now() > expiresAt) {
    return redirectToError(env, 'expired_state');
  }

  const finalRedirectUrl = redirectUrl || 'https://noitamap.com';

  if (error) {
    return Response.redirect(`${finalRedirectUrl}?auth_error=${encodeURIComponent(error)}`, 302);
  }
  if (!code) {
    return Response.redirect(`${finalRedirectUrl}?auth_error=missing_code`, 302);
  }

  try {
    // 1. Exchange Code for Token
    const tokenResponse = await fetch('https://www.patreon.com/api/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        grant_type: 'authorization_code',
        client_id: env.PATREON_CLIENT_ID,
        client_secret: env.PATREON_CLIENT_SECRET,
        redirect_uri: `${env.WORKER_URL}/auth/callback`,
      }),
    });

    if (!tokenResponse.ok) {
      const errText = await tokenResponse.text();
      console.error('Patreon Token Error:', errText);
      return Response.redirect(`${finalRedirectUrl}?auth_error=token_exchange_failed`, 302);
    }

    const tokenData = (await tokenResponse.json()) as PatreonTokenResponse;

    // 2. Fetch Identity & Memberships
    const identityUrl = new URL('https://www.patreon.com/api/oauth2/v2/identity');
    identityUrl.searchParams.set('include', 'memberships,memberships.campaign');
    identityUrl.searchParams.set('fields[user]', 'full_name,image_url');
    identityUrl.searchParams.set(
      'fields[member]',
      'patron_status,currently_entitled_amount_cents,campaign_lifetime_support_cents'
    );

    const identityResponse = await fetch(identityUrl.toString(), {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });

    if (!identityResponse.ok) {
      const errText = await identityResponse.text();
      console.error('Patreon Identity Error:', errText);
      return Response.redirect(`${finalRedirectUrl}?auth_error=identity_fetch_failed`, 302);
    }

    const identityData = (await identityResponse.json()) as PatreonIdentityResponse;
    const user = identityData.data;

    // 3. Check Membership Status
    let isFollower = false;
    let isSubscriber = false;

    if (identityData.included) {
      for (const item of identityData.included) {
        if (item.type !== 'member') continue;

        const campaignId = item.relationships?.campaign?.data?.id;
        if (env.PATREON_CAMPAIGN_ID && campaignId !== env.PATREON_CAMPAIGN_ID) {
          continue;
        }

        isFollower = true;

        if (
          item.attributes.patron_status === 'active_patron' &&
          item.attributes.currently_entitled_amount_cents > 0
        ) {
          isSubscriber = true;
        }
      }
    }

    // 4. Create JWT (24h expiry)
    const now = Math.floor(Date.now() / 1000);
    const jwt = await signJWT(
      {
        sub: user.id,
        username: user.attributes.full_name || 'Patron',
        is_follower: isFollower,
        is_subscriber: isSubscriber,
        iat: now,
        exp: now + JWT_EXPIRY_SECONDS,
      },
      env.JWT_SECRET
    );

    // 5. Redirect with Token
    const redirectUrlObj = new URL(finalRedirectUrl);
    redirectUrlObj.searchParams.set('auth', 'success');
    redirectUrlObj.searchParams.set('token', jwt);

    return new Response(null, {
      status: 302,
      headers: { Location: redirectUrlObj.toString() },
    });
  } catch (err) {
    console.error('Callback Exception:', err);
    return Response.redirect(`${finalRedirectUrl}?auth_error=server_error`, 302);
  }
}

async function handleAuthCheck(request: Request, env: Env, allowedOrigin: string): Promise<Response> {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return jsonResponse({ authenticated: false }, allowedOrigin);
  }

  const token = authHeader.substring(7);
  const payload = await verifyJWT(token, env.JWT_SECRET);
  if (!payload) {
    return jsonResponse({ authenticated: false }, allowedOrigin);
  }

  return jsonResponse(
    {
      authenticated: true,
      username: payload.username,
      isFollower: payload.is_follower,
      isSubscriber: payload.is_subscriber,
    },
    allowedOrigin
  );
}

// -- Helpers --

function getAllowedOrigin(origin: string, env: Env): string {
  const allowed = env.ALLOWED_ORIGINS.split(',').map(o => o.trim());
  return allowed.includes(origin) ? origin : allowed[0];
}

function handleCORS(allowedOrigin: string): Response {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': allowedOrigin,
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Allow-Credentials': 'true',
      'Access-Control-Max-Age': '86400',
    },
  });
}

function jsonResponse(data: unknown, allowedOrigin: string): Response {
  return new Response(JSON.stringify(data), {
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': allowedOrigin,
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Allow-Credentials': 'true',
    },
  });
}

function redirectToError(env: Env, error: string): Response {
  const allowed = env.ALLOWED_ORIGINS.split(',').map(o => o.trim());
  const fallback = allowed[0] || 'https://noitamap.com';
  return Response.redirect(`${fallback}?auth_error=${error}`, 302);
}

// -- HMAC State Utils --

async function signState(payload: string, secret: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const payloadB64 = base64url(enc.encode(payload));
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(payloadB64));
  return `${payloadB64}.${base64url(sig)}`;
}

async function verifyState(state: string, secret: string): Promise<string | null> {
  const parts = state.split('.');
  if (parts.length !== 2) return null;
  const [payloadB64, sigB64] = parts;

  const enc = new TextEncoder();
  try {
    const key = await crypto.subtle.importKey(
      'raw',
      enc.encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['verify']
    );
    const sigStr = sigB64.replace(/-/g, '+').replace(/_/g, '/');
    const binSig = atob(sigStr);
    const sigBytes = new Uint8Array(binSig.length);
    for (let i = 0; i < binSig.length; i++) sigBytes[i] = binSig.charCodeAt(i);

    const valid = await crypto.subtle.verify('HMAC', key, sigBytes, enc.encode(payloadB64));
    if (!valid) return null;

    const payloadStr = atob(payloadB64.replace(/-/g, '+').replace(/_/g, '/'));
    return payloadStr;
  } catch {
    return null;
  }
}

// -- JWT Utils --

function base64url(data: ArrayBuffer | Uint8Array): string {
  const bytes = new Uint8Array(data);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function signJWT(payload: JWTPayload, secret: string): Promise<string> {
  const enc = new TextEncoder();
  const header = { alg: 'HS256', typ: 'JWT' };
  const headerB64 = base64url(enc.encode(JSON.stringify(header)));
  const payloadB64 = base64url(enc.encode(JSON.stringify(payload)));
  const input = `${headerB64}.${payloadB64}`;

  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(input));
  return `${input}.${base64url(sig)}`;
}

async function verifyJWT(token: string, secret: string): Promise<JWTPayload | null> {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [headerB64, payloadB64, sigB64] = parts;
  const input = `${headerB64}.${payloadB64}`;
  const enc = new TextEncoder();

  try {
    const key = await crypto.subtle.importKey(
      'raw',
      enc.encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['verify']
    );
    const sigStr = sigB64.replace(/-/g, '+').replace(/_/g, '/');
    const binSig = atob(sigStr);
    const sigBytes = new Uint8Array(binSig.length);
    for (let i = 0; i < binSig.length; i++) sigBytes[i] = binSig.charCodeAt(i);

    const valid = await crypto.subtle.verify('HMAC', key, sigBytes, enc.encode(input));
    if (!valid) return null;

    const payloadStr = atob(payloadB64.replace(/-/g, '+').replace(/_/g, '/'));
    const payload = JSON.parse(payloadStr) as JWTPayload;

    if (payload.exp < Date.now() / 1000) return null;
    return payload;
  } catch {
    return null;
  }
}

// ============================================================================
// TWITCH AUTHENTICATION (Preserved for Future Use)
// ============================================================================
/*
// To re-enable Twitch:
// 1. Add TWITCH_CLIENT_ID, TWITCH_CLIENT_SECRET, WUOTE_USER_ID to Env interface
// 2. Uncomment functions below
// 3. Add case '/auth/twitch' to switch statement

async function handleTwitchLogin(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const redirectUrl = url.searchParams.get('redirect') || '';
  const state = crypto.randomUUID();
  const redirectUri = `${env.WORKER_URL}/auth/callback`;

  const twitchAuthUrl = new URL('https://id.twitch.tv/oauth2/authorize');
  twitchAuthUrl.searchParams.set('client_id', env.TWITCH_CLIENT_ID);
  twitchAuthUrl.searchParams.set('redirect_uri', redirectUri);
  twitchAuthUrl.searchParams.set('response_type', 'code');
  twitchAuthUrl.searchParams.set('scope', 'user:read:follows user:read:subscriptions');
  twitchAuthUrl.searchParams.set('state', state);

  // NOTE: Twitch would need its own state signing mechanism (HMAC like Patreon above)
  return Response.redirect(twitchAuthUrl.toString(), 302);
}

async function handleTwitchCallback(request: Request, env: Env): Promise<Response> {
  // ... (Original implementation)
  // See git history for full implementation if needed, or previous version of this file.
  // The logic follows standard OAuth flow: exchange code -> get token -> get user -> check subs
  return new Response("Twitch auth not active");
}
*/
