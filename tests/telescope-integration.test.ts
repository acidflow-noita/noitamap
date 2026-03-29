import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const TELESCOPE_JS_DIR = path.resolve(__dirname, '../lib/noita-telescope/js');
const DOM_SHIM_PATH = path.resolve(__dirname, '../src/telescope/telescope-dom-shim.ts');
const APP_SHIM_PATH = path.resolve(__dirname, '../src/telescope/telescope-app-shim.js');
const TELESCOPE_EXPORTS_PATH = path.resolve(__dirname, '../src/telescope/telescope-exports.ts');
const TELESCOPE_APP_PATH = path.resolve(__dirname, '../lib/noita-telescope/js/app.js');

/**
 * Extract all document.getElementById('...') IDs from telescope JS source files.
 */
function extractTelescopeDomIds(): Set<string> {
  const ids = new Set<string>();
  const files = fs.readdirSync(TELESCOPE_JS_DIR).filter(f => f.endsWith('.js'));

  for (const file of files) {

    const content = fs.readFileSync(path.join(TELESCOPE_JS_DIR, file), 'utf8');
    // Match both single and double quotes
    const regex = /document\.getElementById\(\s*['"]([^'"]+)['"]\s*\)/g;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(content)) !== null) {
      ids.add(match[1]);
    }
  }
  return ids;
}

/**
 * Extract all IDs from the DOM shim's checkboxes and textInputs maps.
 */
function extractShimIds(): Set<string> {
  const ids = new Set<string>();
  const content = fs.readFileSync(DOM_SHIM_PATH, 'utf8');

  // Match quoted keys in the checkboxes and textInputs objects
  const regex = /"([^"]+)":\s*(cfg\.\w+|true|false|"[^"]*")/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(content)) !== null) {
    ids.add(match[1]);
  }
  return ids;
}

describe('Telescope DOM Shim Coverage', () => {
  it('should cover all document.getElementById() IDs that telescope uses', () => {
    const telescopeIds = extractTelescopeDomIds();
    const shimIds = extractShimIds();

    expect(telescopeIds.size, 'No DOM IDs found in telescope — parser may be broken').toBeGreaterThan(0);
    expect(shimIds.size, 'No IDs found in DOM shim — parser may be broken').toBeGreaterThan(0);

    const uncoveredIds = [...telescopeIds].filter(id => !shimIds.has(id));

    expect(
      uncoveredIds,
      `Telescope uses ${uncoveredIds.length} DOM element ID(s) not covered by the shim:\n` +
      uncoveredIds.map(id => `  - "${id}"`).join('\n') +
      `\n\nAdd these to telescope-dom-shim.ts checkboxes or textInputs.`
    ).toEqual([]);
  });
});

describe('clearSpawnPixels Default', () => {
  it('should default clearSpawnPixels to true in the shim options', () => {
    const content = fs.readFileSync(DOM_SHIM_PATH, 'utf8');

    // Check the DEFAULTS object has clearSpawnPixels: true
    const defaultsMatch = content.match(/const\s+DEFAULTS[\s\S]*?clearSpawnPixels:\s*(true|false)/);
    expect(defaultsMatch, 'Could not find DEFAULTS.clearSpawnPixels in DOM shim').not.toBeNull();
    expect(defaultsMatch![1], 'DEFAULTS.clearSpawnPixels must be true to hide spawn pixels by default').toBe('true');
  });

  it('should map "clear-spawn-pixels" checkbox to cfg.clearSpawnPixels', () => {
    const content = fs.readFileSync(DOM_SHIM_PATH, 'utf8');

    // Verify the checkbox mapping exists
    expect(content).toContain('"clear-spawn-pixels"');
    expect(content).toMatch(/"clear-spawn-pixels":\s*cfg\.clearSpawnPixels/);
  });

  it('should set clearSpawnPixels: true in telescope-adapter.ts initTelescope()', () => {
    const adapterPath = path.resolve(__dirname, '../src/telescope/telescope-adapter.ts');
    const content = fs.readFileSync(adapterPath, 'utf8');

    // Find the installTelescopeShim call and verify clearSpawnPixels is true
    const shimCallMatch = content.match(/installTelescopeShim\(\{[\s\S]*?clearSpawnPixels:\s*(true|false)/);
    expect(shimCallMatch, 'Could not find installTelescopeShim call in adapter').not.toBeNull();
    expect(shimCallMatch![1], 'clearSpawnPixels must be true in initTelescope()').toBe('true');
  });

  it('should call updateSettings with clearSpawnPixels: true in both adapter and osd-bridge', () => {
    // Telescope refactored from reading DOM checkboxes to using a centralized
    // appSettings object (settings.js). If updateSettings isn't called after
    // module import, clearSpawnPixels defaults to false and spawn pixels appear.
    const adapterPath = path.resolve(__dirname, '../src/telescope/telescope-adapter.ts');
    const osdBridgePath = path.resolve(__dirname, '../src/telescope/telescope-osd-bridge.ts');

    for (const [name, filePath] of [['adapter', adapterPath], ['osd-bridge', osdBridgePath]]) {
      const content = fs.readFileSync(filePath, 'utf8');

      // Check that updateSettings is called with clearSpawnPixels: true
      const updateMatch = content.match(/updateSettings\(\{[\s\S]*?clearSpawnPixels:\s*(true|false)/);
      expect(
        updateMatch,
        `${name} must call updateSettings({ clearSpawnPixels: true }) to override telescope's default`
      ).not.toBeNull();
      expect(updateMatch![1], `clearSpawnPixels must be true in ${name}'s updateSettings call`).toBe('true');
    }
  });

  it('should detect if telescope uses appSettings instead of direct DOM reads', () => {
    // If telescope has a settings.js with appSettings, noitamap MUST call updateSettings
    const settingsPath = path.resolve(__dirname, '../lib/noita-telescope/js/settings.js');
    if (fs.existsSync(settingsPath)) {
      const content = fs.readFileSync(settingsPath, 'utf8');
      if (content.includes('clearSpawnPixels')) {
        // settings.js exists and has clearSpawnPixels — verify it's exported
        expect(content).toMatch(/export\s+(const|function)\s+(appSettings|updateSettings)/);

        // Verify noitamap calls updateSettings
        const adapterContent = fs.readFileSync(
          path.resolve(__dirname, '../src/telescope/telescope-adapter.ts'), 'utf8'
        );
        expect(
          adapterContent,
          'telescope has settings.js with clearSpawnPixels — adapter MUST call updateSettings'
        ).toContain('updateSettings');
      }
    }
  });
});

describe('Telescope API Surface', () => {
  it('should have all module files that telescope-exports.ts imports', () => {
    const content = fs.readFileSync(TELESCOPE_EXPORTS_PATH, 'utf8');

    // Extract all import paths like: from "noita-telescope/biome_generator.js"
    const importRegex = /from\s+["']noita-telescope\/([^"']+)["']/g;
    const modulePaths: string[] = [];
    let match: RegExpExecArray | null;
    while ((match = importRegex.exec(content)) !== null) {
      modulePaths.push(match[1]);
    }

    expect(modulePaths.length, 'No module imports found in telescope-exports.ts').toBeGreaterThan(0);

    const missingFiles: string[] = [];
    for (const modPath of modulePaths) {
      // app.js is shimmed, skip it
      if (modPath === 'app.js') continue;

      const fullPath = path.join(TELESCOPE_JS_DIR, modPath);
      if (!fs.existsSync(fullPath)) {
        missingFiles.push(modPath);
      }
    }

    expect(
      missingFiles,
      `Missing telescope JS files referenced by telescope-exports.ts:\n` +
      missingFiles.map(f => `  - ${f}`).join('\n')
    ).toEqual([]);
  });

  it('should have expected exports in each telescope module', () => {
    // Critical exports that noitamap depends on, grouped by module
    const expectedExports: Record<string, string[]> = {
      'biome_generator.js': ['generateBiomeData', 'BIOME_CONFIG'],
      'tile_generator.js': ['generateBiomeTiles'],
      'poi_scanner.js': ['scanSpawnFunctions', 'getSpecialPoIs', 'prescanSpawnFunctions'],
      'pixel_scene_generation.js': ['PIXEL_SCENE_DATA', 'loadPixelSceneData'],
      'generator_config.js': ['GENERATOR_CONFIG'],
      'unlocks.js': ['UNLOCKABLES', 'setUnlocks'],
      'utils.js': ['getWorldSize', 'getWorldCenter'],
      'translations.js': ['loadTranslations'],
      'eye_messages.js': ['findEyeMessages'],
      'static_spawns.js': ['addStaticPixelScenes'],
      'nolla_prng.js': ['NollaPrng'],
      'constants.js': [],
      'png_sanitizer.js': ['loadPNG'],
      'image_processing.js': ['BIOME_COLOR_LOOKUP'],
    };

    const issues: string[] = [];

    for (const [modPath, requiredExports] of Object.entries(expectedExports)) {
      const fullPath = path.join(TELESCOPE_JS_DIR, modPath);
      if (!fs.existsSync(fullPath)) {
        issues.push(`MISSING FILE: ${modPath}`);
        continue;
      }

      const content = fs.readFileSync(fullPath, 'utf8');

      for (const exportName of requiredExports) {
        // Check for: export function name, export const name, export class name,
        // export { name }, export async function name
        const exportPatterns = [
          new RegExp(`export\\s+(async\\s+)?function\\s+${exportName}\\b`),
          new RegExp(`export\\s+(const|let|var|class)\\s+${exportName}\\b`),
          new RegExp(`export\\s*\\{[^}]*\\b${exportName}\\b[^}]*\\}`),
          // Also handle: export const [X, Y] = await ... (destructured)
          new RegExp(`export\\s+const\\s+\\[.*\\b${exportName}\\b.*\\]`),
        ];

        const found = exportPatterns.some(p => p.test(content));
        if (!found) {
          issues.push(`MISSING EXPORT: ${modPath} → ${exportName}`);
        }
      }
    }

    expect(
      issues,
      `Telescope API surface issues:\n` + issues.map(i => `  - ${i}`).join('\n')
    ).toEqual([]);
  });
});

describe('App Shim Completeness', () => {
  it('should stub all properties that telescope app.js uses', () => {
    const appContent = fs.readFileSync(TELESCOPE_APP_PATH, 'utf8');
    const shimContent = fs.readFileSync(APP_SHIM_PATH, 'utf8');

    // Extract `this.propertyName` from the app constructor/init — but only
    // top-level assignments (not inside nested functions/methods)
    // We look for patterns like: this.propertyName = ... or app.propertyName
    const thisProps = new Set<string>();
    const thisRegex = /(?:this|app)\.(\w+)\s*=/g;
    let match: RegExpExecArray | null;
    while ((match = thisRegex.exec(appContent)) !== null) {
      // Skip internal/method names
      if (match[1] === 'prototype' || match[1] === 'init') continue;
      thisProps.add(match[1]);
    }

    // Extract properties defined in the shim
    const shimProps = new Set<string>();
    const shimRegex = /^\s+(\w+)\s*[:=]/gm;
    while ((match = shimRegex.exec(shimContent)) !== null) {
      // Skip common non-property patterns
      if (['export', 'const', 'let', 'var', 'function', 'if', 'return', 'console'].includes(match[1])) continue;
      shimProps.add(match[1]);
    }

    const missingProps = [...thisProps].filter(p => !shimProps.has(p));

    // This is a soft check — warn but don't fail, as some properties
    // may be runtime-only or irrelevant to our usage
    if (missingProps.length > 0) {
      console.warn(
        `⚠️  App shim may be missing ${missingProps.length} properties from telescope's app.js:\n` +
        `   ${missingProps.join(', ')}\n` +
        `   Review if any are needed for noitamap's usage.`
      );
    }

    // Hard check: the critical properties must exist
    const criticalProps = [
      'recolorOffscreen', 'recolorOffscreenBuffer',
      'recolorOffscreenHeaven', 'recolorOffscreenHeavenBuffer',
      'recolorOffscreenHell', 'recolorOffscreenHellBuffer',
      'w', 'h', 'biomeData', 'seed', 'ngPlusCount', 'isNGP',
      'pw', 'pwVertical', 'tileSpawns', 'tileLayers',
      'pixelScenesByPW', 'poisByPW', 'perks',
    ];

    const missingCritical = criticalProps.filter(p => !shimProps.has(p));
    expect(
      missingCritical,
      `App shim missing CRITICAL properties:\n` +
      missingCritical.map(p => `  - ${p}`).join('\n')
    ).toEqual([]);
  });
});
