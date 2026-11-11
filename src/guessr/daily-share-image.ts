import { drawResultBackdrop, renderResultImage, resultImageText, RESULT_SHARE_SIZE } from './result-share-image';
import { DAILY_SHARE_MAXIMUM, type DailyShareData } from './daily-share-data';

export const DAILY_SHARE_SIZE = RESULT_SHARE_SIZE;
type Translate = (source: string, values?: Record<string, string | number>) => string;

export function dailyShareLabels(data: DailyShareData, locale: string, translate: Translate) {
  const number = new Intl.NumberFormat(locale);
  return {
    title: translate('Daily'),
    // Challenge dates are UTC dates, not local midnight timestamps.
    date: new Intl.DateTimeFormat(locale, { dateStyle: 'long', timeZone: 'UTC' }).format(new Date(`${data.day}T00:00:00Z`)),
    total: number.format(data.total),
    maximum: translate('out of {{value1}}', { value1: number.format(DAILY_SHARE_MAXIMUM) }),
    rounds: data.scores.map((score, index) => ({
      label: translate('Round {{round}}', { round: number.format(index + 1) }),
      score: number.format(score),
    })),
  };
}

/** Fixed export dimensions keep the image independent of page zoom and layout.
 * Use neutral Tailwind text, the logo's green and the site's supplied artwork. */
export function drawDailyShareImage(
  ctx: CanvasRenderingContext2D,
  labels: ReturnType<typeof dailyShareLabels>,
  logo: CanvasImageSource,
  topography: CanvasImageSource,
): void {
  drawResultBackdrop(ctx, logo, topography);
  const text = resultImageText(ctx);
  text(labels.title, 600, 62, 38, 800, '#f8fafc', 420, 'center');
  text(labels.date, 600, 109, 23, 400, '#cbd5e1', 800, 'center');
  text(labels.total, 600, 236, 116, 700, '#f8fafc', 1088, 'center');
  text(labels.maximum, 600, 321, 27, 400, '#cbd5e1', 1088, 'center');

  // Bootstrap 6 rounded-9 is 1rem: 16px in this fixed-resolution export.
  // One continuous outer border encloses the grid, with clear inner dividers.
  const left = 80, top = 384, column = 208, row = 134;
  ctx.strokeStyle = '#64748b';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.roundRect(left, top, column * 5, row * 2, 16);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(left, top + row); ctx.lineTo(1120, top + row);
  for (let index = 1; index < 5; index++) {
    const x = left + index * column;
    ctx.moveTo(x, top); ctx.lineTo(x, top + row * 2);
  }
  ctx.stroke();
  labels.rounds.forEach((round, index) => {
    const x = left + (index % 5) * column, y = top + Math.floor(index / 5) * row;
    text(round.label, x + 178, y + 39, 22, 400, '#cbd5e1', 160, 'right');
    // Identical right edges and tabular figures keep each score column aligned.
    text(round.score, x + 178, y + 87, 40, 600, '#f8fafc', 160, 'right');
  });
}

export function renderDailyShareImage(labels: ReturnType<typeof dailyShareLabels>): Promise<Blob> {
  return renderResultImage((ctx, logo, topography) => drawDailyShareImage(ctx, labels, logo, topography));
}
