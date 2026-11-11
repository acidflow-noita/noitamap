import { canvasToBlob, loadExportImage } from '../image-export';

export const RESULT_SHARE_SIZE = { width: 1200, height: 720 } as const;
const FONT = '"NoitaGuessrExport", InterVariable, Inter, sans-serif';
const FEATURES = '"tnum" 1, "zero" 1, "ss01" 1, "ss02" 1, "cv01" 1, "cv02" 1, "cv03" 1, "cv04" 1, "cv09" 1';

export function drawResultBackdrop(ctx: CanvasRenderingContext2D, logo: CanvasImageSource, topography: CanvasImageSource): void {
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

}

export function resultImageText(ctx: CanvasRenderingContext2D) {
  return (value: string, x: number, y: number, size: number, weight: number, color: string, width: number, align: CanvasTextAlign = 'left') => {
    ctx.textAlign = align;
    ctx.fillStyle = color;
    ctx.font = `${weight} ${size}px ${FONT}`;
    const measured = ctx.measureText(value).width;
    if (measured > width) ctx.font = `${weight} ${size * width / measured}px ${FONT}`;
    ctx.fillText(value, x, y);
  };
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

export async function renderResultImage(draw: (ctx: CanvasRenderingContext2D, logo: CanvasImageSource, topography: CanvasImageSource) => void): Promise<Blob> {
  logo ??= loadExportImage('/assets/noitaguessr-logo.svg').catch(error => { logo = undefined; throw error; });
  topography ??= loadExportImage('/guessr/topography.svg').catch(error => { topography = undefined; throw error; });
  const [artwork, pattern] = await Promise.all([logo, topography, loadFont()]);
  const canvas = document.createElement('canvas');
  canvas.width = RESULT_SHARE_SIZE.width;
  canvas.height = RESULT_SHARE_SIZE.height;
  const ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx) throw new Error('Canvas is unavailable');
  try {
    draw(ctx, artwork, pattern);
    const blob = await canvasToBlob(canvas, 'image/png');
    if (!blob || blob.type !== 'image/png') throw new Error('PNG encoding failed');
    return blob;
  } finally {
    canvas.width = canvas.height = 0;
  }
}
