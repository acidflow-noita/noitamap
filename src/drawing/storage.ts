/**
 * Drawing Storage - IndexedDB wrapper for persisting drawings
 *
 * Uses the 'idb' library for a cleaner Promise-based API.
 */

import { openDB, DBSchema, IDBPDatabase } from 'idb';
import type { Shape } from './doodle-integration';
import { debounce } from '../util';
import i18next from '../i18n';

const DB_NAME = 'noitamap-drawings';
const DB_VERSION = 1;
const STORE_NAME = 'drawings';

export interface StoredDrawing {
  id: string;
  map_name: string;
  name: string;
  x: number;
  y: number;
  zoom: number;
  shapes: Shape[];
  created_at: number;
  updated_at: number;
}

interface DrawingDB extends DBSchema {
  drawings: {
    key: string;
    value: StoredDrawing;
    indexes: {
      'by-map': string;
      'by-updated': number;
    };
  };
}

let dbPromise: Promise<IDBPDatabase<DrawingDB>> | null = null;

/**
 * Get or create the database connection
 */
async function getDB(): Promise<IDBPDatabase<DrawingDB>> {
  if (!dbPromise) {
    dbPromise = openDB<DrawingDB>(DB_NAME, DB_VERSION, {
      upgrade(db) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' });
        store.createIndex('by-map', 'map_name');
        store.createIndex('by-updated', 'updated_at');
      },
    });
  }
  return dbPromise;
}

/**
 * Save a drawing to IndexedDB
 */
export async function saveDrawing(drawing: StoredDrawing): Promise<void> {
  const db = await getDB();
  await db.put(STORE_NAME, drawing);
}

/**
 * Get a drawing by ID
 */
export async function getDrawing(id: string): Promise<StoredDrawing | undefined> {
  const db = await getDB();
  return db.get(STORE_NAME, id);
}

/**
 * Get all drawings for a specific map
 */
export async function getDrawingsForMap(mapName: string): Promise<StoredDrawing[]> {
  const db = await getDB();
  return db.getAllFromIndex(STORE_NAME, 'by-map', mapName);
}

/**
 * Get all drawings, sorted by last updated
 */
export async function getAllDrawings(): Promise<StoredDrawing[]> {
  const db = await getDB();
  const drawings = await db.getAll(STORE_NAME);
  return drawings.sort((a, b) => b.updated_at - a.updated_at);
}

/**
 * Delete a drawing by ID
 */
export async function deleteDrawing(id: string): Promise<void> {
  const db = await getDB();
  await db.delete(STORE_NAME, id);
}

/**
 * Clear all drawings for a specific map
 */
export async function clearDrawingsForMap(mapName: string): Promise<void> {
  const db = await getDB();
  const drawings = await db.getAllFromIndex(STORE_NAME, 'by-map', mapName);
  const tx = db.transaction(STORE_NAME, 'readwrite');
  await Promise.all([...drawings.map(d => tx.store.delete(d.id)), tx.done]);
}

/**
 * Generate a unique ID for a new drawing
 */
export function generateDrawingId(): string {
  return crypto.randomUUID();
}

/**
 * Create a new drawing object
 */
export function createDrawing(
  mapName: string,
  shapes: Shape[],
  viewport: { x: number; y: number; zoom: number },
  name?: string
): StoredDrawing {
  const now = Date.now();
  return {
    id: generateDrawingId(),
    map_name: mapName,
    name: name || `__default__:${now}`,
    x: viewport.x,
    y: viewport.y,
    zoom: viewport.zoom,
    shapes,
    created_at: now,
    updated_at: now,
  };
}

/**
 * Drawing session manager - handles auto-save and current drawing state
 */
export class DrawingSession {
  private currentDrawing: StoredDrawing | null = null;
  private mapName: string;
  private onSave?: (drawing: StoredDrawing) => void;
  private debouncedSave: () => void;
  private sessionId: string; // Single ID for the entire session

  constructor(
    mapName: string,
    options?: {
      autoSaveDelay?: number;
      onSave?: (drawing: StoredDrawing) => void;
    }
  ) {
    this.mapName = mapName;
    this.onSave = options?.onSave;
    this.sessionId = generateDrawingId(); // Generate one ID for this session

    // Create debounced save function using existing debounce utility
    // Short delay (500ms) to save after drawing/editing actions complete
    const delay = options?.autoSaveDelay ?? 500;
    this.debouncedSave = debounce(delay, () => {
      this.save();
    });
  }

  /**
   * Get the current drawing
   */
  getCurrent(): StoredDrawing | null {
    return this.currentDrawing;
  }

  /**
   * Get the current map name
   */
  getMapName(): string {
    return this.mapName;
  }

  /**
   * Check if there's an active drawing
   */
  hasDrawing(): boolean {
    return this.currentDrawing !== null && this.currentDrawing.shapes.length > 0;
  }

  /**
   * Start a new drawing session
   */
  newDrawing(viewport: { x: number; y: number; zoom: number }): StoredDrawing {
    this.sessionId = generateDrawingId(); // New ID for new drawing
    this.currentDrawing = createDrawing(this.mapName, [], viewport);
    this.currentDrawing.id = this.sessionId;
    return this.currentDrawing;
  }

  /**
   * Load an existing drawing
   */
  async loadDrawing(id: string): Promise<StoredDrawing | null> {
    const drawing = await getDrawing(id);
    if (drawing) {
      this.currentDrawing = drawing;
      this.sessionId = drawing.id; // Use the loaded drawing's ID
    }
    return drawing ?? null;
  }

  /**
   * Update shapes in the current drawing (triggers auto-save)
   */
  updateShapes(shapes: Shape[], viewport?: { x: number; y: number; zoom: number }): void {
    if (!this.currentDrawing) {
      // Create drawing with the session's ID (reuses same ID for entire session)
      const now = Date.now();
      this.currentDrawing = {
        id: this.sessionId,
        map_name: this.mapName,
        name: `__default__:${now}`,
        x: viewport?.x ?? 0,
        y: viewport?.y ?? 0,
        zoom: viewport?.zoom ?? 1,
        shapes,
        created_at: now,
        updated_at: now,
      };
    } else {
      this.currentDrawing.shapes = shapes;
      this.currentDrawing.updated_at = Date.now();
      if (viewport) {
        this.currentDrawing.x = viewport.x;
        this.currentDrawing.y = viewport.y;
        this.currentDrawing.zoom = viewport.zoom;
      }
    }

    // Trigger debounced auto-save
    this.debouncedSave();
  }

  /**
   * Update the drawing name
   */
  setName(name: string): void {
    if (this.currentDrawing) {
      this.currentDrawing.name = name;
      this.currentDrawing.updated_at = Date.now();
    }
  }

  /**
   * Immediately save the current drawing
   */
  async save(): Promise<StoredDrawing | null> {
    if (!this.currentDrawing) return null;

    // If shapes are empty, delete the drawing from storage instead of saving
    if (this.currentDrawing.shapes.length === 0) {
      await deleteDrawing(this.currentDrawing.id);
      return null;
    }

    await saveDrawing(this.currentDrawing);
    this.onSave?.(this.currentDrawing);
    return this.currentDrawing;
  }

  /**
   * Clear the current drawing session (doesn't delete from storage)
   */
  clear(): void {
    this.currentDrawing = null;
    this.sessionId = generateDrawingId(); // Fresh ID for next drawing
  }

  /**
   * Delete the current drawing from storage and clear session
   */
  async delete(): Promise<void> {
    if (this.currentDrawing) {
      await deleteDrawing(this.currentDrawing.id);
      this.currentDrawing = null;
      this.sessionId = generateDrawingId(); // Fresh ID for next drawing
    }
  }

  /**
   * Change the map (clears current drawing)
   */
  setMap(mapName: string): void {
    this.mapName = mapName;
    this.currentDrawing = null;
    this.sessionId = generateDrawingId(); // Fresh ID for new map
  }

  /**
   * Get all saved drawings for current map
   */
  async getSavedDrawings(): Promise<StoredDrawing[]> {
    return getDrawingsForMap(this.mapName);
  }
}

/**
 * Export drawing data for URL encoding
 */
export function exportDrawingData(drawing: StoredDrawing): {
  shapes: Shape[];
  viewport: { x: number; y: number; zoom: number };
} {
  return {
    shapes: drawing.shapes,
    viewport: {
      x: drawing.x,
      y: drawing.y,
      zoom: drawing.zoom,
    },
  };
}

/**
 * Import drawing data from URL
 */
export function importDrawingData(
  mapName: string,
  data: {
    shapes: Shape[];
    viewport?: { x: number; y: number; zoom: number };
  }
): StoredDrawing {
  const viewport = data.viewport ?? { x: 0, y: 0, zoom: 1 };
  return createDrawing(mapName, data.shapes, viewport, i18next.t('drawing.savedDrawings.sharedName'));
}
