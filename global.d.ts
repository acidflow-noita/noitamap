import type OSD from 'openseadragon';
import type EEventEmitter2 from 'eventemitter2';
import FFlexSearch from 'flexsearch';
import type { IndexOptionsForDocumentSearch } from 'flexsearch';
import bbootstrap from 'bootstrap';

declare global {
  export const bootstrap = bbootstrap;

  export namespace FlexSearch {
    export type Document = FFlexSearch.Document;
  }
  export const FlexSearch = {
    Document: DocumentFactory,
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
  }
}
