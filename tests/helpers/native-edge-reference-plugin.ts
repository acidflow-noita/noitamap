import type { Plugin } from "vite";

/** Keep the complete CPU pipeline but select the pinned JS stamper as the
 * independent oracle. Missing anchors fail closed after a selector refactor. */
export function nativeEdgeReferencePlugin(): Plugin {
  const replace = (source: string, from: string, to: string) => {
    if (!source.includes(from))
      throw new Error(`Review edge reference anchor: ${from}`);
    return source.replace(from, to);
  };
  return {
    name: "native-edge-js-reference",
    enforce: "pre",
    transform(source, id) {
      if (id.endsWith("/cpu-terrain-core.ts?edge-reference"))
        source = replace(
          source,
          "./terrain-composition",
          "./terrain-composition?edge-reference",
        );
      if (id.endsWith("/terrain-composition.ts?edge-reference"))
        source = replace(
          source,
          "./terrain-edges",
          "./terrain-edges?edge-reference",
        );
      if (id.endsWith("/terrain-edges.ts?edge-reference")) {
        source = source.replace(
          /^import \{[^}]+\} from "\.\.\/native-map\/edges";\n/,
          "",
        );
        source = replace(source, "  warmNativeEdges();\n", "");
        source = replace(
          source,
          "  const nativeEdges = await readyNativeEdges();\n",
          "",
        );
        const start = source.indexOf("      const stamp =");
        const end = source.indexOf("      const decals =", start);
        if (start < 0 || end < 0)
          throw new Error("Review native edge selector");
        source =
          source.slice(0, start) +
          "      const stamp = stampEdgeDecals;\n" +
          source.slice(end);
      }
      return source;
    },
  };
}
