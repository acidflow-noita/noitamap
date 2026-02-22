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

  /**
   * Hooks exposed by the public noitamap app for the pro bundle to consume.
   * The pro bundle receives this via `window.__noitamap` after the main app initializes.
   */
  interface NoitamapProHooks {
    /** OpenSeadragon viewer instance */
    osd: OpenSeadragon.Viewer;
    /** The DOM element that contains the OSD viewer */
    osdElement: HTMLElement;
    /** Get current map name */
    getMap: () => string;
    /** Switch to a different map */
    setMap: (mapName: string) => Promise<void>;
    /** Update the drawing param in the URL */
    updateURLWithDrawing: (encoded: string | null) => void;
    /** Update the sidebar open/closed state in the URL */
    updateURLWithSidebar: (open: boolean) => void;
    /** The URL state parsed at page load (drawing param, sidebar state, etc.) */
    urlState: { drawing?: string; sidebarOpen?: boolean };
    /** Set the current map in unified search (so search results match after map change) */
    setSearchMap: (mapName: string) => void;
    /** Callback when map changes (so pro code can reset drawing state) */
    onMapChange: (callback: (mapName: string) => void) => void;
    /** Get enabled overlays for share URL */
    getEnabledOverlays: () => string[];
    /** Map overlay key to short param */
    overlayToShort: (key: string) => string;
  }

  interface Window {
    __noitamap?: NoitamapProHooks;
  }
}

declare module '*.png' {
  const value: string;
  export default value;
}

declare module '*.jpg' {
  const value: string;
  export default value;
}

declare module '*.jpeg' {
  const value: string;
  export default value;
}

declare module '*.gif' {
  const value: string;
  export default value;
}

declare module '*.webp' {
  const value: string;
  export default value;
}

declare module '*.svg' {
  const value: string;
  export default value;
}
