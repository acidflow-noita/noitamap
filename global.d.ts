import type OSD from 'openseadragon';
import type EEventEmitter2 from 'eventemitter2';
import FFlexSearch from 'flexsearch';
import type { IndexOptionsForDocumentSearch } from 'flexsearch';
import bbootstrap from 'bootstrap';

declare global {
  export const bootstrap = bbootstrap;

  export namespace FlexSearch {
    export type Document = FFlexSearch.Document<any, any>;
  }
  export const FlexSearch = {
    Document: FFlexSearch.Document as any,
  };

  export const EventEmitter2 = EEventEmitter2;

  export namespace OpenSeadragon {
    export const enum SUBPIXEL_ROUNDING_OCCURRENCES {
      NEVER = 0,
      ONLY_AT_REST = 1,
      ALWAYS = 2,
    }

    export interface Options extends OSD.Options {
      drawer?: string;
      subPixelRoundingForTransparency?: number;
    }

    export class Viewer extends OSD.Viewer {}
    export class TileSource extends OSD.TileSource {}
    export class Point extends OSD.Point {}
    export class Rect extends OSD.Rect {}
    export class MouseTracker extends OSD.MouseTracker {}
    export type DziTileSource = OSD.DziTileSource;
    export type TiledImage = OSD.TiledImage;
    export type EventHandler<T> = OSD.EventHandler<T>;
    export type AddItemWorldEvent = OSD.AddItemWorldEvent;
    export type Viewport = OSD.Viewport;
  }
}
