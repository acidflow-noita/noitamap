import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { shortToMap } from "../src/data_sources/param-mappings";

describe("experimental Discord navigation card", () => {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const script = html.match(/<script id="discord:component-embed" type="application\/json">([\s\S]*?)<\/script>/)!;
  it("ships strict JSON in the initial HTML while preserving Open Graph", () => {
    const card = JSON.parse(script[1]).component;
    expect(card.type).toBe(17);
    expect(card.components[0].content).toContain("spoilers");
    expect(html).toContain('property="og:image"');
  });
  it("uses real public routes, link buttons only, and no stale seed/report claims", () => {
    const buttons = JSON.parse(script[1]).component.components.find((c: any) => c.type === 1).components;
    expect(buttons).toHaveLength(3);
    expect(buttons.every((b: any) => b.type === 2 && b.style === 5 && !b.custom_id)).toBe(true);
    for (const button of buttons) {
      const url = new URL(button.url);
      expect(url.origin).toBe("https://map.runfast.stream");
      expect(shortToMap(url.searchParams.get("m")!)).toBeDefined();
      expect(url.searchParams.has("se")).toBe(false);
    }
    expect(new URL(buttons[0].url).searchParams.get("ds")).toBe("1");
  });
});
