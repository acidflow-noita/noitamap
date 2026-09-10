import { readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { Plugin } from "vite";

const ATLAS = "\0noitamap-sprite-atlas";
const PART = "\0noitamap-sprite-atlas-part-";
const PUBLIC_PART = "virtual:noitamap-sprite-atlas-part-";

/** Keep every field (including animation metadata) without one giant JS
 * module. These remain dynamic script imports: no new CSP connect-src fetch. */
export function partitionAtlas(
  atlas: Record<string, unknown>,
  budget = 180_000,
) {
  const parts: Record<string, unknown>[] = [];
  let current: Record<string, unknown> = {},
    bytes = 2,
    entries = 0;
  for (const [key, value] of Object.entries(atlas).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  )) {
    const entryBytes = Buffer.byteLength(JSON.stringify({ [key]: value }));
    if (bytes + entryBytes > budget && entries) {
      parts.push(current);
      current = {};
      bytes = 2;
      entries = 0;
    }
    current[key] = value;
    bytes += entryBytes;
    entries++;
  }
  if (Object.keys(current).length) parts.push(current);
  return parts;
}

export function atlasChunksPlugin(root: string): Plugin {
  const path = resolve(root, "src/data/atlas.json");
  let stamp = "",
    parts: Record<string, unknown>[] = [];
  const readParts = () => {
    const stat = statSync(path),
      next = `${stat.mtimeMs}/${stat.size}`;
    if (next !== stamp) {
      parts = partitionAtlas(JSON.parse(readFileSync(path, "utf8")));
      stamp = next;
    }
    return parts;
  };
  return {
    name: "lazy-sprite-atlas-chunks",
    enforce: "pre",
    resolveId(id, importer) {
      if (id.startsWith(PUBLIC_PART))
        return PART + id.slice(PUBLIC_PART.length);
      if (
        id === path ||
        (importer &&
          id.startsWith(".") &&
          resolve(dirname(importer), id) === path)
      )
        return ATLAS;
    },
    load(id) {
      if (id !== ATLAS && !id.startsWith(PART)) return null;
      this.addWatchFile(path);
      const chunks = readParts();
      if (id === ATLAS) {
        return `const parts = await Promise.all([${chunks.map((_, i) => `import(${JSON.stringify(PUBLIC_PART + i)})`).join(",")}]);\nexport default Object.assign({}, ...parts.map(part => part.default));`;
      }
      const index = Number(id.slice(PART.length));
      if (!Number.isInteger(index) || !chunks[index])
        throw new Error(`Unknown sprite atlas part: ${id}`);
      return `export default JSON.parse(${JSON.stringify(JSON.stringify(chunks[index]))});`;
    },
  };
}
