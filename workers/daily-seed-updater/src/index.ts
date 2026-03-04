/**
 * daily-seed-updater worker
 *
 * Cron-only (00:01 UTC daily). No HTTP route.
 *
 * 1. Fetches the Noita daily seed from Nolla's endpoint.
 * 2. Deploys a new version of daily-seed-serve (static assets worker)
 *    containing the updated current_seed.txt and _headers file,
 *    using the Cloudflare Workers Versions + Deployments API.
 *
 * Required secrets (in Secrets Store 291b9519666945a1a56adbb686c62d76):
 *   CF_API_TOKEN  — API token with Workers Scripts:Edit on the account
 *   CF_ACCOUNT_ID — Cloudflare account ID
 */

// Secrets Store bindings return objects with .get(), plain vars are strings
interface SecretStoreSecret {
  get(): Promise<string>;
}

interface Env {
  // Secrets Store bindings
  CF_API_TOKEN: SecretStoreSecret;
  CF_ACCOUNT_ID: SecretStoreSecret;
  // Plain environment variables (from wrangler.jsonc vars)
  SEED_WORKER_NAME: string;
}

const NOLLA_URL = "https://takapuoli.noitagame.com/callback";

/** Parse the seed from Nolla's semicolon-delimited response. */
function parseSeed(text: string): number | null {
  const parts = text.split(";");
  const seed = parseInt(parts[1], 10);
  return isNaN(seed) ? null : seed;
}

/** Build the _headers file content for CORS + caching. */
function headersFileContent(): string {
  return (
    [
      "/current_seed.txt",
      "  Access-Control-Allow-Origin: *",
      "  Access-Control-Allow-Methods: GET, OPTIONS",
      "  Cache-Control: public, max-age=300, s-maxage=300",
      "  Content-Type: text/plain; charset=utf-8",
    ].join("\n") + "\n"
  );
}

/**
 * Deploy new static assets to the daily-seed-serve worker using the
 * CF Direct Upload API (3-step flow from the docs):
 *   1. POST .../assets-upload-session  (manifest → jwt + buckets)
 *   2. POST .../assets/upload?base64=true  (file content, auth = upload jwt)
 *   3. PUT  .../scripts/{name}  (deploy worker with completion jwt)
 */
async function deployStaticAssets(
  seed: number,
  apiToken: string,
  accountId: string,
  workerName: string,
): Promise<void> {
  const seedContent = seed.toString() + "\n";
  const headersContent = headersFileContent();

  const apiBase = `https://api.cloudflare.com/client/v4/accounts/${accountId}`;

  // Encode to bytes + base64
  const encoder = new TextEncoder();
  const seedBytes = encoder.encode(seedContent);
  const headersBytes = encoder.encode(headersContent);
  const seedB64 = bytesToBase64(seedBytes);
  const headersB64 = bytesToBase64(headersBytes);

  // Hash = sha256(base64(content) + extension) truncated to 32 hex chars
  const seedHash = await assetHash(seedB64, ".txt");
  const headersHash = await assetHash(headersB64, "");

  // --- Step 1: Create upload session ---
  const sessionResp = await fetch(`${apiBase}/workers/scripts/${workerName}/assets-upload-session`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      manifest: {
        "/current_seed.txt": { hash: seedHash, size: seedBytes.byteLength },
        "/_headers": { hash: headersHash, size: headersBytes.byteLength },
      },
    }),
  });
  if (!sessionResp.ok) {
    const text = await sessionResp.text();
    throw new Error(`Asset upload session failed (${sessionResp.status}): ${text}`);
  }
  const sessionData = (await sessionResp.json()) as {
    result: { jwt: string; buckets: string[][] };
  };
  let jwt = sessionData.result.jwt;
  const buckets = sessionData.result.buckets;

  // --- Step 2: Upload files ---
  const hashToB64: Record<string, string> = {
    [seedHash]: seedB64,
    [headersHash]: headersB64,
  };

  for (const bucket of buckets) {
    const formData = new FormData();
    for (const hash of bucket) {
      if (hashToB64[hash]) {
        formData.append(hash, hashToB64[hash]);
      }
    }

    const uploadResp = await fetch(`${apiBase}/workers/assets/upload?base64=true`, {
      method: "POST",
      headers: { Authorization: `Bearer ${jwt}` },
      body: formData,
    });
    if (!uploadResp.ok) {
      const text = await uploadResp.text();
      throw new Error(`Asset upload failed (${uploadResp.status}): ${text}`);
    }
    const uploadData = (await uploadResp.json()) as { result?: { jwt?: string } };
    if (uploadData.result?.jwt) {
      jwt = uploadData.result.jwt;
    }
  }

  // --- Step 3: Deploy worker with completion JWT ---
  // For assets-only workers, we just need to provide the assets JWT in the metadata
  const deployForm = new FormData();
  const metadata = {
    assets: { jwt },
    compatibility_date: "2026-02-19",
  };
  deployForm.append("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }));

  const deployResp = await fetch(`${apiBase}/workers/scripts/${workerName}`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${apiToken}` },
    body: deployForm,
  });
  if (!deployResp.ok) {
    const text = await deployResp.text();
    throw new Error(`Worker deploy failed (${deployResp.ok ? "OK" : deployResp.status}): ${text}`);
  }

  console.log(`Deployed daily-seed-serve with seed: ${seed}`);
}

/** Convert Uint8Array to base64 string. */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

/** Asset hash per CF docs: sha256(base64(content) + extension), first 32 hex chars. */
async function assetHash(contentBase64: string, extension: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(contentBase64 + extension);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 32);
}

async function runUpdate(env: Env): Promise<string> {
  // Resolve secrets from Secrets Store
  const [apiToken, accountId] = await Promise.all([env.CF_API_TOKEN.get(), env.CF_ACCOUNT_ID.get()]);

  // 1. Fetch seed from Nolla
  const resp = await fetch(NOLLA_URL);
  if (!resp.ok) {
    const msg = `Nolla fetch failed: ${resp.status} ${resp.statusText}`;
    console.error(msg);
    throw new Error(msg);
  }
  const text = await resp.text();
  const seed = parseSeed(text);
  if (seed === null) {
    const msg = `Failed to parse seed from: ${text}`;
    console.error(msg);
    throw new Error(msg);
  }
  console.log(`Fetched daily seed: ${seed}`);

  // 2. Deploy to the static seed worker
  await deployStaticAssets(seed, apiToken, accountId, env.SEED_WORKER_NAME);
  return `Deployed seed: ${seed}`;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // Add CORS headers to all responses
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, HEAD, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Cache-Control",
      "Access-Control-Max-Age": "86400",
    };

    // Handle preflight requests
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    let response: Response;
    if (url.pathname === "/update") {
      try {
        const result = await runUpdate(env);
        response = new Response(result, { status: 200 });
      } catch (err: any) {
        response = new Response(err.message, { status: 500 });
      }
    } else {
      // Default to serving assets (including current_seed.txt)
      try {
        response = await (env as any).ASSETS.fetch(request);
      } catch (e) {
        // Fallback for local dev if ASSETS is not bound correctly
        response = new Response("Not Found", { status: 404 });
      }
    }

    // Wrap the response with CORS headers
    // Note: We create a new Response because some headers might be immutable
    const newHeaders = new Headers(response.headers);
    Object.entries(corsHeaders).forEach(([k, v]) => newHeaders.set(k, v));

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: newHeaders,
    });
  },

  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    await runUpdate(env);
  },
};
