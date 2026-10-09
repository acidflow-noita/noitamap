import { readFileSync } from 'node:fs';
import { ScriptTarget, transpileModule } from 'typescript';

/** Bind the application's actual progress listeners to controlled request/map inputs. */
export function bindLoadingProgress(ui: typeof import('../../src/dynamic_ui')) {
  const source = readFileSync('src/main.ts', 'utf8');
  const start = source.indexOf('  // Handle map loading progress UI');
  const end = source.indexOf('\n\n  // TODO:', start);
  if (start < 0 || end < 0) throw new Error('Map loading event boundary changed');
  const script = transpileModule(source.slice(start, end), {
    compilerOptions: { target: ScriptTarget.ES2022 },
  }).outputText;
  const handlers = new Map<string, (event: CustomEvent) => void>();
  let map = 'dynamic-main-branch';
  let progress: ReturnType<typeof ui.createLoadingStripProgress> | undefined;
  const setBakedFlag = new Function('app', 'window', 'i18next', 'showLoadingStrip', 'hideLoadingStrip',
    'finishLoadingStrip', 'createLoadingStripProgress', `${script}\nreturn value => { bakedViewActive = value; };`)(
    { getMap: () => map }, { addEventListener: (name: string, handler: (event: CustomEvent) => void) => handlers.set(name, handler) },
    { isInitialized: true, t: (key: string) => key, on() {} }, ui.showLoadingStrip, ui.hideLoadingStrip,
    ui.finishLoadingStrip, () => (progress = ui.createLoadingStripProgress()));
  return {
    start() { setBakedFlag(false); progress?.start(); },
    show() { if (progress) progress.show(); else ui.showLoadingStrip(); },
    setBaked(baked: boolean) { setBakedFlag(baked); progress?.setBaked(baked); },
    settle() { progress?.settle(); },
    cancel() { progress?.cancel(); },
    setMap(name: string) { map = name; },
    update(phase: 'download' | 'generation' | 'items', percentage: unknown) {
      const name = { download: 'dataZipProgress', generation: 'biomeGenerationProgress', items: 'itemsGenerationProgress' }[phase];
      handlers.get(name)!(new CustomEvent(name, { detail: { percentage } }));
    },
  };
}
