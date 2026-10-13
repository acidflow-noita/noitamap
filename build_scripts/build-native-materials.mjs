#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import {
  nativeMaterialAbi,
  nativeMaterialArtifact,
  nativeMaterialManifest,
  nativeMaterialHashes,
  verifyNativeMaterialBuild,
} from "./native-material-identity.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
if (process.argv.includes("--check")) {
  await verifyNativeMaterialBuild(root);
  console.log("Native material WASM matches its source inputs.");
} else {
  const sdk = process.env.WASI_SDK_PATH;
  if (!sdk)
    throw new Error(
      "Set WASI_SDK_PATH to an installed WASI SDK; the application does not download a compiler.",
    );
  await import("./generate-native-material-tables.mjs");
  const compiler = resolve(
    sdk,
    "bin",
    process.platform === "win32" ? "clang.exe" : "clang",
  );
  const flags = [
    "--target=wasm32-unknown-unknown",
    "-DINCLUDE_BANDS",
    "-DINCLUDE_OWNERSHIP",
    "-DINCLUDE_VERTICAL",
    "-O3",
    "-ffp-contract=off",
    "-fno-fast-math",
    "-nostdlib",
    "-Wl,--no-entry",
    "-Wl,--export-memory",
    "-Wl,--initial-memory=262144",
    "-Wl,--max-memory=134217728",
    "-Wl,-z,stack-size=65536",
  ];
  const result = spawnSync(
    compiler,
    [
      ...flags,
      "src/native-map/materials/topo2.c",
      "-o",
      nativeMaterialArtifact,
    ],
    { cwd: root, encoding: "utf8" },
  );
  if (result.error || result.status !== 0)
    throw new Error(
      `Native material compilation failed: ${result.error ?? result.stderr}`,
    );
  const version = spawnSync(compiler, ["--version"], { encoding: "utf8" });
  if (version.error || version.status !== 0)
    throw new Error(
      `Cannot read native compiler version: ${version.error ?? version.stderr}`,
    );
  await writeFile(
    resolve(root, nativeMaterialManifest),
    JSON.stringify(
      {
        abi: nativeMaterialAbi,
        compiler: version.stdout
          .trim()
          .split(/\r?\n/)
          .filter((line) => !/^(InstalledDir:|Configuration file:)/.test(line))
          .join("\n"),
        flags,
        attribution:
          "Copyright (c) 2026 Lymm; MIT, see LICENSE-telescope.txt and NOTICE.txt",
        sha256: await nativeMaterialHashes(root),
      },
      null,
      2,
    ) + "\n",
  );
  await verifyNativeMaterialBuild(root);
  console.log("Built and verified native material WASM.");
}
