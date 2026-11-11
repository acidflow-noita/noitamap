import { dailyShareData, dailyShareFilename, type DailyShareSource } from './daily-share-data';
import { guessrLocale, tr } from './i18n';
import { resultImageShare, type ResultShareControl } from './result-share';

/** Reopening a saved completed Daily uses exactly the same loaded result. */
export function dailyResultShare(state: DailyShareSource): ResultShareControl | null {
  const data = dailyShareData(state);
  if (!data) return null;
  const control = resultImageShare({ render: async () => {
    const { dailyShareLabels, renderDailyShareImage } = await import('./daily-share-image');
    const labels = dailyShareLabels(data, guessrLocale(), tr);
    return { blob: await renderDailyShareImage(labels), filename: dailyShareFilename(data),
      title: `NoitaGuessr, ${data.day}`, alt: `${labels.title}, ${labels.date}, ${labels.total} ${labels.maximum}` };
  } });
  control.element.classList.add('daily-share-open');
  return control;
}
