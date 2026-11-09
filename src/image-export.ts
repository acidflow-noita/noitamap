/** Browser image helpers shared by Magic Screenshot and result cards. */
export function loadExportImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    const finish = (error?: Error) => {
      clearTimeout(timeout);
      image.onload = image.onerror = null;
      if (error) { image.src = ''; reject(error); }
      else resolve(image);
    };
    const timeout = setTimeout(() => finish(new Error('Image loading timed out')), 15_000);
    image.crossOrigin = 'anonymous';
    image.onload = () => finish();
    image.onerror = () => finish(new Error('Could not load export artwork'));
    image.src = src;
  });
}

export function canvasToBlob(canvas: HTMLCanvasElement, type: 'image/png' | 'image/webp', quality?: number): Promise<Blob | null> {
  return new Promise(resolve => canvas.toBlob(resolve, type, quality));
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.download = filename;
  link.href = url;
  document.body.append(link);
  try { link.click(); }
  finally {
    link.remove();
    // Give the browser time to consume the URL, including Safari's save flow.
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
}
