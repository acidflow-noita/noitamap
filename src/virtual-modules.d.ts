declare module "virtual:noitamap-pro" {
  export function init(hooks: NoitamapProHooks): Promise<void>;
}

declare module "virtual:noitamap-public-report" {
  export function init(hooks: NoitamapProHooks): Promise<void>;
}
