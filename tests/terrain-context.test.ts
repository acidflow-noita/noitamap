import { afterEach, describe, expect, it, vi } from "vitest";
import { createTerrainRenderer } from "../src/telescope/terrain-context";

class Base {
  gl: any = null;
  failed: string | null = null;
  canvas: any = null;
  contextLost = false;
  textures: any = {};
  program: any = {};
  sourceKey: any = "old";
}
afterEach(() => vi.unstubAllGlobals());
function setup(accept: (preference: string) => boolean) {
  const canvas = new EventTarget() as any;
  const gl = { disable: vi.fn(), BLEND: 1, DEPTH_TEST: 2 };
  canvas.getContext = vi.fn((_type: string, attrs: WebGLContextAttributes) => {
    if (accept(attrs.powerPreference!)) return gl;
    const event = new Event("webglcontextcreationerror");
    Object.defineProperty(event, "statusMessage", {
      value: `denied ${attrs.powerPreference}`,
    });
    canvas.dispatchEvent(event);
    return null;
  });
  vi.stubGlobal("document", { createElement: () => canvas });
  const report = vi.fn();
  return { renderer: createTerrainRenderer(Base, report), canvas, gl, report };
}
describe("terrain WebGL2 context selection", () => {
  it("retries the normal GPU when the high-performance preference is refused", () => {
    const { renderer, canvas, gl } = setup(
      (preference) => preference === "default",
    );
    expect(renderer.initContext()).toBe(true);
    expect(
      canvas.getContext.mock.calls.map((c: any[]) => c[1].powerPreference),
    ).toEqual(["high-performance", "default"]);
    expect(renderer.gl).toBe(gl);
    expect(renderer.failed).toBeNull();
    expect(gl.disable).toHaveBeenCalledTimes(2);
  });
  it("does not replace a working context", () => {
    const { renderer, canvas } = setup(() => true);
    expect(renderer.initContext()).toBe(true);
    expect(renderer.initContext()).toBe(true);
    expect(canvas.getContext).toHaveBeenCalledTimes(1);
  });
  it("retains the browser context-creation error instead of a generic label", () => {
    const { renderer, report } = setup(() => false);
    expect(renderer.initContext()).toBe(false);
    expect(renderer.failed).toContain("denied high-performance");
    expect(renderer.failed).toContain("denied default");
    expect(report).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "context-creation-error",
        message: "denied default",
      }),
    );
  });
});
