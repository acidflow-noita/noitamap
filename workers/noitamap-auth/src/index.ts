/**
 * Noitamap Auth Worker - Handles Twitch OAuth for drawing feature
 * Uses D1 database for session storage
 *
 * Adapted from bartender-auth with:
 * - 30-day session duration
 * - user:read:subscriptions scope for future subscriber check
 * - Support for both noitamap.com and dev.noitamap.com
 */

interface Env {
  AUTH_DB: D1Database;
  TWITCH_CLIENT_ID: string;
  TWITCH_CLIENT_SECRET: string;
  WUOTE_USER_ID: string;
  WORKER_URL: string;
  ALLOWED_ORIGINS: string; // Comma-separated list of allowed origins
}

interface Session {
  id: string;
  user_id: string;
  username: string;
  is_follower: number;
  is_subscriber: number;
  created_at: number;
  expires_at: number;
}

// 30 days in milliseconds
const SESSION_DURATION_MS = 30 * 24 * 60 * 60 * 1000;
const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Initialize database on first run
    await initializeDatabase(env);

    // Get allowed origin from request
    const origin = request.headers.get("Origin") || "";
    const allowedOrigin = getAllowedOrigin(origin, env);

    // Handle CORS preflight
    if (request.method === "OPTIONS") {
      return handleCORS(allowedOrigin);
    }

    try {
      switch (url.pathname) {
        case "/auth/login":
          return handleLogin(request, env);

        case "/auth/callback":
          return handleCallback(request, env);

        case "/auth/check":
          return handleAuthCheck(request, env, allowedOrigin);

        case "/auth/logout":
          return handleLogout(request, env, allowedOrigin);

        default:
          return new Response("Not Found", { status: 404 });
      }
    } catch (error) {
      console.error("Auth worker error:", error);
      return new Response("Internal Server Error", { status: 500 });
    }
  },
};

function getAllowedOrigin(origin: string, env: Env): string {
  const allowedOrigins = env.ALLOWED_ORIGINS.split(",").map((o) => o.trim());

  if (allowedOrigins.includes(origin)) {
    return origin;
  }

  // Return first allowed origin as default
  return allowedOrigins[0] || "https://noitamap.com";
}

async function initializeDatabase(env: Env): Promise<void> {
  try {
    // Create sessions table if it doesn't exist
    await env.AUTH_DB.prepare(
      `
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        username TEXT NOT NULL,
        is_follower INTEGER NOT NULL,
        is_subscriber INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      )
    `
    ).run();

    // Create states table for OAuth state validation
    await env.AUTH_DB.prepare(
      `
      CREATE TABLE IF NOT EXISTS oauth_states (
        state TEXT PRIMARY KEY,
        redirect_url TEXT,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      )
    `
    ).run();

    // Clean up expired sessions and states
    const now = Date.now();
    await env.AUTH_DB.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(now).run();
    await env.AUTH_DB.prepare("DELETE FROM oauth_states WHERE expires_at < ?").bind(now).run();
  } catch (error) {
    console.error("Database initialization error:", error);
  }
}

function handleCORS(allowedOrigin: string): Response {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": allowedOrigin,
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, Cookie",
      "Access-Control-Allow-Credentials": "true",
      "Access-Control-Max-Age": "86400",
    },
  });
}

function addCORSHeaders(response: Response, allowedOrigin: string): Response {
  const newResponse = new Response(response.body, response);
  newResponse.headers.set("Access-Control-Allow-Origin", allowedOrigin);
  newResponse.headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  newResponse.headers.set("Access-Control-Allow-Headers", "Content-Type, Authorization, Cookie");
  newResponse.headers.set("Access-Control-Allow-Credentials", "true");
  return newResponse;
}

async function handleLogin(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const redirectUrl = url.searchParams.get("redirect") || "";

  const state = crypto.randomUUID();
  const redirectUri = `${env.WORKER_URL}/auth/callback`;

  const twitchAuthUrl = new URL("https://id.twitch.tv/oauth2/authorize");
  twitchAuthUrl.searchParams.set("client_id", env.TWITCH_CLIENT_ID);
  twitchAuthUrl.searchParams.set("redirect_uri", redirectUri);
  twitchAuthUrl.searchParams.set("response_type", "code");
  // Include user:read:subscriptions for future subscriber check
  twitchAuthUrl.searchParams.set("scope", "user:read:follows user:read:subscriptions");
  twitchAuthUrl.searchParams.set("state", state);

  // Store state for validation (expires in 10 minutes)
  const expiresAt = Date.now() + 10 * 60 * 1000;
  await env.AUTH_DB.prepare(
    "INSERT INTO oauth_states (state, redirect_url, created_at, expires_at) VALUES (?, ?, ?, ?)"
  )
    .bind(state, redirectUrl, Date.now(), expiresAt)
    .run();

  return Response.redirect(twitchAuthUrl.toString(), 302);
}

async function handleCallback(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");

  // Get stored redirect URL from state
  const stateResult = await env.AUTH_DB.prepare(
    "SELECT * FROM oauth_states WHERE state = ? AND expires_at > ?"
  )
    .bind(state, Date.now())
    .first<{ state: string; redirect_url: string; created_at: number; expires_at: number }>();

  const redirectUrl = stateResult?.redirect_url || "";
  const baseRedirect = redirectUrl || "https://noitamap.com";

  if (error) {
    return Response.redirect(`${baseRedirect}?auth_error=${encodeURIComponent(error)}`, 302);
  }

  if (!code || !state) {
    return Response.redirect(`${baseRedirect}?auth_error=missing_parameters`, 302);
  }

  if (!stateResult) {
    return Response.redirect(`${baseRedirect}?auth_error=invalid_state`, 302);
  }

  try {
    // Exchange code for access token
    const tokenResponse = await fetch("https://id.twitch.tv/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: env.TWITCH_CLIENT_ID,
        client_secret: env.TWITCH_CLIENT_SECRET,
        code: code,
        grant_type: "authorization_code",
        redirect_uri: `${env.WORKER_URL}/auth/callback`,
      }),
    });

    if (!tokenResponse.ok) {
      throw new Error("Token exchange failed");
    }

    const tokenData = (await tokenResponse.json()) as { access_token: string };
    const accessToken = tokenData.access_token;

    // Get user info
    const userResponse = await fetch("https://api.twitch.tv/helix/users", {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Client-Id": env.TWITCH_CLIENT_ID,
      },
    });

    if (!userResponse.ok) {
      throw new Error("Failed to get user info");
    }

    const userData = (await userResponse.json()) as { data: Array<{ id: string; display_name: string }> };
    const user = userData.data[0];

    // Check if user follows the channel
    let isFollower = false;
    try {
      const followsResponse = await fetch(
        `https://api.twitch.tv/helix/channels/followed?user_id=${user.id}&broadcaster_id=${env.WUOTE_USER_ID}`,
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Client-Id": env.TWITCH_CLIENT_ID,
          },
        }
      );

      if (followsResponse.ok) {
        const followsData = (await followsResponse.json()) as { data: unknown[] };
        isFollower = followsData.data && followsData.data.length > 0;
      }
    } catch (error) {
      console.error("Error checking follower status:", error);
      isFollower = false;
    }

    // Check subscriber status (for future use)
    let isSubscriber = false;
    try {
      const subsResponse = await fetch(
        `https://api.twitch.tv/helix/subscriptions/user?broadcaster_id=${env.WUOTE_USER_ID}&user_id=${user.id}`,
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Client-Id": env.TWITCH_CLIENT_ID,
          },
        }
      );

      if (subsResponse.ok) {
        const subsData = (await subsResponse.json()) as { data: unknown[] };
        isSubscriber = subsData.data && subsData.data.length > 0;
      }
    } catch (error) {
      console.error("Error checking subscriber status:", error);
      isSubscriber = false;
    }

    console.log("User ID:", user.id, "Username:", user.display_name);
    console.log("Is follower:", isFollower, "Is subscriber:", isSubscriber);

    // Create session (expires in 30 days)
    const sessionId = crypto.randomUUID();
    const expiresAt = Date.now() + SESSION_DURATION_MS;

    await env.AUTH_DB.prepare(
      `
      INSERT INTO sessions (id, user_id, username, is_follower, is_subscriber, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `
    )
      .bind(sessionId, user.id, user.display_name, isFollower ? 1 : 0, isSubscriber ? 1 : 0, Date.now(), expiresAt)
      .run();

    // Clean up state
    await env.AUTH_DB.prepare("DELETE FROM oauth_states WHERE state = ?").bind(state).run();

    // Determine cookie settings based on environment
    const isLocalhost = baseRedirect.includes("localhost");
    const cookieOptions = isLocalhost
      ? `noitamap_session=${sessionId}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_MAX_AGE_SECONDS}`
      : `noitamap_session=${sessionId}; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=${SESSION_MAX_AGE_SECONDS}`;

    // Redirect back to the original page with session in URL (for cross-domain fallback)
    const redirectWithAuth = new URL(baseRedirect);
    redirectWithAuth.searchParams.set("auth", "success");
    redirectWithAuth.searchParams.set("session", sessionId);

    return new Response(null, {
      status: 302,
      headers: {
        Location: redirectWithAuth.toString(),
        "Set-Cookie": cookieOptions,
      },
    });
  } catch (error) {
    console.error("Callback error:", error);
    return Response.redirect(`${baseRedirect}?auth_error=server_error`, 302);
  }
}

async function handleAuthCheck(request: Request, env: Env, allowedOrigin: string): Promise<Response> {
  let sessionId = getSessionFromRequest(request);

  // Also check Authorization header for cross-domain requests
  if (!sessionId) {
    const authHeader = request.headers.get("Authorization");
    if (authHeader && authHeader.startsWith("Bearer ")) {
      sessionId = authHeader.substring(7);
    }
  }

  // Also check query parameter (fallback for cross-domain)
  if (!sessionId) {
    const url = new URL(request.url);
    sessionId = url.searchParams.get("session");
  }

  if (!sessionId) {
    return addCORSHeaders(
      new Response(JSON.stringify({ authenticated: false }), {
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "private, max-age=60",
        },
      }),
      allowedOrigin
    );
  }

  const session = await env.AUTH_DB.prepare("SELECT * FROM sessions WHERE id = ? AND expires_at > ?")
    .bind(sessionId, Date.now())
    .first<Session>();

  if (!session) {
    return addCORSHeaders(
      new Response(JSON.stringify({ authenticated: false }), {
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "private, max-age=60",
        },
      }),
      allowedOrigin
    );
  }

  return addCORSHeaders(
    new Response(
      JSON.stringify({
        authenticated: true,
        username: session.username,
        isFollower: session.is_follower === 1,
        isSubscriber: session.is_subscriber === 1,
      }),
      {
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "private, max-age=3600",
        },
      }
    ),
    allowedOrigin
  );
}

async function handleLogout(request: Request, env: Env, allowedOrigin: string): Promise<Response> {
  let sessionId = getSessionFromRequest(request);

  // Also check Authorization header
  if (!sessionId) {
    const authHeader = request.headers.get("Authorization");
    if (authHeader && authHeader.startsWith("Bearer ")) {
      sessionId = authHeader.substring(7);
    }
  }

  if (sessionId) {
    await env.AUTH_DB.prepare("DELETE FROM sessions WHERE id = ?").bind(sessionId).run();
  }

  const response = addCORSHeaders(
    new Response(JSON.stringify({ success: true }), {
      headers: { "Content-Type": "application/json" },
    }),
    allowedOrigin
  );

  response.headers.set(
    "Set-Cookie",
    `noitamap_session=; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=0`
  );

  return response;
}

function getSessionFromRequest(request: Request): string | null {
  const cookieHeader = request.headers.get("Cookie");
  if (!cookieHeader) return null;

  const cookies = cookieHeader.split(";").reduce(
    (acc, cookie) => {
      const [key, value] = cookie.trim().split("=");
      acc[key] = value;
      return acc;
    },
    {} as Record<string, string>
  );

  return cookies.noitamap_session || null;
}
