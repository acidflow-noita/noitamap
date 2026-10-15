#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const directory = fileURLToPath(new URL("./", import.meta.url));
const root = resolve(directory, "../../..");
const files = [
  "topo2.c", "topo0.c", "vertical.c", "bands.c", "ownership.c", "complete.c",
  "constants.h", "topo0-data.h", "bands-data.h", "classifications.h",
  "index.ts", "seed-modifiers.mjs", "engine-data.mjs", "NOTICE.txt", "LICENSE-telescope.txt", "build.mjs",
  "../game-state/index.ts", "../game-state/README.txt",
];
const referenceFiles = [
  "task/native-wasm-topo0/topo0.c", "task/native-wasm-topo0/topo0-data.h",
  "lib/noita-telescope-vm/js/engine_resolve/bitmap_caves.js",
  "lib/noita-telescope-vm/js/engine_resolve/topo0_resolve.js",
  "lib/noita-telescope-vm/js/engine_resolve/topo2_resolve.js",
  "lib/noita-telescope-vm/js/engine_resolve/chunk_wobble.js",
  "lib/noita-telescope-vm/js/engine_resolve/band_select.js",
  "lib/noita-telescope-vm/js/engine_resolve/engine_data.js",
  "src/telescope/plane-material-field.ts",
];
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
async function hashes() {
  return Object.fromEntries(await Promise.all(files.concat("complete-materials.wasm").map(async name => [name, digest(await readFile(resolve(directory, name)))])));
}
export async function verifyCompleteMaterialBuild() {
  const manifest = JSON.parse(await readFile(resolve(directory, "build-identity.json"), "utf8"));
  if (manifest.abi !== 3) throw new Error("Wrong complete material ABI");
  const actual = await hashes();
  for (const [name, hash] of Object.entries(actual))
    if (manifest.sha256[name] !== hash) throw new Error(`Complete material build is stale: ${name}`);
  const module = await WebAssembly.compile(await readFile(resolve(directory, "complete-materials.wasm")));
  if (WebAssembly.Module.imports(module).length) throw new Error("Complete material WASM must have no runtime imports");
  const { exports } = await WebAssembly.instantiate(module);
  if (exports.abi_version() !== 3) throw new Error("Compiled complete material ABI mismatch");
}

if (process.argv.includes("--check")) {
  await verifyCompleteMaterialBuild();
  console.log("Complete material source and artifact identity verified.");
} else if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const sdk = process.env.WASI_SDK_PATH;
  if (!sdk) throw new Error("Set WASI_SDK_PATH to the installed WASI SDK");
  const compiler = resolve(sdk, "bin", process.platform === "win32" ? "clang.exe" : "clang");
  const flags = [
    "--target=wasm32-unknown-unknown", "-DINCLUDE_BANDS", "-DINCLUDE_OWNERSHIP", "-DINCLUDE_VERTICAL",
    "-O3", "-ffp-contract=off", "-fno-fast-math", "-nostdlib",
    "-Wl,--no-entry", "-Wl,--export-memory", "-Wl,--initial-memory=524288",
    "-Wl,--max-memory=134217728", "-Wl,-z,stack-size=65536",
  ];
  const result = spawnSync(compiler, [...flags, "topo2.c", "-o", "complete-materials.wasm"], { cwd: directory, encoding: "utf8" });
  if (result.error || result.status) throw new Error(`Complete material build failed: ${result.error ?? result.stderr}`);
  const version = spawnSync(compiler, ["--version"], { encoding: "utf8" });
  if (version.error || version.status) throw new Error(`Compiler identity failed: ${version.error ?? version.stderr}`);
  const reference = Object.fromEntries(await Promise.all(referenceFiles.map(async path => [path, digest(await readFile(resolve(root, path)))])));
  await writeFile(resolve(directory, "build-identity.json"), JSON.stringify({
    abi: 3,
    compiler: version.stdout.trim().split(/\r?\n/).filter(line => !/^(InstalledDir:|Configuration file:)/.test(line)).join("\n"),
    flags,
    referenceCommit: "9c587750c361e88583fe8df406d74136bbcc1dde",
    scope: "Owned source-parity scalar material field: topology0, topology2, bands, host policy, vertical planes and local shafts. Unresolved raw/legacy/unowned/config/input cases are explicit.",
    accuracyLimits: [
      "Default winter/_EMPTY_ preparation omits runtime-RNG phase F. Validated named-grid imports replace it at a captured instant; missing imported runtime grids stay unresolved. No historical chunk or full-run-state claim.",
      "Preserves pinned source seed-halving thresholds and insideNoiseType=5 overrides.",
      "Finite carve tables and unsupported configurations remain classified unresolved.",
      "Host Math.sin/cos bytes preserve the current JS reference; no independent game or cross-engine equivalence claim.",
      "Vertical material helper supports topology2 only, exactly as the existing source helper.",
      "Material IDs are not completed art, scenes, decals, mips, or an instant full-map result.",
    ],
    referenceSha256: reference,
    sha256: await hashes(),
  }, null, 2) + "\n");
  await verifyCompleteMaterialBuild();
  console.log("Built and verified complete material ABI 3.");
}
