import { LIQUID_MAX_FRAME_PIXELS } from './geometry';

type SnapshotCanvas = HTMLCanvasElement | OffscreenCanvas;
type BitmapFactory = (source: SnapshotCanvas) => Promise<ImageBitmap>;

/** Materialize the crop before making a bitmap. A cropped ImageBitmap can
 * retain a larger backing surface; it must not determine a WebGL upload size.
 * The scratch surface is bounded and reused only when the map image changes. */
export class LiquidSnapshot {
  private canvas?: SnapshotCanvas;
  private context?: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
  private busy = false;
  private destroyed = false;
  constructor(
    private createCanvas: () => SnapshotCanvas = () => document.createElement('canvas'),
    private bitmap: BitmapFactory = source => createImageBitmap(source, {
      premultiplyAlpha: 'none', colorSpaceConversion: 'none',
    }),
  ) {}
  async capture(source: SnapshotCanvas, x: number, y: number, width: number, height: number,
    renderWidth = width, renderHeight = height): Promise<ImageBitmap> {
    if (this.destroyed) throw new DOMException('Liquid snapshot disposed', 'AbortError');
    if (this.busy) throw new Error('A liquid snapshot is already being captured');
    if (![x, y, width, height, renderWidth, renderHeight].every(Number.isSafeInteger) || x < 0 || y < 0 ||
      renderWidth < 1 || renderHeight < 1 || renderWidth > width || renderHeight > height ||
      x + width > source.width || y + height > source.height || renderWidth * renderHeight > LIQUID_MAX_FRAME_PIXELS)
      throw new RangeError('Invalid liquid snapshot crop');
    this.busy = true;
    try {
      const canvas = this.canvas ??= this.createCanvas();
      if (canvas.width !== renderWidth) canvas.width = renderWidth;
      if (canvas.height !== renderHeight) canvas.height = renderHeight;
      this.context ??= canvas.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | undefined;
      if (!this.context) throw new Error('Liquid snapshot canvas is unavailable');
      const context = this.context;
      context.setTransform(1, 0, 0, 1, 0, 0);
      context.imageSmoothingEnabled = false;
      context.globalCompositeOperation = 'copy';
      // This synchronous copy also freezes a WebGL drawer before its backing
      // buffer can be cleared by presentation. No crop metadata is left over.
      context.drawImage(source, x, y, width, height, 0, 0, renderWidth, renderHeight);
      const bitmap = await this.bitmap(canvas);
      if (this.destroyed) { bitmap.close(); throw new DOMException('Liquid snapshot disposed', 'AbortError'); }
      if (bitmap.width !== renderWidth || bitmap.height !== renderHeight) {
        bitmap.close(); throw new Error('Liquid snapshot dimensions do not match the crop');
      }
      return bitmap;
    } finally { this.busy = false; }
  }
  destroy() {
    this.destroyed = true;
    if (this.canvas) this.canvas.width = this.canvas.height = 1;
    this.canvas = undefined; this.context = undefined;
  }
}
