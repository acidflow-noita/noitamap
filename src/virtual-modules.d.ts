declare module "virtual:noitamap-pro" {
  export function init(hooks: NoitamapProHooks): Promise<void>;
}

declare module "virtual:noitamap-public-report" {
  export function init(hooks: NoitamapProHooks): Promise<void>;
}

// The pinned render-perf fork is JavaScript and is resolved by Vite in both entries.
declare module "noita-telescope-full-pixels/*";
