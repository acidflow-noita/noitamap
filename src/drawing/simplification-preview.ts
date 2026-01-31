/**
 * Simplification Preview - Debug tool to visualize URL compression quality loss
 *
 * Shows a semi-transparent overlay of simplified shapes so users can see
 * how their drawing will look when shared via URL.
 */

import simplify from 'simplify-js';
import type { Shape } from './doodle-integration';
import type { AppOSD } from '../app_osd';
import { encodeShapesWithInfo } from './url-encoder';

// Preview color - NOT in the palette (magenta/pink)
const PREVIEW_COLOR = '#ff00ff';
const PREVIEW_ALPHA = 0.5;

interface SimplificationPreview {
  enable(): void;
  disable(): void;
  isEnabled(): boolean;
  setTolerance(tolerance: number): void;
  getTolerance(): number;
  setShapes(shapes: Shape[]): void;
  destroy(): void;
}

/**
 * Simplify path-based shapes to reduce data size
 * Only simplifies path, closed_path, and polygon - other shapes pass through unchanged
 */
function simplifyShapes(shapes: Shape[], tolerance: number): Shape[] {
  if (tolerance <= 1) return shapes; // No simplification needed

  return shapes.map(shape => {
    // Only simplify path-like shapes (same as url-encoder.ts)
    if (shape.type === 'path' || shape.type === 'closed_path' || shape.type === 'polygon') {
      const points = posToPoints(shape.pos);
      if (points.length < 3) return shape; // Need at least 3 points to simplify
      const simplified = simplify(points, tolerance, true);
      return {
        ...shape,
        pos: pointsToPos(simplified),
      };
    }
    // Non-path shapes (rect, circle, line, etc.) are NOT simplified
    return shape;
  });
}

function posToPoints(pos: number[]): Array<{ x: number; y: number }> {
  const points: Array<{ x: number; y: number }> = [];
  for (let i = 0; i < pos.length; i += 2) {
    points.push({ x: pos[i], y: pos[i + 1] });
  }
  return points;
}

function pointsToPos(points: Array<{ x: number; y: number }>): number[] {
  const pos: number[] = [];
  for (const point of points) {
    pos.push(Math.round(point.x), Math.round(point.y));
  }
  return pos;
}

/**
 * Create a simplification preview overlay
 */
export function createSimplificationPreview(osd: AppOSD): SimplificationPreview {
  let enabled = false;
  let tolerance = 1;
  let shapes: Shape[] = [];
  let canvas: HTMLCanvasElement | null = null;
  let ctx: CanvasRenderingContext2D | null = null;
  let animationFrameId: number | null = null;

  function createCanvas() {
    if (canvas) return;

    canvas = document.createElement('canvas');
    canvas.id = 'simplification-preview-canvas';
    canvas.style.cssText = `
      position: absolute;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      pointer-events: none;
      z-index: 1000;
    `;

    const container = osd.container;
    if (container) {
      container.appendChild(canvas);
    }

    ctx = canvas.getContext('2d');
    resizeCanvas();

    window.addEventListener('resize', resizeCanvas);
  }

  function destroyCanvas() {
    if (animationFrameId !== null) {
      cancelAnimationFrame(animationFrameId);
      animationFrameId = null;
    }

    window.removeEventListener('resize', resizeCanvas);

    if (canvas && canvas.parentNode) {
      canvas.parentNode.removeChild(canvas);
    }
    canvas = null;
    ctx = null;
  }

  function resizeCanvas() {
    if (!canvas) return;

    const container = osd.container;
    if (!container) return;

    const rect = container.getBoundingClientRect();
    canvas.width = rect.width * window.devicePixelRatio;
    canvas.height = rect.height * window.devicePixelRatio;

    if (ctx) {
      ctx.scale(window.devicePixelRatio, window.devicePixelRatio);
    }

    render();
  }

  function render() {
    if (!ctx || !canvas || !enabled) return;

    // Clear canvas
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    if (tolerance <= 1 || shapes.length === 0) {
      // No simplification, nothing to show
      return;
    }

    const simplified = simplifyShapes(shapes, tolerance);

    // Get viewport transform
    const viewport = osd.viewport;
    const containerSize = viewport.getContainerSize();

    ctx.save();
    ctx.globalAlpha = PREVIEW_ALPHA;
    ctx.strokeStyle = PREVIEW_COLOR;
    ctx.fillStyle = PREVIEW_COLOR;
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    for (const shape of simplified) {
      drawShape(ctx, shape, viewport, containerSize);
    }

    ctx.restore();
  }

  function drawShape(
    ctx: CanvasRenderingContext2D,
    shape: Shape,
    viewport: OpenSeadragon.Viewport,
    containerSize: OpenSeadragon.Point
  ) {
    const pos = shape.pos;

    // Convert world coords to pixel coords
    const toPixel = (x: number, y: number): { x: number; y: number } => {
      const point = viewport.viewportToViewerElementCoordinates(
        new OpenSeadragon.Point(x, y)
      );
      return { x: point.x, y: point.y };
    };

    switch (shape.type) {
      case 'path':
      case 'closed_path':
      case 'polygon': {
        if (pos.length < 4) return;

        ctx.beginPath();
        const start = toPixel(pos[0], pos[1]);
        ctx.moveTo(start.x, start.y);

        for (let i = 2; i < pos.length; i += 2) {
          const p = toPixel(pos[i], pos[i + 1]);
          ctx.lineTo(p.x, p.y);
        }

        if (shape.type === 'closed_path' || shape.type === 'polygon') {
          ctx.closePath();
        }
        ctx.stroke();
        break;
      }

      case 'line':
      case 'arrow_line': {
        if (pos.length < 4) return;
        const p1 = toPixel(pos[0], pos[1]);
        const p2 = toPixel(pos[2], pos[3]);

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
        if (pos.length < 4) return;
        const p1 = toPixel(pos[0], pos[1]);
        const p2 = toPixel(pos[2], pos[3]);
        ctx.strokeRect(p1.x, p1.y, p2.x - p1.x, p2.y - p1.y);
        break;
      }

      case 'circle': {
        if (pos.length < 3) return;
        const center = toPixel(pos[0], pos[1]);
        // Radius needs to be scaled
        const radiusPoint = toPixel(pos[0] + pos[2], pos[1]);
        const radius = Math.abs(radiusPoint.x - center.x);

        ctx.beginPath();
        ctx.arc(center.x, center.y, radius, 0, Math.PI * 2);
        ctx.stroke();
        break;
      }

      case 'ellipse': {
        if (pos.length < 4) return;
        const center = toPixel(pos[0], pos[1]);
        const rxPoint = toPixel(pos[0] + pos[2], pos[1]);
        const ryPoint = toPixel(pos[0], pos[1] + pos[3]);
        const rx = Math.abs(rxPoint.x - center.x);
        const ry = Math.abs(ryPoint.y - center.y);

        ctx.beginPath();
        ctx.ellipse(center.x, center.y, rx, ry, 0, 0, Math.PI * 2);
        ctx.stroke();
        break;
      }

      case 'point': {
        if (pos.length < 2) return;
        const p = toPixel(pos[0], pos[1]);
        ctx.beginPath();
        ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
        ctx.fill();
        break;
      }
    }
  }

  function startRenderLoop() {
    const loop = () => {
      render();
      if (enabled) {
        animationFrameId = requestAnimationFrame(loop);
      }
    };
    loop();
  }

  const preview: SimplificationPreview = {
    enable() {
      if (enabled) return;
      enabled = true;
      createCanvas();
      startRenderLoop();
      console.log('[SimplificationPreview] Enabled');
    },

    disable() {
      if (!enabled) return;
      enabled = false;
      destroyCanvas();
      console.log('[SimplificationPreview] Disabled');
    },

    isEnabled() {
      return enabled;
    },

    setTolerance(t: number) {
      tolerance = t;
      console.log(`[SimplificationPreview] Tolerance set to ${t}`);
    },

    getTolerance() {
      return tolerance;
    },

    setShapes(s: Shape[]) {
      shapes = s;
    },

    destroy() {
      this.disable();
    },
  };

  return preview;
}

/**
 * Create the debug slider UI
 * Returns an object with the element and an update function to refresh the status
 */
export function createSimplificationSlider(
  preview: SimplificationPreview,
  getShapes: () => Shape[]
): { element: HTMLElement; updateStatus: () => void } {
  const container = document.createElement('div');
  container.id = 'simplification-debug-panel';
  container.style.cssText = `
    position: fixed;
    bottom: 20px;
    right: 20px;
    background: rgba(0, 0, 0, 0.85);
    color: #fff;
    padding: 16px;
    border-radius: 8px;
    font-family: monospace;
    font-size: 12px;
    z-index: 10001;
    min-width: 280px;
    box-shadow: 0 4px 12px rgba(0,0,0,0.3);
  `;

  const title = document.createElement('div');
  title.textContent = 'Simplification Preview';
  title.style.cssText = 'font-weight: bold; margin-bottom: 12px; color: #ff00ff;';
  container.appendChild(title);

  // Tolerance slider
  const sliderRow = document.createElement('div');
  sliderRow.style.cssText = 'margin-bottom: 8px;';

  const label = document.createElement('label');
  label.textContent = 'Tolerance: ';
  sliderRow.appendChild(label);

  const valueDisplay = document.createElement('span');
  valueDisplay.textContent = '1';
  valueDisplay.style.cssText = 'color: #ff00ff; min-width: 40px; display: inline-block;';

  const slider = document.createElement('input');
  slider.type = 'range';
  slider.min = '0';
  slider.max = '20'; // 2^20 = 1048576
  slider.value = '0';
  slider.style.cssText = 'width: 100%; margin-top: 8px;';

  slider.addEventListener('input', () => {
    const step = parseInt(slider.value, 10);
    const tolerance = step === 0 ? 1 : Math.pow(2, step);
    valueDisplay.textContent = tolerance.toString();
    preview.setTolerance(tolerance);
    preview.setShapes(getShapes());
  });

  sliderRow.appendChild(valueDisplay);
  sliderRow.appendChild(slider);
  container.appendChild(sliderRow);

  // Current encoding status
  const statusRow = document.createElement('div');
  statusRow.style.cssText = 'margin: 12px 0; padding: 8px; background: #222; border-radius: 4px;';

  const statusLabel = document.createElement('div');
  statusLabel.textContent = 'Current URL encoding:';
  statusLabel.style.cssText = 'color: #888; font-size: 11px; margin-bottom: 4px;';
  statusRow.appendChild(statusLabel);

  const statusValue = document.createElement('div');
  statusValue.style.cssText = 'font-size: 13px;';
  statusRow.appendChild(statusValue);

  const updateStatus = () => {
    const shapes = getShapes();
    if (shapes.length === 0) {
      statusValue.innerHTML = '<span style="color: #888;">No shapes</span>';
      return;
    }

    const result = encodeShapesWithInfo(shapes);
    if (!result) {
      statusValue.innerHTML = '<span style="color: #f00;">Encoding failed</span>';
      return;
    }

    const color = result.tolerance > 1 ? '#f90' : '#0f0';
    const status = result.tolerance > 1 ? 'SIMPLIFIED' : 'LOSSLESS';
    statusValue.innerHTML = `
      <span style="color: ${color};">${status}</span>
      <span style="color: #fff;">tolerance: ${result.tolerance}</span>
      <span style="color: #888;">(${result.encoded.length} chars)</span>
    `;
  };

  // Update status initially
  updateStatus();

  container.appendChild(statusRow);

  // Info text
  const info = document.createElement('div');
  info.style.cssText = 'color: #888; font-size: 11px; margin-top: 8px;';
  info.innerHTML = `
    <div style="margin-bottom: 4px; color: #ff00ff;">Magenta = preview at selected tolerance</div>
    <div>Slider: manually preview different tolerances</div>
  `;
  container.appendChild(info);

  // Close button
  const closeBtn = document.createElement('button');
  closeBtn.textContent = '× Close';
  closeBtn.style.cssText = `
    margin-top: 12px;
    padding: 6px 12px;
    background: #333;
    color: #fff;
    border: 1px solid #555;
    border-radius: 4px;
    cursor: pointer;
    width: 100%;
  `;
  closeBtn.addEventListener('click', () => {
    preview.disable();
    container.remove();
  });
  container.appendChild(closeBtn);

  return { element: container, updateStatus };
}
