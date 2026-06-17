import { CHUNK_SIZE } from './constants';
import { materialAtWorld, primeMaterialHover } from './material-hover';

declare const OpenSeadragon: any;

export type MouseTrackerOptions = {
  osd: any; // OpenSeadragon.Viewer
  tooltipElement: HTMLElement;
  osdElement: HTMLElement;
};

// Function to parse coordinates
function parseCoordinates(text: string) {
  const match = text.match(/^\((-?\d+),\s*(-?\d+)\)/);
  if (match) {
    const x = parseInt(match[1], 10);
    const y = parseInt(match[2], 10);
    return JSON.stringify({ x: x, y: y });
  }
  return null;
}

export const initMouseTracker = ({ osd, tooltipElement, osdElement }: MouseTrackerOptions) => {
  primeMaterialHover();
  let lastPixelX: number | null = null;
  let lastPixelY: number | null = null;
  let lastMaterialHtml = '';
  new OpenSeadragon.MouseTracker({
    element: osdElement,
    moveHandler: (event: any) => {
      if (event.pointerType != 'mouse') return;

      const webPoint = event.position;
      const viewportPoint = osd.viewport.pointFromPixel(webPoint);
      const px = Math.floor(viewportPoint.x);
      const py = Math.floor(viewportPoint.y);
      const pixelX = px.toString();
      const pixelY = py.toString();
      const chunkX = Math.floor(viewportPoint.x / CHUNK_SIZE).toString();
      const chunkY = Math.floor(viewportPoint.y / CHUNK_SIZE).toString();
      // Material lookup is dynamic-map only (baked maps ship no per-pixel
      // material buffers). Recompute only when the integer coord changes.
      if (px !== lastPixelX || py !== lastPixelY) {
        lastPixelX = px;
        lastPixelY = py;
        const mat = materialAtWorld(px, py);
        lastMaterialHtml = mat ? `<br>material: ${mat}` : '';
      }
      tooltipElement.children[0].innerHTML = `(${pixelX}, ${pixelY})<br>chunk: (${chunkX}, ${chunkY})${lastMaterialHtml}`;
      tooltipElement.style.left = `${event.originalEvent.pageX}px`;
      tooltipElement.style.top = `${event.originalEvent.pageY}px`;
    },
    enterHandler: (event: any) => {
      if (event.pointerType !== 'mouse') return;
      tooltipElement.style.visibility = 'visible';
    },
    leaveHandler: (event: any) => {
      if (event.pointerType !== 'mouse') return;
      tooltipElement.style.visibility = 'hidden';
    },
  }).setTracking(true);

  const copyCoordinates = async (event: KeyboardEvent) => {
    if (event.target instanceof HTMLInputElement) return;
    if (tooltipElement.style.visibility === 'hidden') return;
    if (event.code !== 'KeyC' || (!event.ctrlKey && !event.metaKey)) return;

    const coordinatesText = tooltipElement.innerText;
    const parsedCoordinates = parseCoordinates(coordinatesText);
    if (!parsedCoordinates) {
      console.error('Could not parse coordinates');
      return;
    }

    try {
      await navigator.clipboard.writeText(parsedCoordinates);
      console.log('Coordinates copied to clipboard:', parsedCoordinates);
    } catch (err) {
      console.error('Could not copy coordinates:', err);
    }
  };

  return { copyCoordinates };
};
