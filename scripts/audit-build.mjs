#!/usr/bin/env node
/** Inspect a production build without a browser or network requests.
 * Compression sizes are per-file local estimates, not measured transfer sizes.
 */
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { resolve, relative, extname } from "node:path";
import { brotliCompressSync, gzipSync } from "node:zlib";
import ts from "typescript";

const args = process.argv.slice(2);
const root = resolve(args.find((arg) => !arg.startsWith("--")) || "dist");
const option = (name) => args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const maxInitialGzip = option("max-initial-gzip");
if (maxInitialGzip !== undefined && !/^\d+$/.test(maxInitialGzip))
  throw new Error("--max-initial-gzip must be a nonnegative byte count");

const files = [];
async function list(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) await list(path);
    else if (entry.isFile()) files.push(relative(root, path).replaceAll("\\", "/"));
  }
}
await list(root);
files.sort();
const rawSizes = new Map(await Promise.all(files.map(async (file) => [file, (await stat(resolve(root, file))).size])));
const measurements = new Map();
async function measure(file) {
  if (!measurements.has(file)) {
    const bytes = await readFile(resolve(root, file));
    measurements.set(file, {
      file,
      raw: bytes.length,
      gzip: gzipSync(bytes).length,
      brotli: brotliCompressSync(bytes).length,
    });
  }
  return measurements.get(file);
}
function sum(rows) {
  return rows.reduce((total, row) => ({
    count: total.count + 1,
    raw: total.raw + row.raw,
    gzip: total.gzip + row.gzip,
    brotli: total.brotli + row.brotli,
  }), { count: 0, raw: 0, gzip: 0, brotli: 0 });
}
function rawSummary(names) {
  return { count: names.length, raw: names.reduce((total, file) => total + rawSizes.get(file), 0) };
}

const origin = "https://build.invalid/";
function localFile(url, importer = "index.html") {
  const resolved = new URL(url, new URL(importer, origin));
  if (resolved.origin !== new URL(origin).origin) return null;
  const file = decodeURIComponent(resolved.pathname.slice(1));
  if (!rawSizes.has(file)) throw new Error(`Missing build dependency: ${url} (from ${importer})`);
  return file;
}
function attributes(tag) {
  return Object.fromEntries([...tag.matchAll(/([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)].map((match) => [match[1], match[2] ?? match[3]]));
}
const html = await readFile(resolve(root, "index.html"), "utf8");
const entries = [];
const stylesheets = [];
const classicScripts = [];
const external = [];
for (const match of html.matchAll(/<(script|link)\b[^>]*>/g)) {
  const attrs = attributes(match[0]);
  const url = match[1] === "script" ? attrs.src : attrs.rel === "stylesheet" ? attrs.href : null;
  if (!url) continue;
  const file = localFile(url);
  if (!file) external.push({ type: match[1] === "script" ? "script" : "stylesheet", url });
  else if (match[1] === "link") stylesheets.push(file);
  else if (attrs.type === "module") entries.push(file);
  else classicScripts.push(file);
}
if (!entries.length) throw new Error("No local module entry found in index.html");

const initial = new Set();
async function visit(file) {
  if (initial.has(file)) return;
  initial.add(file);
  const code = await readFile(resolve(root, file), "utf8");
  const module = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, false, ts.ScriptKind.JS);
  for (const statement of module.statements) {
    // Dynamic imports and import.meta are deliberately outside the static graph.
    if (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) continue;
    const specifier = statement.moduleSpecifier;
    if (!specifier || !ts.isStringLiteral(specifier)) continue;
    const imported = localFile(specifier.text, file);
    if (imported) await visit(imported);
    else external.push({ type: "module", url: specifier.text });
  }
}
for (const entry of entries) await visit(entry);
const initialFiles = await Promise.all([...initial].sort().map(measure));
initialFiles.sort((a, b) => b.raw - a.raw || a.file.localeCompare(b.file));
const nonInitialFiles = files.filter((file) => /\.[cm]?js$/.test(file) && !initial.has(file) && !classicScripts.includes(file));
const categories = {};
for (const file of files) {
  const extension = extname(file) || "(none)";
  (categories[extension] ??= []).push(file);
}
const report = {
  description: "Static module graph and local per-file compression estimates; excludes runtime fetches, dynamically executed imports, external CDN bytes and network timings.",
  compression: { gzipLevel: 6, brotliQuality: 11 },
  entries,
  initialJavaScript: { ...sum(initialFiles), files: initialFiles },
  nonInitialJavaScript: rawSummary(nonInitialFiles),
  html: await measure("index.html"),
  linkedStylesheets: await Promise.all(stylesheets.map(measure)),
  classicScripts: await Promise.all(classicScripts.map(measure)),
  external,
  totalBuild: rawSummary(files),
  sourceMaps: rawSummary(files.filter((file) => file.endsWith(".map"))),
  byExtension: Object.fromEntries(Object.entries(categories).map(([extension, names]) => [extension, rawSummary(names)])),
  largestFiles: files.map((file) => ({ file, raw: rawSizes.get(file) })).sort((a, b) => b.raw - a.raw).slice(0, 20),
};
const destination = option("json");
if (destination) await writeFile(resolve(destination), JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(destination ? {
  report: destination,
  initialJavaScript: sum(initialFiles),
  nonInitialJavaScript: report.nonInitialJavaScript,
  totalBuild: report.totalBuild,
  sourceMaps: report.sourceMaps,
} : report, null, 2));
if (maxInitialGzip !== undefined && report.initialJavaScript.gzip > Number(maxInitialGzip)) {
  console.error(`Initial JavaScript gzip estimate ${report.initialJavaScript.gzip} exceeds budget ${maxInitialGzip}`);
  process.exitCode = 1;
}
