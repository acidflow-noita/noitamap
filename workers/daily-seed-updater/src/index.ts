import { rules as seedHeaders } from '../seed-headers.json';

/**
 * daily-seed-updater worker
 *
 * Cron-only (00:01 UTC daily). No HTTP route.
 *
 * 1. Fetches the Noita daily seed from Nolla's endpoint.
 * 2. Deploys a new version of daily-seed-serve (static assets worker)
 *    containing the updated current_seed.txt and _headers file,
 *    using the Cloudflare Workers Versions + Deployments API.
 * 3. Triggers the biome-baker GitLab pipeline for the new seed (promote
 *    yesterday's bake to previous-daily-*, bake + deploy today's to daily-*).
 *
 * Required secrets (in Secrets Store 291b9519666945a1a56adbb686c62d76):
 *   NOITAMAP_SEED_DEPLOY_TOKEN — dedicated API token restricted to daily-seed-serve
 *                              (exposed through the CF_API_TOKEN binding)
 *   CF_ACCOUNT_ID — Cloudflare account ID
 *   GITLAB_BIOME_BAKER_TRIGGER_TOKEN — GitLab pipeline trigger token for the
 *                   biome-baker project (83006723)
 */

// Secrets Store bindings return objects with .get(), plain vars are strings
interface SecretStoreSecret {
  get(): Promise<string>;
}

interface Env {
  // Secrets Store bindings
  CF_API_TOKEN: SecretStoreSecret;
  CF_ACCOUNT_ID: SecretStoreSecret;
  GITLAB_BIOME_BAKER_TRIGGER_TOKEN: SecretStoreSecret;
  // Plain environment variables (from wrangler.jsonc vars)
  SEED_WORKER_NAME: string;
}

const NOLLA_URL = "https://takapuoli.noitagame.com/callback";
const PUBLIC_SEED_URL = "https://daily-seed.acidflow.stream/current_seed.txt";
const GITLAB_TRIGGER_URL = "https://gitlab.com/api/v4/projects/83006723/trigger/pipeline";
const GITLAB_REF = "main";

/** Parse the seed from Nolla's semicolon-delimited response. */
function parseSeed(text: string): number | null {
  const parts = text.split(";");
  const value = parts[1]?.trim() || '';
  const seed = /^\d{1,10}$/.test(value) ? Number(value) : NaN;
  return Number.isSafeInteger(seed) && seed >= 0 && seed <= 4294967295 ? seed : null;
}

/**
 * Read the seed currently published at the daily-seed-serve worker. That value
 * becomes "yesterday's daily" once we deploy a fresh current_seed.txt.
 * Returns null if the worker hasn't been deployed yet or the fetch fails.
 */
async function fetchPublishedCurrentSeed(): Promise<number | null> {
  try {
    const resp = await fetch(PUBLIC_SEED_URL, { cf: { cacheTtl: 0 } as any });
    if (!resp.ok) return null;
    return parseSeed('seed;' + (await resp.text()).trim());
  } catch {
    return null;
  }
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
  previousSeed: number | null,
  apiToken: string,
  accountId: string,
  workerName: string,
): Promise<void> {
  const seedContent = seed.toString() + "\n";
  // Fall back to the new seed if we couldn't read a previous one (first
  // ever deploy); the diff client treats prev == current as "no comparison".
  const previousContent = (previousSeed ?? seed).toString() + "\n";

  const apiBase = `https://api.cloudflare.com/client/v4/accounts/${accountId}`;

  // Encode to bytes + base64
  const encoder = new TextEncoder();
  const seedBytes = encoder.encode(seedContent);
  const prevBytes = encoder.encode(previousContent);
  const seedB64 = bytesToBase64(seedBytes);
  const prevB64 = bytesToBase64(prevBytes);

  // Hash = sha256(base64(content) + extension) truncated to 32 hex chars
  const seedHash = await assetHash(seedB64, ".txt");
  const prevHash = await assetHash(prevB64, ".txt");

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
        "/previous_seed.txt": { hash: prevHash, size: prevBytes.byteLength },
      },
    }),
  });
  if (!sessionResp.ok) {
    throw new Error(`Asset upload session failed (HTTP ${sessionResp.status}).`);
  }
  const sessionData = (await sessionResp.json()) as {
    result: { jwt: string; buckets: string[][] };
  };
  let jwt = sessionData.result.jwt;
  const buckets = sessionData.result.buckets;

  // --- Step 2: Upload files ---
  const hashToB64: Record<string, string> = {
    [seedHash]: seedB64,
    [prevHash]: prevB64,
  };

  for (const bucket of buckets) {
    const formData = new FormData();
    for (const hash of bucket) {
      if (hashToB64[hash]) {
        formData.append(hash, new Blob([hashToB64[hash]], { type: 'text/plain; charset=utf-8' }), hash);
      }
    }

    const uploadResp = await fetch(`${apiBase}/workers/assets/upload?base64=true`, {
      method: "POST",
      headers: { Authorization: `Bearer ${jwt}` },
      body: formData,
    });
    if (!uploadResp.ok) {
      throw new Error(`Asset upload failed (HTTP ${uploadResp.status}).`);
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
    // Direct API uploads do not parse an uploaded /_headers asset. Wrangler
    // sends the rules in assets.config._headers; use that same wire format.
    assets: { jwt, config: { _headers: seedHeaders } },
    compatibility_date: "2026-02-19",
  };
  deployForm.append("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }));

  const deployResp = await fetch(`${apiBase}/workers/scripts/${workerName}`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${apiToken}` },
    body: deployForm,
  });
  if (!deployResp.ok) {
    throw new Error(`Worker deploy failed (HTTP ${deployResp.status}).`);
  }

  console.log(`Deployed daily-seed-serve with seed: ${seed}`);
}

/**
 * Trigger the biome-baker pipeline on GitLab. The pipeline promotes
 * yesterday's bake to the previous-daily-* workers (no re-bake), then bakes
 * the new seed and deploys it to daily-*. Retries transient failures; throws
 * if the trigger never lands so the cron invocation shows up as failed.
 */
async function triggerBake(env: Env, seed: number): Promise<void> {
  const token = await env.GITLAB_BIOME_BAKER_TRIGGER_TOKEN.get();
  const body = new FormData();
  body.set("token", token);
  body.set("ref", GITLAB_REF);
  body.set("variables[SEED]", String(seed));
  body.set("variables[BAKE_KIND]", "daily");

  let lastError = "";
  for (let attempt = 1; attempt <= 3; attempt++) {
    const resp = await fetch(GITLAB_TRIGGER_URL, { method: "POST", body });
    if (resp.ok) {
      const { id, web_url } = (await resp.json()) as { id: number; web_url: string };
      console.log(`Triggered bake pipeline #${id}: ${web_url}`);
      return;
    }
    lastError = `HTTP ${resp.status}`;
    console.warn(`Bake trigger attempt ${attempt}/3 failed: ${lastError}`);
    if (attempt < 3) await new Promise((r) => setTimeout(r, 2000 * attempt));
  }
  throw new Error(
    `Bake trigger failed after 3 attempts (${lastError}). Seed files ARE deployed; ` +
      `start the bake manually: GitLab > Run pipeline on ${GITLAB_REF} with SEED=${seed}.`,
  );
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
  // 0. Read whatever current_seed.txt the static worker is currently serving.
  //    That value becomes "previous" after we deploy today's fresh one. Done
  //    in parallel with the Nolla fetch so the daily update stays snappy.
  const [resp, previousSeed] = await Promise.all([
    fetch(NOLLA_URL),
    fetchPublishedCurrentSeed(),
  ]);

  // 1. Parse Nolla response
  if (!resp.ok) {
    const msg = `Nolla fetch failed (HTTP ${resp.status}).`;
    console.error(msg);
    throw new Error(msg);
  }
  const text = await resp.text();
  const seed = parseSeed(text);
  if (seed === null) {
    const msg = "Invalid daily seed response";
    console.error(msg);
    throw new Error(msg);
  }
  console.log(`Fetched daily seed: ${seed} (previous published: ${previousSeed ?? "<none>"})`);

  // A duplicate cron invocation must not overwrite yesterday's seed or spend
  // another deployment. Failed GitLab triggers can be retried in GitLab itself.
  if (seed === previousSeed) return `Seed unchanged: ${seed}`;
  const [apiToken, accountId] = await Promise.all([env.CF_API_TOKEN.get(), env.CF_ACCOUNT_ID.get()]);
  if (!/^[a-f0-9]{32}$/.test(accountId) || env.SEED_WORKER_NAME !== 'daily-seed-serve')
    throw new Error('Invalid deployment target configuration.');
  await deployStaticAssets(seed, previousSeed, apiToken, accountId, env.SEED_WORKER_NAME);
  await triggerBake(env, seed);
  return `Deployed seed: ${seed}; bake triggered`;
}

export default {
  // No public HTTP invocation can access deployment credentials or start work.
  fetch(): Response {
    return new Response('Not Found', { status: 404, headers: { 'Cache-Control': 'no-store' } });
  },

  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    await runUpdate(env);
  },
};
