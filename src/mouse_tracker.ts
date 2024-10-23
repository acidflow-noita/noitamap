import { CHUNK_SIZE } from './constants';

export type MouseTrackerOptions = {
  osd: OpenSeadragon.Viewer;
  tooltipElement: HTMLElement;
  osdElement: HTMLElement;
};
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
};
