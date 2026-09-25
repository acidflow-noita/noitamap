declare module "virtual:noitamap-pro" {
  export function init(hooks: NoitamapProHooks): Promise<void>;
}

declare module "virtual:noitamap-public-report" {
  export function init(hooks: NoitamapProHooks): Promise<void>;
}

// The pinned render-perf fork is JavaScript and is resolved by Vite in both entries.
declare module "noita-telescope-full-pixels/*";

declare module "virtual:noitamap-scene-assets" {
  export const provenance: string;
  export const packs: Record<"full" | "approx", { url: string; scenes: number; bytes: number }>;
}
declare module 'virtual:instant-terrain-shaders' {
  export const TERRAIN_FS: string;
  export const TERRAIN_VS: string;
}
