import { describe, expect, it } from "vitest";
import { addBakedDZIsToOSD, BAKED_DZI_MIN_LEVEL } from "../src/telescope/baked-dzi-loader";

describe("baked DZI rendering", () => {
  it("suppresses aliased levels below the original generated resolution", () => {
    const source: Record<string, unknown> = {};
    const viewer = {
      addTiledImage(options: any) {
        options.success({ item: { source } });
      },
    };

    addBakedDZIsToOSD(viewer, [{
      pw: 0,
      dziUrl: "https://daily-middle.acidflow.stream/map.dzi",
      x: 0,
      y: 0,
      width: 33040,
      bust: "today",
    }]);

    expect(source.minLevel).toBe(BAKED_DZI_MIN_LEVEL);
  });
});
