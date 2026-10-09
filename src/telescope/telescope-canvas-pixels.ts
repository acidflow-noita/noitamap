/** The legacy biome encoder can use its own pristine pixels without changing
 * browser canvas APIs or copying unrelated map, drawing and portal surfaces. */
export function putTelescopeImageData(
  context: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  pixels: ImageData,
): void {
  context.putImageData(pixels, 0, 0);
  (context.canvas as any).__noitamap_rawImageData = new ImageData(
    new Uint8ClampedArray(pixels.data), pixels.width, pixels.height,
  );
}
