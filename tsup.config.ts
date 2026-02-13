import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/main.ts"],
  sourcemap: true,
  outDir: "public/js",
  format: "iife",
  minify: true,
  define: {
    "process.env.NODE_ENV": '"production"',
  },
  outExtension() {
    return {
      js: `.js`,
    };
  },
  esbuildOptions(options) {
    // Handle WASM files: copy to output dir and return their URL path
    options.loader = { ...options.loader, ".wasm": "file" };
  },
});
