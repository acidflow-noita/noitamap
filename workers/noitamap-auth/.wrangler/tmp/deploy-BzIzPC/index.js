var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// src/index.ts
var JWT_EXPIRY_SECONDS = 24 * 60 * 60;
var STATE_EXPIRY_MS = 10 * 60 * 1e3;
async function resolveSecrets(env) {
  const [patreonClientId, patreonClientSecret, patreonCampaignId, jwtSecret, creatorUserId] = await Promise.all([
    env.PATREON_CLIENT_ID.get(),
    env.PATREON_CLIENT_SECRET.get(),
    env.PATREON_CAMPAIGN_ID.get(),
    env.JWT_SECRET.get(),
    env.CREATOR_USER_ID.get()
  ]);
  return { patreonClientId, patreonClientSecret, patreonCampaignId, jwtSecret, creatorUserId };
}
__name(resolveSecrets, "resolveSecrets");
var src_default = {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "";
    const allowedOrigin = getAllowedOrigin(origin, env);
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
        default:
          return new Response("Not Found", { status: 404 });
      }
    } catch (error) {
      console.error("Worker Error:", error);
      return new Response("Internal Server Error", { status: 500 });
    }
  }
};
async function handlePatreonLogin(request, env, secrets) {
  const url = new URL(request.url);
  const redirectUrl = url.searchParams.get("redirect") || "";
  const expiresAt = Date.now() + STATE_EXPIRY_MS;
  const statePayload = `${redirectUrl}|${expiresAt}`;
  const state = await signState(statePayload, secrets.jwtSecret);
  const callbackUri = `${env.WORKER_URL}/auth/callback`;
  const authUrl = new URL("https://www.patreon.com/oauth2/authorize");
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("client_id", secrets.patreonClientId);
  authUrl.searchParams.set("redirect_uri", callbackUri);
  authUrl.searchParams.set("scope", "identity identity.memberships");
  authUrl.searchParams.set("state", state);
  return Response.redirect(authUrl.toString(), 302);
}
__name(handlePatreonLogin, "handlePatreonLogin");
async function handlePatreonCallback(request, env, secrets) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");
  if (!state)
    return redirectToError(env, "missing_state");
  const statePayload = await verifyState(state, secrets.jwtSecret);
  if (!statePayload)
    return redirectToError(env, "invalid_state");
  const [redirectUrl, expiresAtStr] = statePayload.split("|");
  const expiresAt = parseInt(expiresAtStr, 10);
  if (isNaN(expiresAt) || Date.now() > expiresAt) {
    return redirectToError(env, "expired_state");
  }
  const finalRedirectUrl = redirectUrl || "https://noitamap.com";
  if (error) {
    return Response.redirect(`${finalRedirectUrl}?auth_error=${encodeURIComponent(error)}`, 302);
  }
  if (!code) {
    return Response.redirect(`${finalRedirectUrl}?auth_error=missing_code`, 302);
  }
  try {
    const tokenResponse = await fetch("https://www.patreon.com/api/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        grant_type: "authorization_code",
        client_id: secrets.patreonClientId,
        client_secret: secrets.patreonClientSecret,
        redirect_uri: `${env.WORKER_URL}/auth/callback`
      })
    });
    if (!tokenResponse.ok) {
      const errText = await tokenResponse.text();
      console.error("Patreon Token Error:", errText);
      return Response.redirect(`${finalRedirectUrl}?auth_error=token_exchange_failed`, 302);
    }
    const tokenData = await tokenResponse.json();
    const identityUrl = new URL("https://www.patreon.com/api/oauth2/v2/identity");
    identityUrl.searchParams.set("include", "memberships,memberships.campaign");
    identityUrl.searchParams.set("fields[user]", "vanity,image_url");
    identityUrl.searchParams.set(
      "fields[member]",
      "patron_status,currently_entitled_amount_cents,campaign_lifetime_support_cents"
    );
    const identityResponse = await fetch(identityUrl.toString(), {
      headers: { Authorization: `Bearer ${tokenData.access_token}` }
    });
    if (!identityResponse.ok) {
      const errText = await identityResponse.text();
      console.error("Patreon Identity Error:", errText);
      return Response.redirect(`${finalRedirectUrl}?auth_error=identity_fetch_failed`, 302);
    }
    const identityData = await identityResponse.json();
    const user = identityData.data;
    let isFollower = false;
    let isSubscriber = false;
    if (secrets.creatorUserId && user.id === secrets.creatorUserId) {
      isFollower = true;
      isSubscriber = true;
    } else if (identityData.included) {
      for (const item of identityData.included) {
        if (item.type !== "member")
          continue;
        const campaignId = item.relationships?.campaign?.data?.id;
        if (secrets.patreonCampaignId && campaignId !== secrets.patreonCampaignId) {
          continue;
        }
        isFollower = true;
        if (item.attributes.patron_status === "active_patron" && item.attributes.currently_entitled_amount_cents > 0) {
          isSubscriber = true;
        }
      }
    }
    const now = Math.floor(Date.now() / 1e3);
    const jwt = await signJWT(
      {
        sub: user.id,
        // Default to "Patron" if no vanity name is set, ensuring we never use/store full name
        username: user.attributes.vanity || "Patron",
        nickname: user.attributes.vanity || null,
        is_follower: isFollower,
        is_subscriber: isSubscriber,
        iat: now,
        exp: now + JWT_EXPIRY_SECONDS
      },
      secrets.jwtSecret
    );
    const redirectUrlObj = new URL(finalRedirectUrl);
    redirectUrlObj.searchParams.set("auth", "success");
    redirectUrlObj.searchParams.set("token", jwt);
    return new Response(null, {
      status: 302,
      headers: { Location: redirectUrlObj.toString() }
    });
  } catch (err) {
    console.error("Callback Exception:", err);
    return Response.redirect(`${finalRedirectUrl}?auth_error=server_error`, 302);
  }
}
__name(handlePatreonCallback, "handlePatreonCallback");
async function handleAuthCheck(request, secrets, allowedOrigin) {
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
      isSubscriber: payload.is_subscriber
    },
    allowedOrigin
  );
}
__name(handleAuthCheck, "handleAuthCheck");
function getAllowedOrigin(origin, env) {
  const allowed = env.ALLOWED_ORIGINS.split(",").map((o) => o.trim());
  return allowed.includes(origin) ? origin : allowed[0];
}
__name(getAllowedOrigin, "getAllowedOrigin");
function handleCORS(allowedOrigin) {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": allowedOrigin,
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Allow-Credentials": "true",
      "Access-Control-Max-Age": "86400"
    }
  });
}
__name(handleCORS, "handleCORS");
function jsonResponse(data, allowedOrigin) {
  return new Response(JSON.stringify(data), {
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": allowedOrigin,
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Allow-Credentials": "true"
    }
  });
}
__name(jsonResponse, "jsonResponse");
function redirectToError(env, error) {
  const allowed = env.ALLOWED_ORIGINS.split(",").map((o) => o.trim());
  const fallback = allowed[0] || "https://noitamap.com";
  return Response.redirect(`${fallback}?auth_error=${error}`, 302);
}
__name(redirectToError, "redirectToError");
async function signState(payload, secret) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign"
  ]);
  const payloadB64 = base64url(enc.encode(payload));
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(payloadB64));
  return `${payloadB64}.${base64url(sig)}`;
}
__name(signState, "signState");
async function verifyState(state, secret) {
  const parts = state.split(".");
  if (parts.length !== 2)
    return null;
  const [payloadB64, sigB64] = parts;
  const enc = new TextEncoder();
  try {
    const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
      "verify"
    ]);
    const sigStr = sigB64.replace(/-/g, "+").replace(/_/g, "/");
    const binSig = atob(sigStr);
    const sigBytes = new Uint8Array(binSig.length);
    for (let i = 0; i < binSig.length; i++)
      sigBytes[i] = binSig.charCodeAt(i);
    const valid = await crypto.subtle.verify("HMAC", key, sigBytes, enc.encode(payloadB64));
    if (!valid)
      return null;
    const payloadStr = atob(payloadB64.replace(/-/g, "+").replace(/_/g, "/"));
    return payloadStr;
  } catch {
    return null;
  }
}
__name(verifyState, "verifyState");
function base64url(data) {
  const bytes = new Uint8Array(data);
  let binary = "";
  for (const b of bytes)
    binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
__name(base64url, "base64url");
async function signJWT(payload, secret) {
  const enc = new TextEncoder();
  const header = { alg: "HS256", typ: "JWT" };
  const headerB64 = base64url(enc.encode(JSON.stringify(header)));
  const payloadB64 = base64url(enc.encode(JSON.stringify(payload)));
  const input = `${headerB64}.${payloadB64}`;
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign"
  ]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(input));
  return `${input}.${base64url(sig)}`;
}
__name(signJWT, "signJWT");
async function verifyJWT(token, secret) {
  const parts = token.split(".");
  if (parts.length !== 3)
    return null;
  const [headerB64, payloadB64, sigB64] = parts;
  const input = `${headerB64}.${payloadB64}`;
  const enc = new TextEncoder();
  try {
    const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
      "verify"
    ]);
    const sigStr = sigB64.replace(/-/g, "+").replace(/_/g, "/");
    const binSig = atob(sigStr);
    const sigBytes = new Uint8Array(binSig.length);
    for (let i = 0; i < binSig.length; i++)
      sigBytes[i] = binSig.charCodeAt(i);
    const valid = await crypto.subtle.verify("HMAC", key, sigBytes, enc.encode(input));
    if (!valid)
      return null;
    const payloadStr = atob(payloadB64.replace(/-/g, "+").replace(/_/g, "/"));
    const payload = JSON.parse(payloadStr);
    if (payload.exp < Date.now() / 1e3)
      return null;
    return payload;
  } catch {
    return null;
  }
}
__name(verifyJWT, "verifyJWT");
export {
  src_default as default
};
//# sourceMappingURL=index.js.map
