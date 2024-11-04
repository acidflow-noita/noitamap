import { CHUNK_SIZE } from './constants';

export type MouseTrackerOptions = {
  osd: OpenSeadragon.Viewer;
  tooltipElement: HTMLElement;
  osdElement: HTMLElement;
};

// Function to parse coordinates
function parseCoordinates(text: string) {
  // Updated regex to match the first pair of coordinates
  const match = text.match(/^\((-?\d+),\s*(-?\d+)\)/);
  if (match) {
    const x = parseInt(match[1], 10);
    const y = parseInt(match[2], 10);
    return JSON.stringify({ x: x, y: y });
  }
  return null;
}

export const initMouseTracker = ({ osd, tooltipElement, osdElement }: MouseTrackerOptions) => {
  // Mouse tracker for displaying coordinates
  new OpenSeadragon.MouseTracker({
    element: osdElement,
    // @types/openseadragon does not appear to define the events
    moveHandler: (event: any) => {
      if (event.pointerType != 'mouse') return;

      const webPoint = event.position;
      const viewportPoint = osd.viewport.pointFromPixel(webPoint);
      const pixelX = Math.floor(viewportPoint.x).toString();
      const pixelY = Math.floor(viewportPoint.y).toString();
      const chunkX = Math.floor(viewportPoint.x / CHUNK_SIZE).toString();
      const chunkY = Math.floor(viewportPoint.y / CHUNK_SIZE).toString();
      tooltipElement.children[0].innerHTML = `(${pixelX}, ${pixelY})<br>chunk: (${chunkX}, ${chunkY})`;
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
    // dev only copy option which can be enabled in the browser console
    // if (!localStorage.enableCopyCoordinates) return;
    if (event.target instanceof HTMLInputElement) return;
    if (tooltipElement.style.visibility === 'hidden') return;
    if (event.code !== 'KeyC' || (!event.ctrlKey && !event.metaKey)) return;

    // Read the latest coordinates text from tooltipElement
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
