#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
const base = new URL("./", import.meta.url);
const paths = [
  "index.ts", "scene-policy.ts", "README.txt", "verify.mjs",
  "../complete-materials/build-identity.json", "../complete-materials/complete-materials.wasm",
  "../cook-inputs/provenance.json", "../composition/index.ts", "../composition/prepare-scenes.ts",
  "../composition/scene-source-loader.ts", "../composition/scene-source-definitions.ts",
  "../composition/world-resources.ts", "../composition/world-policy.ts",
  "../composition/liquid-inputs.ts", "../composition/strict-edges.ts", "../edges/core.wasm",
  "../../../tests/complete-world-runtime.test.ts", "../../../tests/helpers/complete-world-runtime-fixture.ts",
  "../../../tests/helpers/complete-world-runtime-worker.mjs",
];
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const hashes = Object.fromEntries(await Promise.all(paths.map(async path => [path, hash(await readFile(new URL(path, base)))])));
if (process.argv.includes("--record")) await writeFile(new URL("provenance.json", base), JSON.stringify({
  format: "owned-world-pages-v1", scope: "terrain-scenes-layer",
  exactReference: "Pinned source CPU terrain + JS edge oracle; captured static base excluded",
  hostPolicySource: "src/telescope/telescope-osd-bridge.ts + captured-gold-room.ts",
  sha256: hashes,
}, null, 2) + "\n");
const saved = JSON.parse(await readFile(new URL("provenance.json", base), "utf8"));
for (const [path, value] of Object.entries(hashes)) if (saved.sha256[path] !== value) throw new Error(`Complete-world identity changed: ${path}`);
console.log("Complete-world implementation/dependency identity verified.");
