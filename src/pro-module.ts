import { loadVerifiedProModule } from './pro-release';
import trusted from './pro-release-key.json';
interface ProModule {
  init(hooks: NoitamapProHooks): void | Promise<void>;
}

/** Use a local checkout only in development and only when it actually exists. */
export async function loadProModule(): Promise<ProModule> {
  if (import.meta.env.DEV && __LOCAL_PRO_AVAILABLE__) {
    return import("virtual:noitamap-pro");
  }

  const module = await loadVerifiedProModule('https://noitamap-pro.acidflow.stream/pro.manifest.json', trusted);
  if (typeof module.init !== 'function') throw Error('The verified Pro entry has no init function.');
  return module as unknown as ProModule;
}
