/** Own context setup instead of treating a refused GPU preference as a blanket
 * renderer failure. Never lock the canvas to 2D before requesting WebGL2. */
export function createTerrainRenderer(
  Base: any,
  report: (details: Record<string, unknown>) => void,
): any {
  return new (class extends Base {
    initContext(): boolean {
      if (this.gl || this.failed) return !!this.gl;
      const canvas = document.createElement("canvas");
      const failures: string[] = [];
      let preference = "high-performance";
      canvas.addEventListener("webglcontextcreationerror", ((
        event: WebGLContextEvent,
      ) => {
        const message =
          event.statusMessage || "WebGL2 context creation rejected";
        failures.push(message);
        report({ event: "context-creation-error", preference, message });
      }) as EventListener);
      const attributes: WebGLContextAttributes = {
        alpha: true,
        antialias: false,
        depth: false,
        stencil: false,
        premultipliedAlpha: true,
        preserveDrawingBuffer: false,
        failIfMajorPerformanceCaveat: false,
      };
      let gl: WebGL2RenderingContext | null = null;
      for (const powerPreference of ["high-performance", "default"] as const) {
        preference = powerPreference;
        try {
          gl = canvas.getContext("webgl2", { ...attributes, powerPreference });
        } catch (error) {
          failures.push(String(error));
        }
        if (gl) break;
      }
      if (!gl) {
        this.failed = failures.length
          ? failures.join(" | ")
          : "The browser refused a WebGL2 context (including the default GPU preference).";
        report({
          event: "context-unavailable",
          message: this.failed,
          webgl2API: typeof WebGL2RenderingContext !== "undefined",
        });
        return false;
      }
      canvas.addEventListener("webglcontextlost", (event) => {
        event.preventDefault();
        this.contextLost = true;
        this.textures = null;
        this.program = null;
      });
      canvas.addEventListener("webglcontextrestored", () => {
        this.contextLost = false;
        this.sourceKey = null;
      });
      this.canvas = canvas;
      this.gl = gl;
      gl.disable(gl.BLEND);
      gl.disable(gl.DEPTH_TEST);
      report({ event: "context-created", preference });
      return true;
    }
  })();
}
