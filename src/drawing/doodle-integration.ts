/**
 * Doodle Plugin Integration for Noitamap
 *
 * Simple wrapper around @wtsml/doodle that exposes a clean API
 * for the drawing sidebar and storage.
 *
 * Includes coordinate patching to work with noitamap's TopLeft tile offsets.
 */

import { createDoodle } from '@wtsml/doodle';
import type { AppOSD } from '../app_osd';

/**
 * Check if a string is a valid hex color
 */
function isValidHexColor(color: string): boolean {
  return /^#[0-9A-Fa-f]{6}$/.test(color) || /^#[0-9A-Fa-f]{3}$/.test(color);
}

// Shape types supported by doodle
export type ShapeType =
  | 'move'
  | 'rect'
  | 'polygon'
  | 'circle'
  | 'ellipse'
  | 'path'
  | 'closed_path'
  | 'line'
  | 'arrow_line'
  | 'point'
  | 'text';

export interface Shape {
  id: string;
  type: ShapeType;
  pos: number[];
  color: string;
  filled?: boolean;
  readonly?: boolean;
}

export interface DrawingManager {
  enable(): void;
  disable(): void;
  isEnabled(): boolean;
  setTool(tool: ShapeType): void;
  getTool(): ShapeType;
  setColor(color: string): void;
  getColor(): string;
  setStrokeWidth(width: number): void;
  getStrokeWidth(): number;
  setFill(filled: boolean): void;
  getFill(): boolean;
  getShapes(): Shape[];
  loadShapes(shapes: Shape[]): void;
  clearShapes(): void;
  resetShapes(): void; // Clear shapes and history (for map changes)
  setVisibility(visible: boolean): void;
  isVisible(): boolean;
  getCanvas(): HTMLCanvasElement | null;
  extractCanvas(): HTMLCanvasElement | null;
  undo(): void;
  redo(): void;
  canUndo(): boolean;
  canRedo(): boolean;
  onHistoryChange?: (canUndo: boolean, canRedo: boolean) => void;
  deleteSelected(): boolean;
  destroy(): void;
}

/**
 * Creates a drawing manager that wraps the doodle plugin.
 */
export async function createDrawingManager(
  osd: AppOSD,
  callbacks?: {
    onShapeChange?: () => void;
  }
): Promise<DrawingManager> {
  let isEnabled = false;
  let visible = true;
  let currentTool: ShapeType = 'path';
  let currentStrokeWidth = 5;
  let currentColor = '#ffffff';
  let currentFill = false;

  // Undo/redo history
  type HistoryEntry =
    | { type: 'add'; shape: Shape }
    | { type: 'remove'; shape: Shape }
    | { type: 'update'; oldShape: Shape; newShape: Shape }
    | { type: 'clear'; shapes: Shape[] };

  const undoStack: HistoryEntry[] = [];
  const redoStack: HistoryEntry[] = [];
  let isUndoRedoAction = false; // Suppress history recording during undo/redo
  const MAX_HISTORY = 100;

  function pushHistory(entry: HistoryEntry) {
    if (isUndoRedoAction) return;
    undoStack.push(entry);
    if (undoStack.length > MAX_HISTORY) undoStack.shift();
    redoStack.length = 0; // Clear redo stack on new action
    notifyHistoryChange();
  }

  function notifyHistoryChange() {
    manager.onHistoryChange?.(undoStack.length > 0, redoStack.length > 0);
  }

  // Wait for OSD viewer canvas to be ready before initializing doodle
  // The doodle library requires the OSD canvas element to exist
  await new Promise<void>(resolve => {
    let attempts = 0;
    const checkOsdReady = () => {
      const osdCanvas = (osd as any).canvas || osd.element?.querySelector('canvas');
      if (osdCanvas) {
        resolve();
      } else if (attempts > 100) {
        // ~1.6 seconds timeout - continue anyway
        console.warn('[Doodle] OSD canvas not found after timeout, proceeding anyway');
        resolve();
      } else {
        attempts++;
        requestAnimationFrame(checkOsdReady);
      }
    };
    checkOsdReady();
  });

  // Create doodle instance
  const doodle = createDoodle({
    viewer: osd,
    onAdd: (shape: Shape) => {
      // Ensure shape has filled property if set
      if (currentFill) {
        shape.filled = true;
      }
      // Ensure shape has filled property if set
      if (currentFill) {
        shape.filled = true;
      }
      /*
      if (currentFill) {
         // Create a strict clean copy to avoid any internal state issues
         const filledShape = {
            id: shape.id,
            type: shape.type,
            pos: Array.isArray(shape.pos) ? [...shape.pos] : shape.pos,
            color: shape.color,
            filled: true,
            // Copy other potential properties if they exist
            points: (shape as any).points,
            text: (shape as any).text
         };
         // Remove undefined properties
         Object.keys(filledShape).forEach(key => (filledShape as any)[key] === undefined && delete (filledShape as any)[key]);

         doodle.addShapes([filledShape]);
         pushHistory({ type: 'add', shape: filledShape });
      } else {
         doodle.addShape(shape);
         pushHistory({ type: 'add', shape: { ...shape, pos: [...shape.pos] } });
      }
      */
      // Revert to original behavior for now
      doodle.addShape(shape);
      pushHistory({ type: 'add', shape: { ...shape, pos: [...shape.pos] } });

      callbacks?.onShapeChange?.();
    },
    onRemove: (shape: Shape) => {
      // Capture full shape data before removal
      const doodleAny = doodle as any;
      const fullShape = doodleAny.shapes?.find((s: Shape) => s.id === shape.id);
      const captured = fullShape ? { ...fullShape, pos: [...fullShape.pos] } : { ...shape, pos: [...shape.pos] };
      doodle.removeShape(shape);
      pushHistory({ type: 'remove', shape: captured });
      callbacks?.onShapeChange?.();
    },
    onUpdate: (shape: Shape) => {
      // Capture old shape before update
      const doodleAny = doodle as any;
      const oldShape = doodleAny.shapes?.find((s: Shape) => s.id === shape.id);
      const capturedOld = oldShape ? { ...oldShape, pos: [...oldShape.pos] } : null;
      doodle.updateShape(shape);
      if (capturedOld) {
        pushHistory({
          type: 'update',
          oldShape: capturedOld,
          newShape: { ...shape, pos: [...shape.pos] },
        });
      }
      callbacks?.onShapeChange?.();
    },
    onSelect: (_shape: Shape) => {
      // Shape selected
    },
    onCancelSelect: (_shape: Shape) => {
      // Shape deselected
    },
  });

  // Helper to safely apply state
  function applyState() {
    // Only proceed if pixiApp is fully initialized
    const app = doodle.pixiApp;
    // Check if renderer exists before accessing canvas getter
    const hasRenderer = app && (app.renderer || (app as any)._renderer);
    const canvas = hasRenderer ? app.canvas || app.view : null;

    if (!app || !canvas) {
      return;
    }

    if (isEnabled) {
      doodle.setMode(currentTool);
      doodle.setPan(currentTool === 'move');
      // Restore canvas interactivity
      if (canvas) {
        canvas.style.pointerEvents = 'auto';
      }
    } else {
      // Commit any pending move operation before changing mode
      // setMode calls cancelSelectShape() which reverts to original position
      // We need to save the tempShape position first if it was modified
      const doodleAny = doodle as any;
      if (doodleAny.tempShape?.id) {
        const tempShape = doodleAny.tempShape;
        const originalShape = doodleAny.shapes?.find((s: Shape) => s.id === tempShape.id);
        // Check if shape was modified (position changed)
        if (originalShape && JSON.stringify(originalShape) !== JSON.stringify(tempShape)) {
          // Trigger the update callback to save the new position
          doodle.updateShape({ ...tempShape });
          callbacks?.onShapeChange?.();
        }
      }

      doodle.setMode('move');
      doodle.setPan(true);
      // Disable canvas interactivity completely (for view-only mode)
      if (canvas) {
        canvas.style.pointerEvents = 'none';
      }
    }
  }

  // Wait for pixi app to initialize (in background, don't block app load)
  // We don't await this because it can take a few seconds and we want the UI to load immediately.
  // The manager's enable/disable methods are already queue-aware.
  new Promise<void>(resolve => {
    let attempts = 0;
    const checkPixi = () => {
      try {
        // Check for canvas or view to ensure init is complete
        // Pixi v8 uses .canvas, older versions use .view
        // SAFEGUARD: Check renderer first, as accessing .canvas throws if renderer is undefined
        const app = doodle.pixiApp;
        const hasRenderer = app && (app.renderer || (app as any)._renderer);
        const hasCanvas = hasRenderer && (app.canvas || app.view);

        if (app && hasCanvas) {
          applyState(); // Apply initial state
          resolve();
        } else if (attempts > 500) {
          // ~8 seconds timeout
          console.warn('[Doodle] Initialization timed out waiting for canvas');
          resolve();
        } else {
          attempts++;
          requestAnimationFrame(checkPixi);
        }
      } catch (e) {
        console.warn('[Doodle] Error during initialization check:', e);
        if (attempts > 500) {
          resolve();
        } else {
          attempts++;
          requestAnimationFrame(checkPixi);
        }
      }
    };
    checkPixi();
  });

  // Set default color immediately to prevent "Unable to convert color NaN" error
  doodle.setBrushColor('#ffffff');
  doodle.setDefaultColor('#ffffff');

  // Patch coordinate handling for noitamap's TopLeft tile offsets.
  //
  // The doodle's moveHandler uses viewport._viewportToImageDelta() which doesn't
  // work with noitamap's multi-tile setup. In noitamap, viewport coords = world coords.
  //
  // We use property getters on mouse.dx/dy that always return the correct world
  // coordinates based on the current mouse.x/y values.
  const doodleAny = doodle as any;
  const mouse = doodleAny.mouse;

  // Store any values doodle tries to write (to not break its internal state tracking)
  let storedDx = 0;
  let storedDy = 0;

  Object.defineProperty(mouse, 'dx', {
    get: () => {
      // Calculate correct world coordinates from current pixel position
      const viewportPoint = osd.viewport.pointFromPixel(new OpenSeadragon.Point(mouse.x, mouse.y), true);
      return viewportPoint.x;
    },
    set: (val: number) => {
      storedDx = val; // Store but don't use
    },
    configurable: true,
  });

  Object.defineProperty(mouse, 'dy', {
    get: () => {
      const viewportPoint = osd.viewport.pointFromPixel(new OpenSeadragon.Point(mouse.x, mouse.y), true);
      return viewportPoint.y;
    },
    set: (val: number) => {
      storedDy = val;
    },
    configurable: true,
  });

  // Set initial state
  doodle.setMode('path');
  doodle.setPan(true); // Allow panning by default

  const manager: DrawingManager = {
    onHistoryChange: undefined,

    enable() {
      isEnabled = true;
      applyState();
    },

    disable() {
      isEnabled = false;
      applyState();
    },

    isEnabled() {
      return isEnabled;
    },

    setTool(tool: ShapeType) {
      currentTool = tool;
      if (isEnabled) {
        doodle.setMode(tool);
        doodle.setPan(tool === 'move');
      }
    },

    getTool() {
      return currentTool;
    },

    setColor(color: string) {
      currentColor = color;
      doodle.setBrushColor(color);
      doodle.setDefaultColor(color);
      // Ensure fill color matches brush color for filled shapes
      const doodleAny = doodle as any;
      if (doodleAny.setFillColor) {
        doodleAny.setFillColor(color);
      } else {
        doodleAny.fillColor = color;
      }
    },

    getColor(): string {
      return currentColor;
    },

    setStrokeWidth(width: number) {
      currentStrokeWidth = width;
      doodle.strokeWidth = width;
    },

    getStrokeWidth(): number {
      return currentStrokeWidth;
    },

    setFill(filled: boolean) {
      console.log('[DoodleIntegration] setFill called with:', filled);
      currentFill = filled;
      // Try to set doodle property if it exists, or rely on onAdd hook
      // doodle.filled = filled;
      // Assuming we need to handle it ourselves via shape properties
      const doodleAny = doodle as any;
      if (doodleAny.setFilled) {
        doodleAny.setFilled(filled);
      } else {
        doodleAny.filled = filled; // optimistic
      }
    },

    getFill(): boolean {
      return currentFill;
    },

    getShapes(): Shape[] {
      return doodle.getShapes();
    },

    loadShapes(shapes: Shape[]) {
      // Loading shapes resets history
      doodle.clear();
      undoStack.length = 0;
      redoStack.length = 0;
      if (shapes.length > 0) {
        // Sanitize colors - ensure they're valid hex values
        const sanitizedShapes = shapes.map(shape => ({
          ...shape,
          color: isValidHexColor(shape.color) ? shape.color : '#ffffff',
        }));
        doodle.addShapes(sanitizedShapes);
      }
      notifyHistoryChange();
      // Notify that shapes have changed so session/URL can update
      callbacks?.onShapeChange?.();
    },

    clearShapes() {
      const shapes = doodle.getShapes().map((s: Shape) => ({ ...s, pos: [...s.pos] }));
      if (shapes.length > 0) {
        pushHistory({ type: 'clear', shapes });
      }
      doodle.clear();
      callbacks?.onShapeChange?.();
    },

    resetShapes() {
      // Hide the canvas FIRST to prevent any visual flash
      if (doodle.pixiApp?.stage) {
        doodle.pixiApp.stage.visible = false;
        doodle.pixiApp.stage.alpha = 0;
      }

      // Clear shapes AND history - use for map changes
      doodle.clear();
      undoStack.length = 0;
      redoStack.length = 0;

      // Aggressively clear internal state if accessible
      const doodleAny = doodle as any;
      if (Array.isArray(doodleAny.shapes)) {
        doodleAny.shapes = [];
      }
      if (doodleAny.tempShape) {
        doodleAny.tempShape = null;
      }

      // Note: Do NOT call removeChildren() - it destroys the doodle's internal graphics containers
      // and breaks subsequent rendering. doodle.clear() handles clearing shapes properly.

      // Force immediate render of empty stage
      if (doodle.pixiApp?.renderer) {
        doodle.pixiApp.renderer.render(doodle.pixiApp.stage);
      }

      // Restore visibility after a frame so the empty canvas is shown
      // Use two rAF to ensure the cleared render has been committed
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          if (visible && doodle.pixiApp?.stage) {
            doodle.pixiApp.stage.visible = true;
            doodle.pixiApp.stage.alpha = 1;
          }
        });
      });

      notifyHistoryChange();
      callbacks?.onShapeChange?.();
    },

    setVisibility(show: boolean) {
      visible = show;
      if (doodle.pixiApp?.stage) {
        // Set both visible and alpha for better compatibility
        doodle.pixiApp.stage.visible = show;
        doodle.pixiApp.stage.alpha = show ? 1 : 0;
        // Also set renderable to prevent rendering when hidden
        doodle.pixiApp.stage.renderable = show;
      }
    },

    isVisible() {
      return visible;
    },

    getCanvas(): HTMLCanvasElement | null {
      // Pixi 7+ uses 'canvas', older versions use 'view'
      return doodle.pixiApp?.canvas ?? doodle.pixiApp?.view ?? null;
    },

    extractCanvas(): HTMLCanvasElement | null {
      // Try to extract canvas content from Pixi
      // This handles WebGL canvases that can't be directly drawn to 2D context
      const pixiApp = doodle.pixiApp;
      if (!pixiApp) {
        console.log('[Doodle] No pixiApp available');
        return null;
      }

      try {
        // Pixi v7+ uses renderer.extract
        if (pixiApp.renderer?.extract) {
          // Force a render first to make sure everything is drawn
          pixiApp.renderer.render(pixiApp.stage);

          // Extract the stage as a canvas
          const extractedCanvas = pixiApp.renderer.extract.canvas(pixiApp.stage);
          console.log(
            '[Doodle] Extracted canvas from Pixi renderer:',
            extractedCanvas.width,
            'x',
            extractedCanvas.height
          );
          return extractedCanvas as HTMLCanvasElement;
        } else {
          console.log('[Doodle] Pixi renderer.extract not available');
        }
      } catch (e) {
        console.warn('[Doodle] Failed to extract canvas from renderer:', e);
      }

      // Fall back to getting the canvas directly
      const canvas = this.getCanvas();
      console.log('[Doodle] Falling back to direct canvas access');
      return canvas;
    },

    undo() {
      const entry = undoStack.pop();
      if (!entry) return;

      isUndoRedoAction = true;
      try {
        switch (entry.type) {
          case 'add':
            // Undo add = remove the shape
            doodle.removeShape(entry.shape);
            break;
          case 'remove':
            // Undo remove = add the shape back
            doodle.addShape({ ...entry.shape, pos: [...entry.shape.pos] });
            break;
          case 'update':
            // Undo update = restore old shape
            doodle.updateShape({ ...entry.oldShape, pos: [...entry.oldShape.pos] });
            break;
          case 'clear':
            // Undo clear = add all shapes back
            doodle.addShapes(entry.shapes.map(s => ({ ...s, pos: [...s.pos] })));
            break;
        }
        redoStack.push(entry);
        callbacks?.onShapeChange?.();
      } finally {
        isUndoRedoAction = false;
      }
      notifyHistoryChange();
    },

    redo() {
      const entry = redoStack.pop();
      if (!entry) return;

      isUndoRedoAction = true;
      try {
        switch (entry.type) {
          case 'add':
            // Redo add = add the shape
            doodle.addShape({ ...entry.shape, pos: [...entry.shape.pos] });
            break;
          case 'remove':
            // Redo remove = remove the shape
            doodle.removeShape(entry.shape);
            break;
          case 'update':
            // Redo update = apply new shape
            doodle.updateShape({ ...entry.newShape, pos: [...entry.newShape.pos] });
            break;
          case 'clear':
            // Redo clear = clear all shapes
            doodle.clear();
            break;
        }
        undoStack.push(entry);
        callbacks?.onShapeChange?.();
      } finally {
        isUndoRedoAction = false;
      }
      notifyHistoryChange();
    },

    canUndo(): boolean {
      return undoStack.length > 0;
    },

    canRedo(): boolean {
      return redoStack.length > 0;
    },

    deleteSelected(): boolean {
      const doodleAny = doodle as any;
      if (doodleAny.tempShape?.id) {
        // Use doodle's onRemove which will trigger our history recording
        const shape = { ...doodleAny.tempShape };
        doodleAny.conf.onRemove?.(shape);
        return true;
      }
      return false;
    },

    destroy() {
      doodle.destroy();
    },
  };

  return manager;
}
