import { defineConfig } from 'vite';
import { resolve } from 'path';

import fs from 'fs';

const isProAvailable = fs.existsSync(resolve(__dirname, 'noitamap-pro/src/pro-entry.ts'));

export default defineConfig({
  resolve: {
    alias: isProAvailable
      ? {
          'noitamap/data_sources/tile_data': resolve(__dirname, 'src/data_sources/tile_data.ts'),
          'noitamap/data_sources/map_definitions': resolve(__dirname, 'src/data_sources/map_definitions.ts'),
          'noitamap/data_sources/param-mappings': resolve(__dirname, 'src/data_sources/param-mappings.ts'),
          'noitamap/data_sources/overlays': resolve(__dirname, 'src/data_sources/overlays.ts'),
          'noitamap/app_osd': resolve(__dirname, 'src/app_osd.ts'),
          'noitamap/util': resolve(__dirname, 'src/util.ts'),
          'noitamap/auth/auth-service': resolve(__dirname, 'src/auth/auth-service.ts'),
          'noitamap/i18n': resolve(__dirname, 'src/i18n.ts'),
        }
      : {},
  },
  build: {
    outDir: 'dist',
    emptyOutDir: false, // We'll clean this manually if needed, or let Vite overwrite
    sourcemap: true,
    minify: 'esbuild',

    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        ...(isProAvailable ? { pro: resolve(__dirname, 'noitamap-pro/src/pro-entry.ts') } : {}),
      },
      output: {
        // Force manual chunking for vendor dependencies
        manualChunks: id => {
          if (id.includes('node_modules')) {
            if (id.includes('openseadragon')) return 'vendor-osd';
            if (id.includes('pixi.js')) return 'vendor-pixi';
            if (id.includes('doodle')) return 'vendor-doodle';
            return 'vendor';
          }
        },
      },
    },
  },

  assetsInclude: ['**/*.wasm'],

  define: {
    'process.env.NODE_ENV': '"production"',
  },
});
