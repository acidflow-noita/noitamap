/**
 * Image Vectorization for Noitamap Drawing
 *
 * Converts raster images (PNG, JPG, WebP) and SVG files to Shape objects
 * that can be rendered in the drawing layer.
 *
 * Uses vectortracer WASM package for raster-to-SVG conversion.
 */

import { BinaryImageConverter, init as initVectorTracer } from './vectortracer';
import type { Shape } from './doodle-integration';

// --- Configuration ---

const REGULAR_MAP_WIDTH = 107520;
const REGULAR_MAP_CENTER = { x: 0, y: 5120 };
const DEFAULT_TARGET_SCALE_PERCENT = 0.6;

// --- Types ---

export interface VectorizeOptions {
  colorPrecision?: number; // default: 6
  filterSpeckle?: number; // default: 4
  targetScalePercent?: number; // default: 0.6
}

// --- Helper Functions (ported from convert_svg.ts) ---

/**
 * Sample a cubic Bezier curve as discrete line segments
 */
function sampleBezier(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  x3: number,
  y3: number,
  segments = 20
): number[] {
  const points: number[] = [];
  for (let i = 1; i <= segments; i++) {
    const t = i / segments;
    const u = 1 - t;
    const tt = t * t;
    const uu = u * u;
    const uuu = uu * u;
    const ttt = tt * t;

    const x = uuu * x0 + 3 * uu * t * x1 + 3 * u * tt * x2 + ttt * x3;
    const y = uuu * y0 + 3 * uu * t * y1 + 3 * u * tt * y2 + ttt * y3;
    points.push(x, y);
  }
  return points;
}

/**
 * Check if a set of points forms an axis-aligned rectangle
 */
function isRectangle(pos: number[]): { x: number; y: number; w: number; h: number } | null {
  // Expect 4 points (8 numbers) or 5 points (10 numbers) where last == first
  if (pos.length !== 8 && pos.length !== 10) return null;

  // If closed loop, remove last point
  const points: { x: number; y: number }[] = [];
  for (let i = 0; i < pos.length; i += 2) {
    points.push({ x: pos[i], y: pos[i + 1] });
  }

  if (points.length === 5) {
    if (Math.abs(points[0].x - points[4].x) < 0.001 && Math.abs(points[0].y - points[4].y) < 0.001) {
      points.pop();
    } else {
      return null; // Not a closed loop rectangle
    }
  }

  if (points.length !== 4) return null;

  // Check for axis aligned rectangle
  const xs = points.map(p => p.x).sort((a, b) => a - b);
  const ys = points.map(p => p.y).sort((a, b) => a - b);

  const tolerance = 1.0;

  if (Math.abs(xs[0] - xs[1]) > tolerance) return null;
  if (Math.abs(xs[2] - xs[3]) > tolerance) return null;
  if (Math.abs(ys[0] - ys[1]) > tolerance) return null;
  if (Math.abs(ys[2] - ys[3]) > tolerance) return null;

  const isHorizontal = (p1: { x: number; y: number }, p2: { x: number; y: number }) =>
    Math.abs(p1.y - p2.y) <= tolerance;
  const isVertical = (p1: { x: number; y: number }, p2: { x: number; y: number }) =>
    Math.abs(p1.x - p2.x) <= tolerance;

  let valid = false;
  if (
    isHorizontal(points[0], points[1]) &&
    isVertical(points[1], points[2]) &&
    isHorizontal(points[2], points[3]) &&
    isVertical(points[3], points[0])
  )
    valid = true;
  else if (
    isVertical(points[0], points[1]) &&
    isHorizontal(points[1], points[2]) &&
    isVertical(points[2], points[3]) &&
    isHorizontal(points[3], points[0])
  )
    valid = true;

  if (!valid) return null;

  const minX = xs[0];
  const maxX = xs[2];
  const minY = ys[0];
  const maxY = ys[2];

  return {
    x: minX,
    y: minY,
    w: maxX - minX,
    h: maxY - minY,
  };
}

// --- Browser-specific functions ---

/**
 * Load an image file and return its ImageData
 */
async function fileToImageData(file: File): Promise<ImageData> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);

    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = img.width;
      canvas.height = img.height;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        URL.revokeObjectURL(url);
        reject(new Error('Could not get canvas context'));
        return;
      }
      ctx.drawImage(img, 0, 0);
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      resolve(imageData);
    };

    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Failed to load image'));
    };

    img.src = url;
  });
}

/**
 * Convert raster ImageData to SVG using vectortracer WASM
 */
async function rasterToSvg(
  imageData: ImageData,
  options: VectorizeOptions,
  onProgress?: (progress: number) => void
): Promise<string> {
  // Ensure WASM is loaded
  await initVectorTracer();

  const converter = new BinaryImageConverter(
    imageData,
    {
      color_precision: options.colorPrecision ?? 6,
      filter_speckle: options.filterSpeckle ?? 4,
    },
    {} // Missing third argument: generic Options struct
  );

  converter.init();

  return new Promise(resolve => {
    let tickCount = 0;
    const estimatedTicks = 100; // Rough estimate for progress

    function tick() {
      if (converter.tick()) {
        tickCount++;
        if (onProgress) {
          onProgress(Math.min(0.9, tickCount / estimatedTicks));
        }
        // Use setTimeout to avoid blocking the main thread
        setTimeout(tick, 0);
      } else {
        const svg = converter.getResult();
        converter.free();
        if (onProgress) {
          onProgress(1.0);
        }
        resolve(svg);
      }
    }
    tick();
  });
}

/**
 * Parse SVG path data and convert to map-coordinate shapes
 */
function parseSvgToShapes(
  svgContent: string,
  mapWidth: number,
  mapCenter: { x: number; y: number },
  targetScalePercent: number,
  originalWidth: number,
  originalHeight: number
): Shape[] {
  const parser = new DOMParser();
  const doc = parser.parseFromString(svgContent, 'image/svg+xml');

  // Check for parsing errors
  const parseError = doc.querySelector('parsererror');
  if (parseError) {
    console.warn('[Vectorize] SVG parsing error:', parseError.textContent);
    return [];
  }

  // Get SVG dimensions - prefer provided original dimensions
  let svgWidth = originalWidth;
  let svgHeight = originalHeight;

  console.log(`[Vectorize] Using dimensions: ${svgWidth}x${svgHeight}`);

  const targetWidth = mapWidth * targetScalePercent;
  const scale = targetWidth / svgWidth;

  const offsetX = mapCenter.x - (svgWidth * scale) / 2;
  const offsetY = mapCenter.y - (svgHeight * scale) / 2;

  console.log(`[Vectorize] Calculated scale: ${scale}, offset: (${offsetX}, ${offsetY})`);

  const paths = doc.querySelectorAll('path');
  const shapes: Shape[] = [];
  let shapeCounter = 0;

  paths.forEach(pathEl => {
    const d = pathEl.getAttribute('d');
    if (!d) return;

    // --- Color Extraction ---
    let fill = '';
    
    // Check path attribute
    const pathFill = pathEl.getAttribute('fill');
    if (pathFill && pathFill !== 'none') {
      fill = pathFill;
    } else {
      // Check style attribute
      const style = pathEl.getAttribute('style') || '';
      const fillMatch = style.match(/fill:\s*([^;]+)/);
      if (fillMatch && fillMatch[1] !== 'none') {
        fill = fillMatch[1].trim();
      } else {
        // Check parent groups
        let parent = pathEl.parentElement;
        while (parent && parent.tagName.toLowerCase() !== 'svg') {
          const parentFill = parent.getAttribute('fill');
          if (parentFill && parentFill !== 'none') {
            fill = parentFill;
            break;
          }
          const parentStyle = parent.getAttribute('style') || '';
          const parentFillMatch = parentStyle.match(/fill:\s*([^;]+)/);
          if (parentFillMatch && parentFillMatch[1] !== 'none') {
            fill = parentFillMatch[1].trim();
            break;
          }
          parent = parent.parentElement;
        }
      }
    }

    // Default to black if no color found
    if (!fill || fill === 'none' || fill === 'transparent') {
        fill = '#000000';
    }

    // --- Transform ---
    let transformX = 0;
    let transformY = 0;
    const transformAttr = pathEl.getAttribute('transform');
    if (transformAttr) {
      const translateMatch = transformAttr.match(/translate\(\s*([-+]?\d*\.?\d+)\s*[\s,]\s*([-+]?\d*\.?\d+)\s*\)/i);
      if (translateMatch) {
        transformX = parseFloat(translateMatch[1]);
        transformY = parseFloat(translateMatch[2]);
      }
    }

    const tokens = d.match(/([a-zA-Z])|([-+]?\d*\.?\d+(?:e[-+]?\d+)?)/g);
    if (!tokens) return;

    let currentX = 0;
    let currentY = 0;
    let lastCommand = '';
    let currentSubPath: number[] = [];
    const subPaths: number[][] = [];

    function finishSubPath() {
      if (currentSubPath.length >= 4) {
        subPaths.push(currentSubPath);
      }
      currentSubPath = [];
    }

    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];

      if (/^[a-zA-Z]$/.test(token)) {
        if ((token === 'M' || token === 'm') && currentSubPath.length > 0) {
          finishSubPath();
        }
        lastCommand = token;
        continue;
      }

      // If it's a number, use lastCommand
      let x = 0, y = 0;
      switch (lastCommand) {
        case 'M':
          x = parseFloat(token);
          y = parseFloat(tokens[++i]);
          currentX = x;
          currentY = y;
          currentSubPath.push((currentX + transformX) * scale + offsetX, (currentY + transformY) * scale + offsetY);
          lastCommand = 'L'; // Subsequent pairs are implicit LineTo
          break;
        case 'm':
          x = parseFloat(token);
          y = parseFloat(tokens[++i]);
          currentX += x;
          currentY += y;
          currentSubPath.push((currentX + transformX) * scale + offsetX, (currentY + transformY) * scale + offsetY);
          lastCommand = 'l';
          break;
        case 'L':
          x = parseFloat(token);
          y = parseFloat(tokens[++i]);
          currentX = x;
          currentY = y;
          currentSubPath.push((currentX + transformX) * scale + offsetX, (currentY + transformY) * scale + offsetY);
          break;
        case 'l':
          x = parseFloat(token);
          y = parseFloat(tokens[++i]);
          currentX += x;
          currentY += y;
          currentSubPath.push((currentX + transformX) * scale + offsetX, (currentY + transformY) * scale + offsetY);
          break;
        case 'H':
          currentX = parseFloat(token);
          currentSubPath.push((currentX + transformX) * scale + offsetX, (currentY + transformY) * scale + offsetY);
          break;
        case 'h':
          currentX += parseFloat(token);
          currentSubPath.push((currentX + transformX) * scale + offsetX, (currentY + transformY) * scale + offsetY);
          break;
        case 'V':
          currentY = parseFloat(token);
          currentSubPath.push((currentX + transformX) * scale + offsetX, (currentY + transformY) * scale + offsetY);
          break;
        case 'v':
          currentY += parseFloat(token);
          currentSubPath.push((currentX + transformX) * scale + offsetX, (currentY + transformY) * scale + offsetY);
          break;
        case 'C': {
          const x1 = parseFloat(token);
          const y1 = parseFloat(tokens[++i]);
          const x2 = parseFloat(tokens[++i]);
          const y2 = parseFloat(tokens[++i]);
          const x_final = parseFloat(tokens[++i]);
          const y_final = parseFloat(tokens[++i]);
          const sampled = sampleBezier(currentX, currentY, x1, y1, x2, y2, x_final, y_final, 20);
          for (let j = 0; j < sampled.length; j += 2) {
            currentSubPath.push(
              (sampled[j] + transformX) * scale + offsetX,
              (sampled[j + 1] + transformY) * scale + offsetY
            );
          }
          currentX = x_final;
          currentY = y_final;
          break;
        }
        case 'c': {
          const x1 = currentX + parseFloat(token);
          const y1 = currentY + parseFloat(tokens[++i]);
          const x2 = currentX + parseFloat(tokens[++i]);
          const y2 = currentY + parseFloat(tokens[++i]);
          const x_final = currentX + parseFloat(tokens[++i]);
          const y_final = currentY + parseFloat(tokens[++i]);
          const sampled = sampleBezier(currentX, currentY, x1, y1, x2, y2, x_final, y_final, 20);
          for (let j = 0; j < sampled.length; j += 2) {
            currentSubPath.push(
              (sampled[j] + transformX) * scale + offsetX,
              (sampled[j + 1] + transformY) * scale + offsetY
            );
          }
          currentX = x_final;
          currentY = y_final;
          break;
        }
      }
    }
    finishSubPath();

    // Group subpaths: identify holes vs islands
    interface PathInfo {
      path: number[];
      bounds: { minX: number; maxX: number; minY: number; maxY: number };
      area: number;
      children: PathInfo[];
    }

    const pathInfos: PathInfo[] = subPaths.map(p => {
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      for (let k = 0; k < p.length; k += 2) {
        const px = p[k];
        const py = p[k + 1];
        if (px < minX) minX = px;
        if (px > maxX) maxX = px;
        if (py < minY) minY = py;
        if (py > maxY) maxY = py;
      }
      const width = maxX - minX;
      const height = maxY - minY;
      return {
        path: p,
        bounds: { minX, maxX, minY, maxY },
        area: width * height,
        children: [],
      };
    });

    pathInfos.sort((a, b) => b.area - a.area);
    const roots: PathInfo[] = [];

    for (const info of pathInfos) {
      let foundGroup = false;
      for (const root of roots) {
        if (
          info.bounds.minX >= root.bounds.minX &&
          info.bounds.maxX <= root.bounds.maxX &&
          info.bounds.minY >= root.bounds.minY &&
          info.bounds.maxY <= root.bounds.maxY
        ) {
          root.children.push(info);
          foundGroup = true;
          break;
        }
      }
      if (!foundGroup) roots.push(info);
    }

    for (const root of roots) {
      let combinedPos = [...root.path];
      for (const child of root.children) combinedPos.push(...child.path);

      if (root.children.length === 0) {
        const rect = isRectangle(combinedPos);
        if (rect) {
          shapes.push({
            id: `shape_${shapeCounter++}`,
            type: 'rect',
            pos: [rect.x, rect.y, rect.w, rect.h],
            color: fill,
            filled: true,
            fillAlpha: 1.0,
            strokeWidth: 0,
          });
          continue;
        }
      }

      shapes.push({
        id: `shape_${shapeCounter++}`,
        type: 'polygon',
        pos: combinedPos,
        color: fill,
        filled: true,
        fillAlpha: 1.0,
        strokeWidth: 0,
      });
    }
  });

  return shapes;
}

// --- Public API ---

/**
 * Vectorize an image file (PNG, JPG, WebP, or SVG) and return Shape objects
 */
export async function vectorizeImage(
  file: File,
  mapWidth: number = REGULAR_MAP_WIDTH,
  mapCenter: { x: number; y: number } = REGULAR_MAP_CENTER,
  options: VectorizeOptions = {},
  onProgress?: (progress: number) => void
): Promise<Shape[]> {
  const targetScalePercent = options.targetScalePercent ?? DEFAULT_TARGET_SCALE_PERCENT;

  // Determine file type
  const isSvg = file.type === 'image/svg+xml' || file.name.toLowerCase().endsWith('.svg');

  let svgContent: string;
  let imgWidth = 1000;
  let imgHeight = 1000;

  if (isSvg) {
    svgContent = await file.text();
    // For SVG, we still need dimensions. Let's parse it minimally.
    const parser = new DOMParser();
    const doc = parser.parseFromString(svgContent, 'image/svg+xml');
    const svgEl = doc.querySelector('svg');
    if (svgEl) {
        const viewBox = svgEl.getAttribute('viewBox');
        if (viewBox) {
            const parts = viewBox.split(/\s+|,/).map(parseFloat);
            if (parts.length === 4) { imgWidth = parts[2]; imgHeight = parts[3]; }
        } else {
            imgWidth = parseFloat(svgEl.getAttribute('width') || '1000');
            imgHeight = parseFloat(svgEl.getAttribute('height') || '1000');
        }
    }
    if (onProgress) onProgress(0.5);
  } else {
    const imageData = await fileToImageData(file);
    imgWidth = imageData.width;
    imgHeight = imageData.height;
    console.log(`[Vectorize] Original image size: ${imgWidth}x${imgHeight}`);
    if (onProgress) onProgress(0.1);

    svgContent = await rasterToSvg(imageData, options, progress => {
      if (onProgress) {
        onProgress(0.1 + progress * 0.8);
      }
    });
  }

  const shapes = parseSvgToShapes(svgContent, mapWidth, mapCenter, targetScalePercent, imgWidth, imgHeight);

  if (onProgress) onProgress(1.0);

  return shapes;
}

/**
 * Get the default map dimensions for the regular map
 */
export function getDefaultMapDimensions(): { width: number; center: { x: number; y: number } } {
  return {
    width: REGULAR_MAP_WIDTH,
    center: REGULAR_MAP_CENTER,
  };
}