#!/usr/bin/env node
import { writeFile, readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import {
  nativeEdgeAbi,
  nativeEdgeArtifact,
  nativeEdgeManifest,
  nativeEdgeHashes,
  verifyNativeEdgeBuild,
} from "./native-edge-identity.mjs";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
if (process.argv.includes("--check")) {
  await verifyNativeEdgeBuild(root);
  console.log(
    "Native edge WASM matches its source, runtime tables, reference and atlas.",
  );
} else {
  const sdk = process.env.WASI_SDK_PATH;
  if (!sdk)
    throw new Error(
      "Set WASI_SDK_PATH to an installed WASI SDK; the application does not download a compiler.",
    );
  const compiler = resolve(
    sdk,
    "bin",
    process.platform === "win32" ? "clang.exe" : "clang",
  );
  const flags = [
    "--target=wasm32-unknown-unknown",
    "-O3",
    "-ffp-contract=off",
    "-fno-fast-math",
    "-mbulk-memory",
    "-nostdlib",
    "-Wl,--no-entry",
    "-Wl,--export=abi_version",
    "-Wl,--export=buffer_ptr",
    "-Wl,--export=configure",
    "-Wl,--export=start",
    "-Wl,--export=scene",
    "-Wl,--export-memory",
    "-Wl,--initial-memory=16777216",
    "-Wl,--max-memory=16777216",
    "-Wl,-z,stack-size=131072",
  ];
  const result = spawnSync(
    compiler,
    [...flags, "src/native-map/edges/core.c", "-o", nativeEdgeArtifact],
    { cwd: root, encoding: "utf8" },
  );
  if (result.error || result.status !== 0)
    throw new Error(
      `Native edge compilation failed: ${result.error ?? result.stderr}`,
    );
  const version = spawnSync(compiler, ["--version"], { encoding: "utf8" });
  if (version.error || version.status !== 0)
    throw new Error(
      `Cannot read native compiler version: ${version.error ?? version.stderr}`,
    );
  const module = await WebAssembly.compile(
    await readFile(resolve(root, nativeEdgeArtifact)),
  );
  if (WebAssembly.Module.imports(module).length)
    throw new Error("Native edge module must not import runtime functions");
  const { exports } = await WebAssembly.instantiate(module);
  if (
    exports.abi_version() !== nativeEdgeAbi ||
    exports.memory.buffer.byteLength !== 16777216
  )
    throw new Error("Native edge ABI/memory mismatch");
  await writeFile(
    resolve(root, nativeEdgeManifest),
    JSON.stringify(
      {
        abi: nativeEdgeAbi,
        compiler: version.stdout
          .trim()
          .split(/\r?\n/)
          .filter((line) => !/^(InstalledDir:|Configuration file:)/.test(line))
          .join("\n"),
        flags,
        attribution:
          "Copyright (c) 2026 Lymm; MIT, see LICENSE-telescope.txt and NOTICE.txt",
        scope:
          "Source parity with pinned Telescope edge_decals.js; original game decoration RNG/grass fidelity is not established by this port.",
        sha256: await nativeEdgeHashes(root),
      },
      null,
      2,
    ) + "\n",
  );
  await verifyNativeEdgeBuild(root);
  console.log("Built and verified native edge WASM.");
}
