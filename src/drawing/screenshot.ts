/**
 * Screenshot Export - Capture map with drawings
 *
 * Embeds drawing data in WebP metadata using a custom RIFF chunk.
 */

import type { Shape } from './doodle-integration';
import { encodeShapesBinary, decodeShapesBinary } from './binary-encoder';

// Custom RIFF chunk IDs (must be exactly 4 ASCII chars)
const DRAW_CHUNK_ID = 'NOIT';
const MAP_CHUNK_ID = 'NMAP';

interface ViewportInfo {
  containerSize: { x: number; y: number };
  worldToPixel: (x: number, y: number) => { x: number; y: number };
  mapBounds?: {
    left: number;
    top: number;
    right: number;
    bottom: number;
  };
}

/**
 * Inject drawing data into a WebP blob as a custom RIFF chunk
 */
function createRiffChunk(chunkId: string, data: Uint8Array): Uint8Array {
  const paddedSize = data.length + (data.length % 2);
  const chunk = new Uint8Array(8 + paddedSize);
  chunk[0] = chunkId.charCodeAt(0);
  chunk[1] = chunkId.charCodeAt(1);
  chunk[2] = chunkId.charCodeAt(2);
  chunk[3] = chunkId.charCodeAt(3);
  chunk[4] = data.length & 0xff;
  chunk[5] = (data.length >> 8) & 0xff;
  chunk[6] = (data.length >> 16) & 0xff;
  chunk[7] = (data.length >> 24) & 0xff;
  chunk.set(data, 8);
  return chunk;
}

async function injectDrawingData(webpBlob: Blob, shapes: Shape[], strokeWidth: number, mapName?: string): Promise<Blob> {
  const binary = encodeShapesBinary(shapes, mapName ?? '', strokeWidth);
  if (!binary || binary.length === 0) {
    return webpBlob;
  }

  const webpData = new Uint8Array(await webpBlob.arrayBuffer());

  // Verify WebP format: starts with "RIFF" and contains "WEBP"
  if (
    webpData.length < 12 ||
    String.fromCharCode(webpData[0], webpData[1], webpData[2], webpData[3]) !== 'RIFF' ||
    String.fromCharCode(webpData[8], webpData[9], webpData[10], webpData[11]) !== 'WEBP'
  ) {
    console.warn('[Screenshot] Not a valid WebP file, skipping drawing data injection');
    return webpBlob;
  }

  // Build chunks to append
  const drawChunk = createRiffChunk(DRAW_CHUNK_ID, binary);
  const mapChunk = mapName
    ? createRiffChunk(MAP_CHUNK_ID, new TextEncoder().encode(mapName))
    : null;

  const extraSize = drawChunk.length + (mapChunk ? mapChunk.length : 0);
  const newSize = webpData.length + extraSize;
  const newData = new Uint8Array(newSize);
  newData.set(webpData, 0);
  let writeOffset = webpData.length;
  newData.set(drawChunk, writeOffset);
  writeOffset += drawChunk.length;
  if (mapChunk) {
    newData.set(mapChunk, writeOffset);
  }

  // Update RIFF file size (bytes 4-7, little-endian, excludes first 8 bytes)
  const riffSize = newSize - 8;
  newData[4] = riffSize & 0xff;
  newData[5] = (riffSize >> 8) & 0xff;
  newData[6] = (riffSize >> 16) & 0xff;
  newData[7] = (riffSize >> 24) & 0xff;

  return new Blob([newData], { type: 'image/webp' });
}

/**
 * Extract drawing data from a WebP file
 * Returns shapes, strokeWidth, and mapName, or null if no drawing data found
 */
export async function extractDrawingData(
  file: File | Blob
): Promise<{ shapes: Shape[]; strokeWidth: number; mapName?: string } | null> {
  try {
    const data = new Uint8Array(await file.arrayBuffer());

    // Verify WebP format
    if (
      data.length < 12 ||
      String.fromCharCode(data[0], data[1], data[2], data[3]) !== 'RIFF' ||
      String.fromCharCode(data[8], data[9], data[10], data[11]) !== 'WEBP'
    ) {
      return null;
    }

    // Parse RIFF chunks to find NOIT and NMAP chunks
    let offset = 12; // Skip RIFF header + WEBP signature
    let drawingResult: { shapes: Shape[]; strokeWidth: number } | null = null;
    let mapName: string | undefined;

    while (offset + 8 <= data.length) {
      const chunkId = String.fromCharCode(data[offset], data[offset + 1], data[offset + 2], data[offset + 3]);
      const chunkSize =
        data[offset + 4] | (data[offset + 5] << 8) | (data[offset + 6] << 16) | (data[offset + 7] << 24);

      if (chunkId === DRAW_CHUNK_ID) {
        // Found drawing data chunk
        const chunkData = data.slice(offset + 8, offset + 8 + chunkSize);
        drawingResult = decodeShapesBinary(chunkData);
      } else if (chunkId === MAP_CHUNK_ID) {
        // Found map name chunk
        const chunkData = data.slice(offset + 8, offset + 8 + chunkSize);
        mapName = new TextDecoder().decode(chunkData);
      }

      // Move to next chunk (8-byte header + size, padded to 2-byte boundary)
      offset += 8 + chunkSize + (chunkSize % 2);
    }

    if (drawingResult) {
      console.log('[Screenshot] Extracted', drawingResult.shapes.length, 'shapes from WebP, map:', mapName);
      return { ...drawingResult, mapName };
    }

    return null;
  } catch (e) {
    console.error('[Screenshot] Failed to extract drawing data:', e);
    return null;
  }
}

/**
 * Capture a screenshot of the map canvas with drawing overlay.
 * Returns a WebP blob with drawing data embedded in a NOIT RIFF chunk.
 * The caller decides what to do with it (download, upload, etc.)
 */
export async function captureScreenshot(
  osdElement: HTMLElement,
  doodleCanvas: HTMLCanvasElement | null,
  mapName: string,
  shapes?: Shape[],
  viewportInfo?: ViewportInfo,
  strokeWidth?: number
): Promise<Blob | null> {
  try {
    // Find all canvases in the OSD element
    const allCanvases = osdElement.querySelectorAll('canvas');
    console.log('[Screenshot] Found', allCanvases.length, 'canvases in OSD element');

    // The first canvas is typically the OSD map canvas
    const osdCanvas = allCanvases[0] as HTMLCanvasElement;
    if (!osdCanvas) {
      console.error('[Screenshot] OSD canvas not found');
      return null;
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
      return null;
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

    // Crop to visible map bounds if available
    let finalCanvas: HTMLCanvasElement = composite;
    if (viewportInfo?.mapBounds) {
      const mb = viewportInfo.mapBounds;
      const dpr = width / viewportInfo.containerSize.x;
      // Intersect map bounds with viewport (0,0,width,height)
      const cropLeft = Math.max(0, Math.floor(mb.left * dpr));
      const cropTop = Math.max(0, Math.floor(mb.top * dpr));
      const cropRight = Math.min(width, Math.ceil(mb.right * dpr));
      const cropBottom = Math.min(height, Math.ceil(mb.bottom * dpr));
      const cropW = cropRight - cropLeft;
      const cropH = cropBottom - cropTop;

      if (cropW > 0 && cropH > 0 && (cropW < width || cropH < height)) {
        const cropped = document.createElement('canvas');
        cropped.width = cropW;
        cropped.height = cropH;
        const cropCtx = cropped.getContext('2d');
        if (cropCtx) {
          cropCtx.drawImage(composite, cropLeft, cropTop, cropW, cropH, 0, 0, cropW, cropH);
          finalCanvas = cropped;
          console.log('[Screenshot] Cropped to map bounds:', cropW, 'x', cropH);
        }
      }
    }

    // Add watermark to final canvas
    const finalCtx = finalCanvas.getContext('2d');
    if (finalCtx) {
      await addWatermark(finalCtx, finalCanvas.width, finalCanvas.height);
    }

    // Convert canvas to blob, inject drawing data
    const blob = await canvasToBlob(finalCanvas);
    if (!blob) {
      console.error('[Screenshot] Failed to create blob');
      return null;
    }

    // Embed drawing data and map name in WebP if shapes exist
    const finalBlob =
      shapes && shapes.length > 0
        ? await injectDrawingData(blob, shapes, strokeWidth ?? 5, mapName)
        : blob;

    console.log('[Screenshot] Captured', finalBlob.size, 'bytes');
    return finalBlob;
  } catch (error) {
    console.error('[Screenshot] Failed:', error);
    return null;
  }
}

/**
 * Download a blob as a file
 */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.download = filename;
  link.href = url;
  link.click();
  URL.revokeObjectURL(url);
}

/**
 * Generate a screenshot filename
 */
export function screenshotFilename(mapName: string): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return `noitamap-${mapName}-${timestamp}.webp`;
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

/**
 * Convert canvas to WebP blob
 */
function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob | null> {
  return new Promise(resolve => {
    canvas.toBlob(
      blob => resolve(blob),
      'image/webp',
      1.0 // lossless quality
    );
  });
}
