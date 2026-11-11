#!/usr/bin/env node
/** Entirely local preview: actual Worker/D1 runtime and auth handler, with
 * clearly synthetic identities and public practice questions. Never deploys. */
import { createServer as httpServer } from "node:http";
import { readFile, mkdir, writeFile, mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve, join, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { randomBytes, randomUUID, createHmac, createHash, generateKeyPairSync, hkdfSync } from "node:crypto";
import { build } from "esbuild";
import { createServer as viteServer } from "vite";
import { privateOutput } from "./private-output.mjs";

export async function startPreview({
  port = 5177,
  pro = false,
  quiet = false,
  questionsFile,
} = {}) {
  const require = createRequire(
    resolve("workers/noitamap-guessr/package.json"),
  );
  const entry =
    process.env.GUESSR_MINIFLARE_PATH || require.resolve("miniflare");
  const { Miniflare, convertV4MiniflareOptions } = await import(
    pathToFileURL(entry).href
  );
  const previewRoot = resolve("task/guessr/local-preview");
  await mkdir(previewRoot, { recursive: true });
  const root = await mkdtemp(join(previewRoot, "session-"));
  const gameKey = randomBytes(32).toString("hex"),
    loginKey = randomBytes(32).toString("hex");
  const ticketPair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const ticketPrivate = JSON.stringify(ticketPair.privateKey.export({ format: 'jwk' }));
  const ticketPublic = JSON.stringify(ticketPair.publicKey.export({ format: 'jwk' }));
  const compiled = await build({
    entryPoints: ["workers/noitamap-guessr/src/index.ts"],
    bundle: true,
    write: false,
    format: "esm",
    platform: "neutral",
    target: "es2022",
  });
  const compiledAuth = await build({
    entryPoints: ["workers/noitamap-auth/src/index.ts"],
    bundle: true,
    write: false,
    format: "esm",
    platform: "neutral",
    target: "es2022",
  });
  const authFile = join(root, "auth.mjs");
  await writeFile(authFile, compiledAuth.outputFiles[0].text);
  const { default: authWorker } = await import(
    pathToFileURL(authFile).href + "?" + Date.now()
  );
  const pack = JSON.parse(await readFile("task/guessr/site/pack.json", "utf8"));
  const assets = join(root, "assets");
  await mkdir(assets, { recursive: true });
  let bounds = pack.bounds,
    roundSeconds = 90;
  let inputs = pack.places.slice(0, 10).map((p) => ({
    ...p,
    seed: pack.seed,
    image: resolve("task/guessr/site", p.image),
  }));
  if (questionsFile) {
    const input = privateOutput(questionsFile),
      data = JSON.parse(await readFile(input, "utf8")),
      day = data.days?.[0];
    if (data.visibility !== "private" || day?.questions?.length !== 10)
      throw Error("Use a private ten-round draft pack for this preview.");
    inputs = day.questions.map((q) => ({
      ...q,
      image: resolve(dirname(input), q.image),
    }));
    bounds = day.bounds;
    roundSeconds = day.roundSeconds ?? 90;
  }
  const questions = [];
  for (const p of inputs) {
    const bytes = await readFile(p.image),
      key = createHash("sha256").update(bytes).digest("hex") + ".webp";
    await writeFile(join(assets, key), bytes);
    questions.push({ ...p, key });
  }
  let origin = `http://127.0.0.1:${port}`;
  const options = {
    name: "noitamap-guessr-preview",
    modules: true,
    script: compiled.outputFiles[0].text,
    compatibilityDate: "2026-10-08",
    d1Databases: ["DB", "ACCOUNT_DB"],
    bindings: {
      GAME_SIGNING_SECRET: gameKey,
      GAME_TICKET_PUBLIC_KEY: ticketPublic,
      GAME_ENABLED: "true",
      ALLOWED_ORIGINS: origin,
      DAILY_REQUEST_BUDGET: "10000",
    },
    assets: {
      directory: assets,
      binding: "ASSETS",
      run_worker_first: true,
      routerConfig: { has_user_worker: true },
    },
    host: "127.0.0.1",
    port: 0,
  };
  const mf = new Miniflare(
    convertV4MiniflareOptions ? convertV4MiniflareOptions(options) : options,
  );
  let auth, vite;
  const close = async () => {
    await vite?.close();
    if (auth) {
      auth.closeAllConnections();
      await new Promise((done) => auth.close(done));
    }
    await mf.dispose();
    await rm(root, { recursive: true, force: true });
  };
  try {
    const apiOrigin = (await mf.ready).origin,
      db = await mf.getD1Database("DB");
    const schema = await readFile(
      "workers/noitamap-guessr/migrations/0001_game.sql",
      "utf8",
    );
    // D1.exec treats newlines as statement boundaries. Preserve our multiline
    // trigger bodies and send each complete DDL statement through prepare().
    const ddl = schema
      .replace(/^\s*--.*$/gm, "")
      .trim()
      .split(/;\s*(?=(?:CREATE|PRAGMA)\b|$)/)
      .filter((s) => s.trim());
    for (const statement of ddl) await db.prepare(statement).run();
    const imageSchema = await readFile("workers/noitamap-guessr/migrations/0003_daily_image_sets.sql", "utf8");
    for (const statement of imageSchema.replace(/^\s*--.*$/gm, "").split(";").filter(s => s.trim())) await db.prepare(statement).run();
    const roundsSchema = await readFile("workers/noitamap-guessr/migrations/0004_ten_rounds.sql", "utf8");
    const roundsDdl = roundsSchema.replace(/^\s*--.*$/gm, "").trim()
      .split(/;\s*(?=(?:CREATE|PRAGMA|INSERT|DROP|ALTER)\b|$)/).filter(s => s.trim());
    await db.batch(roundsDdl.map(statement => db.prepare(statement)));
    const now = Date.now(),
      day = new Date(now).toISOString().slice(0, 10),
      start = Date.parse(day + "T00:00:00Z");
    for (const [id, date, opens, closes] of [
      ["local-today", day, start, start + 86400000],
      [
        "local-yesterday",
        new Date(start - 86400000).toISOString().slice(0, 10),
        start - 86400000,
        start,
      ],
    ]) {
      await db
        .prepare("INSERT INTO challenges(id,day,title,opens_at,closes_at,reveal_at,bounds_json,round_seconds,enabled) VALUES(?,?,?,?,?,?,?,?,?)")
        .bind(
          id,
          date,
          "Local preview daily",
          opens,
          closes,
          closes,
          JSON.stringify(bounds),
          roundSeconds,
          1,
        )
        .run();
      for (const [i, q] of questions.entries())
        await db
          .prepare("INSERT INTO questions(challenge_id,ordinal,asset_key,name,biome,x,y,seed) VALUES(?,?,?,?,?,?,?,?)")
          .bind(id, i, q.key, q.name, q.biome, q.x, q.y, q.seed)
          .run();
    }
    for (const [id, name, offset] of [
      ["demo-one", "Coal Cartographer", 0],
      ["demo-two", "Fungal Forager", 100],
      ["preview", "Local explorer", 250],
    ]) {
      const attempt = "sample-" + id,
        at = start - 300000;
      await db
        .prepare(
          "INSERT INTO attempts(id,user_id,challenge_id,display_name,started_at,round_started_at) VALUES(?,?,?,?,?,?)",
        )
        .bind(attempt, "twitch:" + id, "local-yesterday", name, at, at)
        .run();
      for (const [i, q] of questions.entries())
        await db
          .prepare("INSERT INTO guesses(attempt_id,ordinal,request_id,request_hash,x,y,score,distance,elapsed_ms,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)")
          .bind(
            attempt,
            i,
            `sample-round-${i}`,
            JSON.stringify([i, q.x, q.y]),
            q.x + offset,
            q.y,
            offset === 0 ? 5000 : 4500,
            offset,
            1000,
            at + (i + 1) * 1000,
          )
          .run();
    }
    const accountDb = await mf.getD1Database('ACCOUNT_DB'), accountId = randomUUID(), sessionId = randomUUID();
    for (const migration of ['0001_linked_accounts.sql', '0002_sessions.sql']) {
      const sql = await readFile('workers/noitamap-auth/migrations/' + migration, 'utf8');
      const statements = sql.replace(/^\s*--.*$/gm, '').trim().split(/;\s*(?=(?:CREATE|ALTER|DROP|PRAGMA)\b|$)/).filter(s => s.trim());
      for (const statement of statements) await accountDb.prepare(statement).run();
    }
    await accountDb.prepare('INSERT INTO auth_accounts(id) VALUES(?)').bind(accountId).run();
    await accountDb.prepare("INSERT INTO auth_identities(provider,provider_user_id,account_id,username,nickname,login,is_follower,is_subscriber,checked_at,status,credentials) VALUES('twitch','123',?,'Local explorer',NULL,'local_explorer',1,1,?,'active','')").bind(accountId,now).run();
    await accountDb.prepare('INSERT INTO auth_sessions(id,account_id,account_version,created_at,refreshed_at,expires_at) VALUES(?,?,1,?,?,?)').bind(sessionId,accountId,now,now,now+86400000).run();
    const seconds = Math.floor(now / 1000),
      payload = {
        typ: "access", v: 2, aud: "noitamap-auth", sid: sessionId, account_id: accountId, account_version: 1,
        sub: "preview",
        username: "Local explorer",
        nickname: null,
        is_follower: true,
        is_subscriber: true,
        provider: "twitch",
        iat: seconds,
        exp: seconds + 86400,
      };
    const tokenInput =
      Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT", kid: "auth-v2" })).toString(
        "base64url",
      ) +
      "." +
      Buffer.from(JSON.stringify(payload)).toString("base64url");
    const loginToken =
      tokenInput +
      "." +
      createHmac("sha256", hkdfSync("sha256", loginKey, "noitamap-auth-v2", "access", 32)).update(tokenInput).digest("base64url");
    auth = httpServer(async (req, res) => {
      try {
        const buffers = [];
        for await (const chunk of req) buffers.push(chunk);
        const request = new Request("http://localhost" + req.url, {
          method: req.method,
          headers: req.headers,
          ...(["GET", "HEAD"].includes(req.method)
            ? {}
            : { body: Buffer.concat(buffers) }),
        });
        const response = await authWorker.fetch(request, {
          SESSION_SIGNING_SECRET: loginKey,
          CREDENTIAL_ENCRYPTION_SECRET: gameKey,
          ACCOUNT_DB: accountDb,
          GAME_TICKET_PRIVATE_KEY: ticketPrivate,
          ALLOWED_ORIGINS: origin,
          WORKER_URL: "http://localhost",
        });
        res.writeHead(response.status, Object.fromEntries(response.headers));
        res.end(Buffer.from(await response.arrayBuffer()));
      } catch {
        res.writeHead(500);
        res.end("Local auth error");
      }
    });
    await new Promise((done) => auth.listen(0, "127.0.0.1", done));
    const authOrigin = `http://127.0.0.1:${auth.address().port}`;
    vite = await viteServer({
      root: process.cwd(),
      logLevel: quiet ? "silent" : "info",
      define: {
        "import.meta.env.VITE_GUESSR_API_URL": JSON.stringify(apiOrigin),
      },
      server: { host: "127.0.0.1", port, strictPort: true },
      plugins: [
        {
          name: "local-guessr-fixture",
          transformIndexHtml(html, ctx) {
            if (!ctx.path.startsWith("/guess")) return html;
            // Only this localhost origin receives synthetic credentials. No production
            // auth tokens are used, exported, or written to another site's storage.
            const script = `localStorage.setItem('noitamap_auth_worker',${JSON.stringify(authOrigin)});${pro ? `localStorage.setItem('noitamap_jwt',${JSON.stringify(loginToken)});` : ""}`;
            return html
              .replace("</head>", `<script>${script}</script></head>`)
              .replace(
                "<body>",
                '<body><aside style="padding:8px;text-align:center;background:var(--surface-1,#0f172a);color:var(--text-muted,#94a3b8);font:13px system-ui">Local preview , Sample account , Nothing is published</aside>',
              );
          },
        },
      ],
    });
    await vite.listen();
    if (!quiet)
      console.log(
        `Local NoitaGuessr preview: ${origin}/guess/ (${pro ? "synthetic Pro identity" : "guest view"}). No cloud resources were changed.`,
      );
    return {
      origin,
      apiOrigin,
      authOrigin,
      db,
      mf,
      questions,
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === new URL(import.meta.url).pathname
) {
  const preview = await startPreview({
    port: Number(process.env.PORT || 5177),
    pro: process.argv.includes("--pro"),
    questionsFile: process.argv
      .find((arg) => arg.startsWith("--questions="))
      ?.slice("--questions=".length),
  });
  for (const signal of ["SIGINT", "SIGTERM"])
    process.on(signal, async () => {
      await preview.close();
      process.exit();
    });
}
