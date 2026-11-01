// Portable, noise-free lighting from Noita's post_final.frag. No renderer, DOM,
// assets, world coordinates, fog, vignette or camera effects are required.
// RGB inputs use the game's normalized display-space convention, not a new
// linear-light workflow. Foreground RGB must be premultiplied; alpha is coverage.
export const LIGHTING_CONSTANTS = Object.freeze({ directScale: .8, directPower: 1.5, gamma: 2.2, glowCutoff: .008 });
const freeze = value => Object.freeze({ ...value,
  worldLight: Object.freeze(value.worldLight), skyLight: Object.freeze(value.skyLight),
  glowModulation: Object.freeze(value.glowModulation) });
export const DEFAULT_LIGHTING = freeze({ enabled: true, ambient: .35,
  worldLight: [0, 0, 0], skyLight: [0, 0, 0], glowModulation: [1, 1, 1] });
const UNLIT = freeze({ ...DEFAULT_LIGHTING, enabled: false, worldLight: [0, 0, 0], skyLight: [0, 0, 0], glowModulation: [1, 1, 1] });
const profiles = new Map(), tables = new WeakMap();
const clamp = x => Math.max(0, Math.min(1, x));

// worldLight: sampled native tex_lights RGB, before .8 scaling and power 1.5.
// skyLight: processed sky color * sky-ambient contribution (a lighting floor).
// ambient: neutral contribution AFTER gamma, .35 for a fully revealed dark area.
// glowModulation: native max(1 - skyAmbient, skyLightColor), normally [1,1,1].
// Hosts compute their own light maps/skylight; these settings also accept one
// sampled pixel's values when calling composeLitChannel directly.
export function resolveLighting(input = true, monochrome = false) {
  if (input == null || input === true) return DEFAULT_LIGHTING;
  if (input === false || input.enabled === false) return UNLIT;
  if (typeof input !== 'object') throw new TypeError('Lighting must be a boolean or settings object');
  const triplet = (name, fallback) => {
    const value = input[name] ?? fallback;
    if (!Array.isArray(value) || value.length !== 3 || value.some(v => !Number.isFinite(v) || v < 0 || v > 1))
      throw new RangeError(`Invalid lighting ${name}`);
    if (!monochrome) return [...value];
    const gray = value[0] * .2126 + value[1] * .7152 + value[2] * .0722;
    return [gray, gray, gray];
  };
  const ambient = input.ambient ?? DEFAULT_LIGHTING.ambient;
  if (!Number.isFinite(ambient) || ambient < 0 || ambient > 1) throw new RangeError('Invalid ambient light');
  const profile = { enabled: true, ambient,
    worldLight: triplet('worldLight', DEFAULT_LIGHTING.worldLight),
    skyLight: triplet('skyLight', DEFAULT_LIGHTING.skyLight),
    glowModulation: triplet('glowModulation', DEFAULT_LIGHTING.glowModulation) };
  const key = JSON.stringify(profile);
  if (!profiles.has(key)) {
    if (profiles.size >= 32) profiles.delete(profiles.keys().next().value);
    profiles.set(key, freeze(profile));
  }
  return profiles.get(key);
}

export function lightAt(glow, channel = 0, profile = DEFAULT_LIGHTING) {
  if (!profile.enabled) return 1;
  const direct = (profile.worldLight[channel] * LIGHTING_CONSTANTS.directScale) ** LIGHTING_CONSTANTS.directPower;
  return clamp(Math.max(direct + glow, profile.skyLight[channel])) ** (1 / LIGHTING_CONSTANTS.gamma) + profile.ambient;
}

// 'glow' is the filtered glow AFTER the native .008 cutoff. Additive foreground
// RGB may exceed its coverage; do not discard it or clamp it to alpha.
export function composeLitChannel(foreground, coverage, glow, background, channel = 0,
  profile = DEFAULT_LIGHTING, light = lightAt(glow, channel, profile)) {
  const base = foreground * light + background * (1 - coverage);
  const modulation = profile.enabled ? profile.glowModulation[channel] : 1;
  return clamp(Math.max(base + glow * .6 - light * .6, clamp(base + glow - base * modulation * glow)));
}

// Fast adapter for RGBA8 glow histories. The JS/WASM rasterizers consume this
// table so the portable module owns gamma and the lighting profile for both.
export function buildLightingTable(profile = DEFAULT_LIGHTING) {
  let table = tables.get(profile);
  if (!table) {
    table = new Float64Array(256 * 3);
    for (let byte = 0; byte < 256; byte++) for (let c = 0; c < 3; c++)
      table[byte * 3 + c] = lightAt(Math.max(0, Math.fround(byte / 255) - LIGHTING_CONSTANTS.glowCutoff), c, profile);
    tables.set(profile, table);
  }
  return table;
}

// Append to a fragment shader, supply the same profile as uniforms. Light-field
// sampling and monochrome conversion belong to the host, not this math module.
export const NOITA_LIGHTING_GLSL = `
vec3 noitaLightRGB(vec3 glow, vec3 worldLight, vec3 skyLight, float ambient) {
  vec3 direct=pow(worldLight*${LIGHTING_CONSTANTS.directScale},vec3(${LIGHTING_CONSTANTS.directPower}));
  return pow(clamp(max(direct+glow,skyLight),0.,1.),vec3(1./${LIGHTING_CONSTANTS.gamma}))+vec3(ambient);
}
vec3 noitaComposite(vec4 foreground, vec3 glow, vec3 background, bool enabled,
                    vec3 worldLight, vec3 skyLight, float ambient, vec3 glowModulation) {
  vec3 light=enabled?noitaLightRGB(glow,worldLight,skyLight,ambient):vec3(1);
  vec3 base=foreground.rgb*light+background*(1.-foreground.a);
  vec3 modulation=enabled?glowModulation:vec3(1);
  return clamp(max(base+glow*.6-light*.6,clamp(base+glow-base*modulation*glow,0.,1.)),0.,1.);
}
`;
