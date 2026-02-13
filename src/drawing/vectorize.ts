/**
 * Image Vectorization for Noitamap Drawing
 *
 * Converts raster images (PNG, JPG, WebP) and SVG files to Shape objects
 * that can be rendered in the drawing layer.
 *
 * Uses vtracer WASM (visioncortex) for raster-to-SVG conversion via
 * ColorImageConverter operating on DOM canvas/svg elements.
 */

import {
  ColorImageConverter,
  init as initVtracer,
  reset as resetVtracer,
} from "./vtracer";
import type { Shape } from "./doodle-integration";

// --- Configuration ---

const REGULAR_MAP_WIDTH = 107520;
const REGULAR_MAP_CENTER = { x: 0, y: 5120 };
const DEFAULT_TARGET_SCALE_PERCENT = 0.6;

// --- Types ---

export interface VectorizeOptions {
  colorPrecision?: number; // default: 6 (UI value; internal = 8 - value)
  filterSpeckle?: number; // default: 0
  layerDifference?: number; // default: 0 (gradient step)
  targetScalePercent?: number; // default: 0.6
}

// --- Helper Functions ---

function deg2rad(deg: number): number {
  return (deg / 180) * Math.PI;
}

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
  segments = 20,
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
function isRectangle(
  pos: number[],
): { x: number; y: number; w: number; h: number } | null {
  if (pos.length !== 8 && pos.length !== 10) return null;

  const points: { x: number; y: number }[] = [];
  for (let i = 0; i < pos.length; i += 2) {
    points.push({ x: pos[i], y: pos[i + 1] });
  }

  if (points.length === 5) {
    if (
      Math.abs(points[0].x - points[4].x) < 0.001 &&
      Math.abs(points[0].y - points[4].y) < 0.001
    ) {
      points.pop();
    } else {
      return null;
    }
  }

  if (points.length !== 4) return null;

  const xs = points.map((p) => p.x).sort((a, b) => a - b);
  const ys = points.map((p) => p.y).sort((a, b) => a - b);
  const tolerance = 1.0;

  if (Math.abs(xs[0] - xs[1]) > tolerance) return null;
  if (Math.abs(xs[2] - xs[3]) > tolerance) return null;
  if (Math.abs(ys[0] - ys[1]) > tolerance) return null;
  if (Math.abs(ys[2] - ys[3]) > tolerance) return null;

  const isH = (p1: { x: number; y: number }, p2: { x: number; y: number }) =>
    Math.abs(p1.y - p2.y) <= tolerance;
  const isV = (p1: { x: number; y: number }, p2: { x: number; y: number }) =>
    Math.abs(p1.x - p2.x) <= tolerance;

  let valid = false;
  if (
    isH(points[0], points[1]) &&
    isV(points[1], points[2]) &&
    isH(points[2], points[3]) &&
    isV(points[3], points[0])
  )
    valid = true;
  else if (
    isV(points[0], points[1]) &&
    isH(points[1], points[2]) &&
    isV(points[2], points[3]) &&
    isH(points[3], points[0])
  )
    valid = true;
  if (!valid) return null;

  return { x: xs[0], y: ys[0], w: xs[2] - xs[0], h: ys[2] - ys[0] };
}

// --- Core: Raster to SVG via WASM ---

/**
 * Convert a raster image to SVG using the vtracer WASM ColorImageConverter.
 * Creates temporary hidden canvas/svg DOM elements for the WASM to operate on.
 */
async function rasterToSvgElement(
  imageData: {
    width: number;
    height: number;
    drawTo: (ctx: CanvasRenderingContext2D) => void;
  },
  options: VectorizeOptions,
  onProgress?: (progress: number) => void,
): Promise<SVGSVGElement> {
  await initVtracer();

  // Create hidden DOM elements for the WASM converter
  const canvasId = "__vtracer_canvas_" + Date.now();
  const svgId = "__vtracer_svg_" + Date.now();

  const canvas = document.createElement("canvas");
  canvas.id = canvasId;
  canvas.width = imageData.width;
  canvas.height = imageData.height;
  canvas.style.cssText = "position:fixed;left:-9999px;top:-9999px;";
  document.body.appendChild(canvas);

  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.id = svgId;
  svg.setAttribute("version", "1.1");
  svg.setAttribute("viewBox", `0 0 ${imageData.width} ${imageData.height}`);
  svg.style.cssText = "position:fixed;left:-9999px;top:-9999px;";
  document.body.appendChild(svg);

  const ctx = canvas.getContext("2d");
  if (!ctx) {
    canvas.remove();
    svg.remove();
    throw new Error("Could not get canvas 2d context");
  }

  imageData.drawTo(ctx);

  const colorPrecision = options.colorPrecision ?? 6;
  const params = JSON.stringify({
    canvas_id: canvasId,
    svg_id: svgId,
    mode: "none", // pixel mode
    clustering_mode: "color",
    hierarchical: "stacked",
    corner_threshold: deg2rad(60),
    length_threshold: 4.0,
    max_iterations: 10,
    splice_threshold: deg2rad(45),
    filter_speckle: (options.filterSpeckle ?? 0) * (options.filterSpeckle ?? 0),
    color_precision: 8 - colorPrecision,
    layer_difference: options.layerDifference ?? 0,
    path_precision: 8,
  });

  const converter = ColorImageConverter.new_with_string(params);
  converter.init();

  // Run tick loop, yielding to the browser periodically
  await new Promise<void>((resolve, reject) => {
    function tick() {
      try {
        const start = performance.now();
        let done = false;
        while (!(done = converter.tick()) && performance.now() - start < 50) {
          // batch ticks for up to 50ms
        }
        if (onProgress) {
          onProgress(Math.min(0.95, converter.progress() / 100));
        }
        if (!done) {
          setTimeout(tick, 1);
        } else {
          converter.free();
          resolve();
        }
      } catch (e) {
        // WASM panics (e.g. divide-by-zero in color clustering) are unrecoverable
        try {
          converter.free();
        } catch (_) {
          /* already dead */
        }
        resetVtracer(); // Allow re-initialization on next attempt
        reject(
          new Error(
            "Vectorization failed — the image may be too complex or photographic. This feature works best with pixel art and flat-color images.",
          ),
        );
      }
    }
    tick();
  });

  // Clean up the canvas (keep svg — caller will read it)
  canvas.remove();

  return svg;
}

// --- Core: SVG DOM to Shapes ---

/**
 * Parse SVG path elements from a DOM SVGSVGElement and convert to map-coordinate shapes.
 */
function svgElementToShapes(
  svgEl: SVGSVGElement,
  mapWidth: number,
  mapCenter: { x: number; y: number },
  targetScalePercent: number,
  originalWidth: number,
  originalHeight: number,
): Shape[] {
  const svgWidth = originalWidth;
  const svgHeight = originalHeight;

  const targetWidth = mapWidth * targetScalePercent;
  const scale = targetWidth / svgWidth;
  const offsetX = mapCenter.x - (svgWidth * scale) / 2;
  const offsetY = mapCenter.y - (svgHeight * scale) / 2;

  const paths = svgEl.querySelectorAll("path");
  const shapes: Shape[] = [];
  let shapeCounter = 0;

  paths.forEach((pathEl) => {
    const d = pathEl.getAttribute("d");
    if (!d) return;

    // Color extraction
    let fill = "";
    const pathFill = pathEl.getAttribute("fill");
    if (pathFill && pathFill !== "none") {
      fill = pathFill;
    } else {
      const style = pathEl.getAttribute("style") || "";
      const fillMatch = style.match(/fill:\s*([^;]+)/);
      if (fillMatch && fillMatch[1] !== "none") {
        fill = fillMatch[1].trim();
      } else {
        let parent = pathEl.parentElement;
        while (parent && parent.tagName.toLowerCase() !== "svg") {
          const parentFill = parent.getAttribute("fill");
          if (parentFill && parentFill !== "none") {
            fill = parentFill;
            break;
          }
          const parentStyle = parent.getAttribute("style") || "";
          const parentFillMatch = parentStyle.match(/fill:\s*([^;]+)/);
          if (parentFillMatch && parentFillMatch[1] !== "none") {
            fill = parentFillMatch[1].trim();
            break;
          }
          parent = parent.parentElement;
        }
      }
    }

    if (!fill || fill === "none" || fill === "transparent") fill = "#000000";

    // Transform
    let transformX = 0;
    let transformY = 0;
    const transformAttr = pathEl.getAttribute("transform");
    if (transformAttr) {
      const translateMatch = transformAttr.match(
        /translate\(\s*([-+]?\d*\.?\d+)\s*[\s,]\s*([-+]?\d*\.?\d+)\s*\)/i,
      );
      if (translateMatch) {
        transformX = parseFloat(translateMatch[1]);
        transformY = parseFloat(translateMatch[2]);
      }
    }

    // Parse path data
    const tokens = d.match(/([a-zA-Z])|([-+]?\d*\.?\d+(?:e[-+]?\d+)?)/g);
    if (!tokens) return;

    let currentX = 0;
    let currentY = 0;
    let lastCommand = "";
    let currentSubPath: number[] = [];
    const subPaths: number[][] = [];

    function finishSubPath() {
      if (currentSubPath.length >= 4) subPaths.push(currentSubPath);
      currentSubPath = [];
    }

    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];

      if (/^[a-zA-Z]$/.test(token)) {
        if ((token === "M" || token === "m") && currentSubPath.length > 0)
          finishSubPath();
        lastCommand = token;
        continue;
      }

      switch (lastCommand) {
        case "M": {
          const x = parseFloat(token);
          const y = parseFloat(tokens[++i]);
          currentX = x;
          currentY = y;
          currentSubPath.push(
            (currentX + transformX) * scale + offsetX,
            (currentY + transformY) * scale + offsetY,
          );
          lastCommand = "L";
          break;
        }
        case "m": {
          const x = parseFloat(token);
          const y = parseFloat(tokens[++i]);
          currentX += x;
          currentY += y;
          currentSubPath.push(
            (currentX + transformX) * scale + offsetX,
            (currentY + transformY) * scale + offsetY,
          );
          lastCommand = "l";
          break;
        }
        case "L": {
          const x = parseFloat(token);
          const y = parseFloat(tokens[++i]);
          currentX = x;
          currentY = y;
          currentSubPath.push(
            (currentX + transformX) * scale + offsetX,
            (currentY + transformY) * scale + offsetY,
          );
          break;
        }
        case "l": {
          const x = parseFloat(token);
          const y = parseFloat(tokens[++i]);
          currentX += x;
          currentY += y;
          currentSubPath.push(
            (currentX + transformX) * scale + offsetX,
            (currentY + transformY) * scale + offsetY,
          );
          break;
        }
        case "H":
          currentX = parseFloat(token);
          currentSubPath.push(
            (currentX + transformX) * scale + offsetX,
            (currentY + transformY) * scale + offsetY,
          );
          break;
        case "h":
          currentX += parseFloat(token);
          currentSubPath.push(
            (currentX + transformX) * scale + offsetX,
            (currentY + transformY) * scale + offsetY,
          );
          break;
        case "V":
          currentY = parseFloat(token);
          currentSubPath.push(
            (currentX + transformX) * scale + offsetX,
            (currentY + transformY) * scale + offsetY,
          );
          break;
        case "v":
          currentY += parseFloat(token);
          currentSubPath.push(
            (currentX + transformX) * scale + offsetX,
            (currentY + transformY) * scale + offsetY,
          );
          break;
        case "C": {
          const x1 = parseFloat(token);
          const y1 = parseFloat(tokens[++i]);
          const x2 = parseFloat(tokens[++i]);
          const y2 = parseFloat(tokens[++i]);
          const xf = parseFloat(tokens[++i]);
          const yf = parseFloat(tokens[++i]);
          const sampled = sampleBezier(
            currentX,
            currentY,
            x1,
            y1,
            x2,
            y2,
            xf,
            yf,
            20,
          );
          for (let j = 0; j < sampled.length; j += 2) {
            currentSubPath.push(
              (sampled[j] + transformX) * scale + offsetX,
              (sampled[j + 1] + transformY) * scale + offsetY,
            );
          }
          currentX = xf;
          currentY = yf;
          break;
        }
        case "c": {
          const x1 = currentX + parseFloat(token);
          const y1 = currentY + parseFloat(tokens[++i]);
          const x2 = currentX + parseFloat(tokens[++i]);
          const y2 = currentY + parseFloat(tokens[++i]);
          const xf = currentX + parseFloat(tokens[++i]);
          const yf = currentY + parseFloat(tokens[++i]);
          const sampled = sampleBezier(
            currentX,
            currentY,
            x1,
            y1,
            x2,
            y2,
            xf,
            yf,
            20,
          );
          for (let j = 0; j < sampled.length; j += 2) {
            currentSubPath.push(
              (sampled[j] + transformX) * scale + offsetX,
              (sampled[j + 1] + transformY) * scale + offsetY,
            );
          }
          currentX = xf;
          currentY = yf;
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

    const pathInfos: PathInfo[] = subPaths.map((p) => {
      let minX = Infinity,
        maxX = -Infinity,
        minY = Infinity,
        maxY = -Infinity;
      for (let k = 0; k < p.length; k += 2) {
        if (p[k] < minX) minX = p[k];
        if (p[k] > maxX) maxX = p[k];
        if (p[k + 1] < minY) minY = p[k + 1];
        if (p[k + 1] > maxY) maxY = p[k + 1];
      }
      return {
        path: p,
        bounds: { minX, maxX, minY, maxY },
        area: (maxX - minX) * (maxY - minY),
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
            type: "rect",
            pos: [rect.x, rect.y, rect.w, rect.h],
            color: fill,
            filled: true,
            fillAlpha: 1.0,
            strokeWidth: 0,
          });
          return; // continue forEach
        }
      }

      shapes.push({
        id: `shape_${shapeCounter++}`,
        type: "polygon",
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
 * Vectorize an image file and return Shape objects
 */
export async function vectorizeImage(
  file: File,
  mapWidth: number = REGULAR_MAP_WIDTH,
  mapCenter: { x: number; y: number } = REGULAR_MAP_CENTER,
  options: VectorizeOptions = {},
  onProgress?: (progress: number) => void,
): Promise<Shape[]> {
  const targetScalePercent =
    options.targetScalePercent ?? DEFAULT_TARGET_SCALE_PERCENT;

  // Determine file type
  const isSvg =
    file.type === "image/svg+xml" || file.name.toLowerCase().endsWith(".svg");

  if (isSvg) {
    // For SVG files, parse directly without WASM vectorization
    const svgContent = await file.text();
    const parser = new DOMParser();
    const doc = parser.parseFromString(svgContent, "image/svg+xml");
    const svgEl = doc.querySelector("svg");
    if (!svgEl) return [];

    let imgWidth = 1000,
      imgHeight = 1000;
    const viewBox = svgEl.getAttribute("viewBox");
    if (viewBox) {
      const parts = viewBox.split(/\s+|,/).map(parseFloat);
      if (parts.length === 4) {
        imgWidth = parts[2];
        imgHeight = parts[3];
      }
    } else {
      imgWidth = parseFloat(svgEl.getAttribute("width") || "1000");
      imgHeight = parseFloat(svgEl.getAttribute("height") || "1000");
    }

    if (onProgress) onProgress(0.5);
    const shapes = svgElementToShapes(
      svgEl as unknown as SVGSVGElement,
      mapWidth,
      mapCenter,
      targetScalePercent,
      imgWidth,
      imgHeight,
    );
    if (onProgress) onProgress(1.0);
    return shapes;
  }

  // Raster image: load into an Image element, then vectorize via WASM
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const el = new Image();
    const url = URL.createObjectURL(file);
    el.onload = () => {
      URL.revokeObjectURL(url);
      resolve(el);
    };
    el.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Failed to load image"));
    };
    el.src = url;
  });

  const imgWidth = img.naturalWidth;
  const imgHeight = img.naturalHeight;
  console.log(`[Vectorize] Image size: ${imgWidth}x${imgHeight}`);

  if (onProgress) onProgress(0.05);

  const svgEl = await rasterToSvgElement(
    {
      width: imgWidth,
      height: imgHeight,
      drawTo: (ctx) => ctx.drawImage(img, 0, 0),
    },
    options,
    (progress) => {
      if (onProgress) onProgress(0.05 + progress * 0.85);
    },
  );

  if (onProgress) onProgress(0.9);

  const shapes = svgElementToShapes(
    svgEl,
    mapWidth,
    mapCenter,
    targetScalePercent,
    imgWidth,
    imgHeight,
  );

  // Clean up the SVG element
  svgEl.remove();

  if (onProgress) onProgress(1.0);
  console.log(`[Vectorize] Generated ${shapes.length} shapes`);

  return shapes;
}

/**
 * Get the default map dimensions
 */
export function getDefaultMapDimensions(): {
  width: number;
  center: { x: number; y: number };
} {
  return { width: REGULAR_MAP_WIDTH, center: REGULAR_MAP_CENTER };
}
