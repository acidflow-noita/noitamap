import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/main.ts'],
  sourcemap: true,
  outDir: 'public/js',
  format: 'iife',
  minify: true,
  outExtension() {
    return {
      js: `.js`,
    };
  },
});
