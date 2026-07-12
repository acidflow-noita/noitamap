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
    /** Initialized i18next instance (shared so the pro bundle doesn't need its own) */
    i18next: typeof import('i18next').default;
    /** Live auth service instance from the main app */
    authService: typeof import('./src/auth/auth-service').authService;
    /** OpenSeadragon viewer instance */
    osd: OpenSeadragon.Viewer;
    /** The DOM element that contains the OSD viewer */
    osdElement: HTMLElement;
    /** Get current map name */
    getMap: () => string;
    /** Switch to a different map */
    setMap: (mapName: string) => Promise<void>;
    /** Update the sidebar open/closed state in the URL */
    updateURLWithSidebar: (open: boolean) => void;
    /** The URL state parsed at page load (sidebar state, canvas, etc.) */
    urlState: { sidebarOpen?: boolean; canvas?: 'map' | 'black' | 'white'; seed?: number };
    /** Get active seed params */
    getSeedParams: () => { seed?: number; isDaily?: boolean };
    /** Set active seed active params */
    setSeedParams: (seed: number) => void;
    /** Set the canvas background and update URL */
    setBackground: (type: 'map' | 'black' | 'white') => void;
    /** Set the current map in unified search (so search results match after map change) */
    setSearchMap: (mapName: string) => void;
    /** Callback when map changes (so pro code can reset drawing state) */
    onMapChange: (callback: (mapName: string) => void) => void;
    /** Get enabled overlays for share URL */
    getEnabledOverlays: () => string[];
    /** Map overlay key to short param */
    overlayToShort: (key: string) => string;
    /** Toggle an overlay on/off and update URL */
    showOverlay: (key: string, show: boolean) => void;
    /** Drop overlay element (set by drop-overlay.ts) */
    dropOverlay?: HTMLElement;
    /** Reset drag counter and overlay state (set by drop-overlay.ts) */
    resetDragState?: () => void;
    /** Pro handler for importing a drawing file (set by pro bundle) */
    handleImportDrop?: (file: File) => Promise<void>;
    /** Pro handler for vectorizing a dropped image (set by pro bundle) */
    handleVectorizeDrop?: (file: File) => Promise<void>;
    /** Get the current dynamic map POIs (empty on static maps) */
    getDynamicPOIs: () => Array<{
      id: string; type: string; item?: string; name?: string;
      worldX: number; worldY: number; material?: string; items?: any[];
      [key: string]: any;
    }>;
    /** Current spoiler-free state */
    isSpoilerFree: () => boolean;
    /** Current light-mode (main-world-only) state */
    isLightMode: () => boolean;
    /** Toggle alchemy-mode — suppresses search result refreshes while a recipe is rendered. */
    setAlchemyActive: (active: boolean) => void;
    /** Current dynamic-POI indexing state: idle / indexing / ready. */
    getIndexingState: () => "idle" | "indexing" | "ready";
    /** Subscribe to dynamic-POI indexing state changes. */
    onIndexingStateChange: (cb: (state: "idle" | "indexing" | "ready") => void) => void;
    /**
     * Look up a material entry from FULL_MATERIALS_FINAL.json (Noita's
     * material dump). Returns null if the JSON isn't loaded yet or the id
     * isn't known. Call `primeMaterialInfo()` once beforehand to warm the
     * cache asynchronously.
     */
    getMaterialInfo: (id: string) => null | {
      id: string;
      ui_name?: string;
      name_translation_placeholder?: string;
      cell_type?: string;
      graphics?: { color?: string | null; [k: string]: any };
      wang_color?: string | null;
      [k: string]: any;
    };
    /** Preload FULL_MATERIALS_FINAL.json into the in-memory cache. */
    primeMaterialInfo: () => Promise<void>;
    /** Subscribe to spoiler-free toggle changes */
    onSpoilerFreeChange: (cb: (enabled: boolean) => void) => void;
    /** Request the pro bundle to be loaded (set by main app) */
    requestProLoad?: () => Promise<boolean>;
    /** Handle AP/LC recipe request — set by pro bundle after init. Pass null to clear. */
    handleAlchemyRecipe?: (kind: "ap" | "lc" | null) => void;
    /**
     * Install / clear the high-value highlight predicate. When a function is
     * passed, matching POIs get a cyan ring DOM overlay around them. Pass null
     * to remove all rings.
     */
    setHighValuePredicate: (pred: ((poi: any) => boolean) | null) => void;
    /** Toggle the high-value filter — set by pro bundle after init. */
    handleHighValueToggle?: (active: boolean) => void;
    /** High-value predicate — set by pro bundle after init. Drives BOTH map highlight and search filter. */
    isHighValuePOI?: (poi: any) => boolean;
    /** Open or close the Seed Report sidebar — set by pro bundle after init. */
    handleSeedReportToggle?: (open: boolean) => void;
    /** Open the telescope tooltip ("POI card") for a dynamic POI by id. */
    openPOIById?: (poiId: string, opts?: { sidebarRightPx?: number }) => void;
    /** Show the "Get Pro" auth modal (lives in main bundle, exposed for pro bundle). */
    showGetProModal?: () => void;
    /** Unfiltered POI list (preserves creatures regardless of perf toggle). */
    getAllDynamicPOIs?: () => Array<{ id: string; type: string; [k: string]: any }>;
    /** Cache-only POI lookup for a given seed (used by seed-report comparison). */
    getFlatPOIsForSeed?: (seed: number) => Promise<any[] | null>;
    /** Background-generate + cache a seed so getFlatPOIsForSeed hits next time. */
    requestSeedStats?: (seed: number) => Promise<boolean>;
    /** Blob URL for a wand's sprite (first frame) — pro seed-report wand icons. */
    getWandIconUrl?: (sprite: string) => Promise<string | null>;
    /** "Skip creatures" perf-mode flag. */
    isSkipCreatures?: () => boolean;
    /**
     * Populate the unified search bar and run the query (used by pillar segment
     * cards whose "find one of N things" links search instead of flying to a
     * single POI). When `note` is passed and the query finds nothing on the
     * rendered map, the results overlay shows a seeded Telescope fallback link.
     */
    triggerPillarSearch?: (query: string, note?: { text: string; telescopeUrl: string }, filter?: string, resultNotice?: string) => void;
  }

  interface Window {
    __noitamap?: NoitamapProHooks;
  }

  const __BUILD_VERSION__: string;

  interface CSSStyleDeclaration {
    webkitTextSecurity?: string;
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
