import { App, type AppCreateOpts } from '../app';
import { initializeTranslations } from '../i18n';

/** Start independent network work together. Tile loading must not wait for a
 * dictionary, and a failed dictionary must not prevent the map from opening. */
export async function initializeApplication(options: AppCreateOpts): Promise<App> {
  const translations = initializeTranslations().catch(error => {
    console.error('i18next initialization failed:', error);
  });
  const map = App.create(options).catch(error => {
    console.warn('[Noitamap] Map failed to open, falling back to regular-main-branch:', error);
    return App.create({ ...options, initialState: { ...options.initialState, map: 'regular-main-branch' } });
  });
  const [app] = await Promise.all([map, translations]);
  return app;
}
