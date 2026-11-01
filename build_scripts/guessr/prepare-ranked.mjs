#!/usr/bin/env node
/** Offline-only private question publisher. Produces assets and SQL; never
 * connects to Cloudflare. Do not put its real input/output in public Git/CI. */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, dirname, join } from "node:path";
import { createHash } from "node:crypto";
import sharp from "sharp";
import { privateOutput } from "./private-output.mjs";

export async function prepareRanked(
  inputPath,
  outPath,
  { allowPublicFixture = false } = {},
) {
  const input = JSON.parse(await readFile(inputPath, "utf8"));
  const overview = JSON.parse(
    await readFile(
      new URL("../../public/guessr/practice/pack.json", import.meta.url),
      "utf8",
    ),
  );
  if (
    input.version !== 1 ||
    !Array.isArray(input.days) ||
    !input.days.length ||
    input.days.length > 31
  )
    throw Error("A pack must contain 1–31 days.");
  if (
    input.visibility !== "private" &&
    !(allowPublicFixture && input.visibility === "public-fixture")
  )
    throw Error(
      "Ranked questions must come from a private pack. Public fixtures are for local tests only.",
    );
  const out = privateOutput(outPath),
    assets = join(out, "assets");
  await mkdir(assets, { recursive: true });
  const quote = (v) => "'" + String(v).replaceAll("'", "''") + "'";
  const sql = [
    "-- PRIVATE QUESTION DATA. Do not commit or upload this SQL to public artifacts.",
  ];
  const summary = [];
  for (const day of input.days) {
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(day.day) ||
      new Date(day.day + "T00:00:00Z").toISOString().slice(0, 10) !== day.day
    )
      throw Error("Invalid challenge day.");
    const id = day.id || "daily-" + day.day,
      opens = Date.parse(day.day + "T00:00:00Z"),
      closes = opens + 86400000;
    if (
      !/^[\w-]{1,100}$/.test(id) ||
      typeof day.title !== "string" ||
      day.title.length > 100
    )
      throw Error("Invalid challenge identity.");
    const b = day.bounds;
    if (
      !b ||
      !["x", "y", "width", "height"].every((k) => Number.isFinite(b[k])) ||
      b.width <= 0 ||
      b.height <= 0
    )
      throw Error("Invalid map bounds.");
    if (
      !["x", "y", "width", "height"].every(
        (key) => b[key] === overview.bounds[key],
      )
    )
      throw Error(
        "This draft uses the regular main-world overview; ranked bounds must match the practice pack.",
      );
    if (!Array.isArray(day.questions) || day.questions.length !== 10)
      throw Error("Exactly ten questions are required per daily.");
    const seconds = day.roundSeconds ?? 90;
    if (!Number.isInteger(seconds) || seconds < 15 || seconds > 600)
      throw Error("Round time must be 15–600 seconds.");
    // Public demo inputs deliberately stay disabled, even if uploaded by mistake.
    const enabled =
      input.visibility === "private" && day.enabled === true ? 1 : 0;
    sql.push(
      `INSERT INTO challenges(id,day,title,opens_at,closes_at,reveal_at,bounds_json,round_seconds,enabled) VALUES(${quote(id)},${quote(day.day)},${quote(day.title)},${opens},${closes},${closes},${quote(JSON.stringify(b))},${seconds},${enabled});`,
    );
    const names = new Set();
    for (const [ordinal, q] of day.questions.entries()) {
      if (
        !Number.isFinite(q.x) ||
        !Number.isFinite(q.y) ||
        q.x < b.x ||
        q.x > b.x + b.width ||
        q.y < b.y ||
        q.y > b.y + b.height ||
        !Number.isInteger(q.seed) ||
        q.seed < 0 ||
        q.seed > 2147483647
      )
        throw Error("Question coordinates/seed are invalid.");
      if (
        typeof q.image !== "string" ||
        typeof q.name !== "string" ||
        q.name.length > 100 ||
        typeof q.biome !== "string" ||
        q.biome.length > 60
      )
        throw Error("Invalid question metadata.");
      const source = resolve(dirname(inputPath), q.image);
      const meta = await sharp(source).metadata();
      if (
        !meta.width ||
        !meta.height ||
        meta.width > 4096 ||
        meta.height > 4096 ||
        meta.width < 256 ||
        meta.height < 256
      )
        throw Error("Use clue images between 256 and 4096 pixels.");
      // Decode/re-encode strips metadata, including any Magic Screenshot payload.
      const bytes = await sharp(source).webp({ lossless: true }).toBuffer();
      const asset = createHash("sha256").update(bytes).digest("hex") + ".webp";
      if (names.has(asset))
        throw Error("Duplicate question image in one daily.");
      names.add(asset);
      await writeFile(join(assets, asset), bytes);
      sql.push(
        `INSERT INTO questions(challenge_id,ordinal,asset_key,name,biome,x,y,seed) VALUES(${quote(id)},${ordinal},${quote(asset)},${quote(q.name)},${quote(q.biome)},${q.x},${q.y},${q.seed});`,
      );
    }
    summary.push({ day: day.day, questions: day.questions.length, enabled: !!enabled });
  }
  await writeFile(join(out, "private-import.sql"), sql.join("\n") + "\n");
  await writeFile(
    join(out, "pack-summary.json"),
    JSON.stringify(
      { version: 1, visibility: input.visibility, days: summary },
      null,
      2,
    ) + "\n",
  );
  return summary;
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === new URL(import.meta.url).pathname
) {
  const args = Object.fromEntries(
    process.argv.slice(2).map((v) => v.replace(/^--/, "").split("=")),
  );
  if (!args.input || !args.out)
    throw Error(
      "Usage: node build_scripts/guessr/prepare-ranked.mjs --input=/private/questions.json --out=/private/prepared-pack",
    );
  const summary = await prepareRanked(resolve(args.input), resolve(args.out), {
    allowPublicFixture: args["allow-public-fixture"] === "true",
  });
  console.log(
    `Prepared ${summary.length} daily challenges locally. No remote changes. Real question files must stay private.`,
  );
}
