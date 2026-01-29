/**
 * Screenshot Export - Capture map with drawings
 */

import type { Shape } from './doodle-integration';

interface ViewportInfo {
  containerSize: { x: number; y: number };
  worldToPixel: (x: number, y: number) => { x: number; y: number };
}

/**
 * Capture a screenshot of the map canvas with drawing overlay
 */
export async function captureScreenshot(
  osdElement: HTMLElement,
  doodleCanvas: HTMLCanvasElement | null,
  mapName: string,
  shapes?: Shape[],
  viewportInfo?: ViewportInfo,
  strokeWidth?: number
): Promise<void> {
  try {
    // Find all canvases in the OSD element
    const allCanvases = osdElement.querySelectorAll('canvas');
    console.log('[Screenshot] Found', allCanvases.length, 'canvases in OSD element');

    // The first canvas is typically the OSD map canvas
    const osdCanvas = allCanvases[0] as HTMLCanvasElement;
    if (!osdCanvas) {
      console.error('[Screenshot] OSD canvas not found');
      return;
    }

    console.log('[Screenshot] OSD canvas:', osdCanvas.width, 'x', osdCanvas.height);

    // Create composite canvas
    const width = osdCanvas.width;
    const height = osdCanvas.height;
    const composite = document.createElement('canvas');
    composite.width = width;
    composite.height = height;
    const ctx = composite.getContext('2d');
    if (!ctx) {
      console.error('[Screenshot] Failed to get canvas context');
      return;
    }

    // Draw the map canvas
    ctx.drawImage(osdCanvas, 0, 0);
    console.log('[Screenshot] Drew OSD canvas');

    // Try to render shapes if we have shape data and viewport info
    if (shapes && shapes.length > 0 && viewportInfo) {
      console.log('[Screenshot] Rendering', shapes.length, 'shapes from data');
      renderShapesToCanvas(ctx, shapes, viewportInfo, width, height, strokeWidth ?? 5);
    } else if (doodleCanvas) {
      // Fallback to trying to capture the doodle canvas directly
      const doodleWidth = doodleCanvas.width;
      const doodleHeight = doodleCanvas.height;

      console.log('[Screenshot] Doodle canvas:', doodleWidth, 'x', doodleHeight);

      if (doodleWidth > 0 && doodleHeight > 0) {
        try {
          ctx.drawImage(doodleCanvas, 0, 0, doodleWidth, doodleHeight, 0, 0, width, height);
          console.log('[Screenshot] Drew doodle canvas');
        } catch (e) {
          console.error('[Screenshot] Failed to draw doodle canvas:', e);
        }
      }
    } else {
      console.log('[Screenshot] No shapes or doodle canvas to render');
    }

    // Add watermark
    await addWatermark(ctx, width, height);

    // Generate filename
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const filename = `noitamap-${mapName}-${timestamp}.webp`;

    // Trigger download - use WebP lossless (quality 1.0) for smaller file size
    const link = document.createElement('a');
    link.download = filename;
    link.href = composite.toDataURL('image/webp', 1.0);
    link.click();

    console.log('[Screenshot] Saved as', filename);
  } catch (error) {
    console.error('[Screenshot] Failed:', error);
  }
}

/**
 * Convert world coordinates to canvas pixel coordinates
 */
function worldToCanvas(
  worldX: number,
  worldY: number,
  viewportInfo: ViewportInfo,
  canvasWidth: number,
  canvasHeight: number
): { x: number; y: number } {
  const { containerSize, worldToPixel } = viewportInfo;
  // Use OpenSeadragon's coordinate conversion to get pixel position in container
  const pixelPoint = worldToPixel(worldX, worldY);
  // Scale from container pixels to canvas pixels (accounts for devicePixelRatio)
  const scaleX = canvasWidth / containerSize.x;
  const scaleY = canvasHeight / containerSize.y;
  return {
    x: pixelPoint.x * scaleX,
    y: pixelPoint.y * scaleY,
  };
}

/**
 * Render shapes to a 2D canvas context
 */
function renderShapesToCanvas(
  ctx: CanvasRenderingContext2D,
  shapes: Shape[],
  viewportInfo: ViewportInfo,
  canvasWidth: number,
  canvasHeight: number,
  strokeWidth: number
): void {

  for (const shape of shapes) {
    ctx.strokeStyle = shape.color;
    ctx.fillStyle = shape.color;
    ctx.lineWidth = strokeWidth;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    const pos = shape.pos;

    switch (shape.type) {
      case 'path':
      case 'closed_path': {
        if (pos.length < 4) break;
        ctx.beginPath();
        const start = worldToCanvas(pos[0], pos[1], viewportInfo, canvasWidth, canvasHeight);
        ctx.moveTo(start.x, start.y);
        for (let i = 2; i < pos.length; i += 2) {
          const pt = worldToCanvas(pos[i], pos[i + 1], viewportInfo, canvasWidth, canvasHeight);
          ctx.lineTo(pt.x, pt.y);
        }
        if (shape.type === 'closed_path') {
          ctx.closePath();
          ctx.fill();
        }
        ctx.stroke();
        break;
      }

      case 'line':
      case 'arrow_line': {
        if (pos.length < 4) break;
        const p1 = worldToCanvas(pos[0], pos[1], viewportInfo, canvasWidth, canvasHeight);
        const p2 = worldToCanvas(pos[2], pos[3], viewportInfo, canvasWidth, canvasHeight);
        ctx.beginPath();
        ctx.moveTo(p1.x, p1.y);
        ctx.lineTo(p2.x, p2.y);
        ctx.stroke();

        if (shape.type === 'arrow_line') {
          // Draw arrowhead
          const angle = Math.atan2(p2.y - p1.y, p2.x - p1.x);
          const headLen = 15;
          ctx.beginPath();
          ctx.moveTo(p2.x, p2.y);
          ctx.lineTo(
            p2.x - headLen * Math.cos(angle - Math.PI / 6),
            p2.y - headLen * Math.sin(angle - Math.PI / 6)
          );
          ctx.moveTo(p2.x, p2.y);
          ctx.lineTo(
            p2.x - headLen * Math.cos(angle + Math.PI / 6),
            p2.y - headLen * Math.sin(angle + Math.PI / 6)
          );
          ctx.stroke();
        }
        break;
      }

      case 'rect': {
        // pos = [x, y, width, height] (top-left corner + dimensions in world coords)
        if (pos.length < 4) break;
        const r1 = worldToCanvas(pos[0], pos[1], viewportInfo, canvasWidth, canvasHeight);
        const r2 = worldToCanvas(pos[0] + pos[2], pos[1] + pos[3], viewportInfo, canvasWidth, canvasHeight);
        ctx.strokeRect(r1.x, r1.y, r2.x - r1.x, r2.y - r1.y);
        break;
      }

      case 'circle': {
        if (pos.length < 3) break;
        const center = worldToCanvas(pos[0], pos[1], viewportInfo, canvasWidth, canvasHeight);
        // Convert radius by measuring the pixel distance for a world-space offset
        const radiusWorld = pos[2];
        const edgePoint = worldToCanvas(pos[0] + radiusWorld, pos[1], viewportInfo, canvasWidth, canvasHeight);
        const radiusPixels = edgePoint.x - center.x;
        ctx.beginPath();
        ctx.arc(center.x, center.y, Math.abs(radiusPixels), 0, Math.PI * 2);
        ctx.stroke();
        break;
      }

      case 'ellipse': {
        if (pos.length < 4) break;
        const eCenter = worldToCanvas(pos[0], pos[1], viewportInfo, canvasWidth, canvasHeight);
        const radiusXWorld = pos[2];
        const radiusYWorld = pos[3];
        // Convert radii by measuring pixel distances
        const edgeX = worldToCanvas(pos[0] + radiusXWorld, pos[1], viewportInfo, canvasWidth, canvasHeight);
        const edgeY = worldToCanvas(pos[0], pos[1] + radiusYWorld, viewportInfo, canvasWidth, canvasHeight);
        const radiusXPixels = edgeX.x - eCenter.x;
        const radiusYPixels = edgeY.y - eCenter.y;
        ctx.beginPath();
        ctx.ellipse(eCenter.x, eCenter.y, Math.abs(radiusXPixels), Math.abs(radiusYPixels), 0, 0, Math.PI * 2);
        ctx.stroke();
        break;
      }

      case 'polygon': {
        if (pos.length < 6) break;
        ctx.beginPath();
        const pStart = worldToCanvas(pos[0], pos[1], viewportInfo, canvasWidth, canvasHeight);
        ctx.moveTo(pStart.x, pStart.y);
        for (let i = 2; i < pos.length; i += 2) {
          const pt = worldToCanvas(pos[i], pos[i + 1], viewportInfo, canvasWidth, canvasHeight);
          ctx.lineTo(pt.x, pt.y);
        }
        ctx.closePath();
        ctx.stroke();
        break;
      }

      case 'point': {
        if (pos.length < 2) break;
        const point = worldToCanvas(pos[0], pos[1], viewportInfo, canvasWidth, canvasHeight);
        ctx.beginPath();
        ctx.arc(point.x, point.y, strokeWidth * 2, 0, Math.PI * 2);
        ctx.fill();
        break;
      }
    }
  }
}

/**
 * Add noitamap watermark to the screenshot (top-right corner)
 */
async function addWatermark(
  ctx: CanvasRenderingContext2D,
  canvasWidth: number,
  canvasHeight: number
): Promise<void> {
  const padding = 10;
  const watermarkHeight = 28;
  const watermarkWidth = 140;

  // Position in top-right corner
  const x = canvasWidth - watermarkWidth - padding;
  const y = padding;

  // Draw semi-transparent background
  ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
  ctx.beginPath();
  ctx.roundRect(x - 6, y - 4, watermarkWidth + 12, watermarkHeight + 8, 6);
  ctx.fill();

  // Try to load and draw logo first
  let logoWidth = 0;
  try {
    const logo = await loadImage('/assets/NoitamapLogo.png');
    const logoSize = watermarkHeight;
    ctx.drawImage(logo, x, y, logoSize, logoSize);
    logoWidth = logoSize + 8;
  } catch {
    // Logo failed to load, use text only
  }

  // Draw text watermark
  ctx.font = 'bold 14px Inter, system-ui, sans-serif';
  ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
  ctx.textBaseline = 'middle';
  ctx.fillText('noitamap.com', x + logoWidth, y + watermarkHeight / 2);
}

/**
 * Load an image asynchronously
 */
function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

/**
 * Get the doodle canvas element from the viewer
 */
export function getDoodleCanvas(viewerElement: HTMLElement): HTMLCanvasElement | null {
  // The doodle pixi canvas is appended to the OSD canvas element
  const canvases = viewerElement.querySelectorAll('canvas');
  // The first canvas is OSD, the second (if exists) is doodle
  if (canvases.length > 1) {
    return canvases[1] as HTMLCanvasElement;
  }
  return null;
}
