import { canvasToBlob, loadExportImage } from '../image-export';
import { DAILY_SHARE_MAXIMUM, type DailyShareData } from './daily-share-data';

export const DAILY_SHARE_SIZE = { width: 1200, height: 720 } as const;
const FONT = '"NoitaGuessrExport", InterVariable, Inter, sans-serif';
const FEATURES = '"tnum" 1, "zero" 1, "ss01" 1, "ss02" 1, "cv01" 1, "cv02" 1, "cv03" 1, "cv04" 1, "cv09" 1';
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
  ctx.fillStyle = '#020618';
  ctx.fillRect(0, 0, 1200, 720);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  // The same repeating contour artwork as the page, anchored to the bottom.
  ctx.drawImage(topography, 0, 120, 600, 600);
  ctx.drawImage(topography, 600, 120, 600, 600);
  const fade = ctx.createLinearGradient(0, 120, 0, 500);
  fade.addColorStop(0, '#020618');
  fade.addColorStop(1, 'rgba(2, 6, 24, 0)');
  ctx.fillStyle = fade;
  ctx.fillRect(0, 120, 1200, 600);

  ctx.drawImage(logo, 48, 40, 276, 276 * 93 / 602);
  ctx.textBaseline = 'middle';

  const text = (value: string, x: number, y: number, size: number, weight: number, color: string, width: number, align: CanvasTextAlign = 'left') => {
    ctx.textAlign = align;
    ctx.fillStyle = color;
    ctx.font = `${weight} ${size}px ${FONT}`;
    const measured = ctx.measureText(value).width;
    if (measured > width) ctx.font = `${weight} ${size * width / measured}px ${FONT}`;
    ctx.fillText(value, x, y);
  };
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

let logo: Promise<HTMLImageElement> | undefined;
let topography: Promise<HTMLImageElement> | undefined;
let font: Promise<void> | undefined;
function loadFont(): Promise<void> {
  return font ??= (async () => {
    if (typeof FontFace === 'undefined' || !document.fonts) return;
    // Same cacheable font as the site's rsms.me/inter/inter.css. A separate face
    // applies OpenType digits to Canvas without changing the site's shared face.
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const face = new FontFace('NoitaGuessrExport', 'url(https://rsms.me/inter/font-files/InterVariable.woff2?v=4.1)',
        { weight: '100 900', featureSettings: FEATURES });
      await Promise.race([face.load(), new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error('Font loading timed out')), 4000);
      })]);
      document.fonts.add(face);
    } catch {
      // Font-host outages must not prevent saving results. The existing loaded
      // site font or the system's language-appropriate fallback remains usable.
      font = undefined;
    } finally { clearTimeout(timeout); }
  })();
}

export async function renderDailyShareImage(labels: ReturnType<typeof dailyShareLabels>): Promise<Blob> {
  logo ??= loadExportImage('/assets/noitaguessr-logo.svg').catch(error => { logo = undefined; throw error; });
  topography ??= loadExportImage('/guessr/topography.svg').catch(error => { topography = undefined; throw error; });
  const [artwork, pattern] = await Promise.all([logo, topography, loadFont()]);
  const canvas = document.createElement('canvas');
  canvas.width = DAILY_SHARE_SIZE.width;
  canvas.height = DAILY_SHARE_SIZE.height;
  const ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx) throw new Error('Canvas is unavailable');
  try {
    drawDailyShareImage(ctx, labels, artwork, pattern);
    const blob = await canvasToBlob(canvas, 'image/png');
    if (!blob || blob.type !== 'image/png') throw new Error('PNG encoding failed');
    return blob;
  } finally {
    canvas.width = canvas.height = 0;
  }
}
