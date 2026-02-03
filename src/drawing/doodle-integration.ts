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
  text?: string;
  fontSize?: number;
  strokeWidth?: number;
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
  setFontSize(size: number): void;
  getFontSize(): number;
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
  // let currentFill = false; // Disabled
  let currentFontSize = 16;

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

  // Text shapes are stored separately since doodle doesn't support them
  let textShapes: Shape[] = [];

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
      // if (currentFill) {
      //   shape.filled = true;
      // }

      // Ensure shape has strokeWidth property
      if (!shape.strokeWidth) {
        shape.strokeWidth = currentStrokeWidth;
      }

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
      if (currentTool === 'text') {
         doodle.setMode('move');
         doodle.setPan(true);
      } else {
         doodle.setMode(currentTool);
         doodle.setPan(currentTool === 'move');
      }
      // Restore canvas interactivity
      if (canvas) {
        canvas.style.pointerEvents = 'auto';
      }
    } else {
      const doodleAny = doodle as any;
      if (doodleAny.tempShape?.id) {
        const tempShape = doodleAny.tempShape;
        const originalShape = doodleAny.shapes?.find((s: Shape) => s.id === tempShape.id);
        if (originalShape && JSON.stringify(originalShape) !== JSON.stringify(tempShape)) {
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

  // Wait for pixi app to initialize
  new Promise<void>(resolve => {
    let attempts = 0;
    const checkPixi = () => {
      try {
        const app = doodle.pixiApp;
        const hasRenderer = app && (app.renderer || (app as any)._renderer);
        const hasCanvas = hasRenderer && (app.canvas || app.view);

        if (app && hasCanvas) {
          applyState(); // Apply initial state
          resolve();
        } else if (attempts > 500) {
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

  // Set default color
  doodle.setBrushColor('#ffffff');
  doodle.setDefaultColor('#ffffff');

  // Patch coordinate handling
  const doodleAny = doodle as any;
  const mouse = doodleAny.mouse;

  let storedDx = 0;
  let storedDy = 0;

  Object.defineProperty(mouse, 'dx', {
    get: () => {
      const viewportPoint = osd.viewport.pointFromPixel(new OpenSeadragon.Point(mouse.x, mouse.y), true);
      return viewportPoint.x;
    },
    set: (val: number) => {
      storedDx = val;
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

  doodle.setMode('path');
  doodle.setPan(true);

  // --- Text Tool Implementation ---

  // Manager for DOM overlays (text input)
  class OverlaysManager {
    private activeContainer: HTMLDivElement | null = null;
    private activeInput: HTMLTextAreaElement | null = null;
    private onCommit: ((text: string) => void) | null = null;
    private onCancel: (() => void) | null = null;

    showInput(
      x: number,
      y: number,
      initialText: string = '',
      fontSize: number,
      onCommit: (t: string) => void,
      onCancel: () => void
    ) {
      this.closeInput();

      this.onCommit = onCommit;
      this.onCancel = onCancel;

      // Container for input and controls
      const container = document.createElement('div');
      Object.assign(container.style, {
        position: 'absolute',
        left: `${x}px`,
        top: `${y}px`,
        zIndex: '10000',
        display: 'flex',
        flexDirection: 'column',
        gap: '4px',
      });

      const input = document.createElement('textarea');
      input.value = initialText;
      input.className = 'doodle-text-input';
      Object.assign(input.style, {
        minWidth: '200px',
        minHeight: '100px',
        fontSize: '16px', // UI size
        fontFamily: 'Inter, sans-serif',
        background: 'rgba(0, 0, 0, 0.8)',
        color: 'white',
        border: '1px solid #9146FF',
        borderRadius: '4px',
        padding: '8px',
        resize: 'both',
        outline: 'none',
      });

      input.addEventListener('keydown', e => {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          this.commit();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          this.cancel();
        }
        e.stopPropagation();
      });

      input.addEventListener('keyup', e => e.stopPropagation());
      input.addEventListener('keypress', e => e.stopPropagation());

      // Controls
      const controls = document.createElement('div');
      Object.assign(controls.style, {
        display: 'flex',
        gap: '4px',
        justifyContent: 'flex-end',
      });

      const createBtn = (iconClass: string, colorClass: string, onClick: () => void, title: string) => {
        const btn = document.createElement('button');
        btn.className = `btn btn-sm ${colorClass}`;
        btn.innerHTML = `<i class="${iconClass}"></i>`;
        btn.title = title;
        Object.assign(btn.style, {
          padding: '2px 8px',
        });
        btn.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          onClick();
        });
        btn.addEventListener('mousedown', (e) => e.stopPropagation()); // Prevent OSD drag
        return btn;
      };

      const cancelBtn = createBtn('bi bi-x-lg', 'btn-danger', () => this.cancel(), 'Cancel (Esc)');
      const confirmBtn = createBtn('bi bi-check-lg', 'btn-success', () => this.commit(), 'Confirm (Ctrl+Enter)');

      controls.appendChild(cancelBtn);
      controls.appendChild(confirmBtn);

      container.appendChild(input);
      container.appendChild(controls);
      document.body.appendChild(container);
      
      input.focus();
      this.activeInput = input;
      this.activeContainer = container;

      // Click outside to commit? optional, but maybe safer to rely on buttons/keys now
      // input.addEventListener('blur', () => {
      //   this.commit();
      // });
    }

    commit() {
      if (this.activeInput && this.onCommit) {
        const text = this.activeInput.value.trim();
        if (text) {
          this.onCommit(text);
        } else {
          this.onCancel?.();
        }
      }
      this.closeInput();
    }

    cancel() {
      this.onCancel?.();
      this.closeInput();
    }

    closeInput() {
      if (this.activeContainer) {
        this.activeContainer.remove();
        this.activeContainer = null;
        this.activeInput = null;
      }
      this.onCommit = null;
      this.onCancel = null;
    }
  }

  const overlays = new OverlaysManager();

  // DOM-based Text Renderer
  class TextRenderer {
    private container: HTMLDivElement;
    private textMap: Map<string, HTMLDivElement> = new Map();
    private osdViewer: AppOSD;

    constructor(viewer: AppOSD) {
      this.osdViewer = viewer;
      this.container = document.createElement('div');
      this.container.className = 'doodle-text-layer';
      Object.assign(this.container.style, {
        position: 'absolute',
        top: '0',
        left: '0',
        width: '100%',
        height: '100%',
        pointerEvents: 'none', // Allow clicks to pass through to map
        zIndex: '2000', // Above map and overlays
        overflow: 'hidden'
      });
      
      // Append directly to viewer element to ensure it's on top of OSD canvas/overlays
      viewer.element.appendChild(this.container);
      
      // Update positions on zoom/pan
      viewer.addHandler('animation', () => this.updatePositions());
      viewer.addHandler('open', () => this.updatePositions());
    }

    sync(shapes: Shape[]) {
      const currentIds = new Set<string>();

      shapes.forEach(shape => {
        if (shape.type === 'text' && shape.text) {
          currentIds.add(shape.id);
          let textEl = this.textMap.get(shape.id);

          if (!textEl) {
            textEl = document.createElement('div');
            textEl.className = 'doodle-text-label';
            textEl.style.position = 'absolute';
            textEl.style.pointerEvents = 'auto'; // allow selection/interaction if needed
            textEl.style.whiteSpace = 'pre';
            textEl.style.textShadow = '0 0 4px #000';
            this.container.appendChild(textEl);
            this.textMap.set(shape.id, textEl);
          }

          textEl.textContent = shape.text;
          textEl.style.fontFamily = 'Inter, sans-serif';
          textEl.style.fontSize = `${shape.fontSize || 16}px`;
          textEl.style.color = shape.color || '#ffffff';
          
          // Store world position on element for updatePositions
          textEl.dataset.worldX = String(shape.pos[0]);
          textEl.dataset.worldY = String(shape.pos[1]);
        }
      });

      // Remove Old
      for (const [id, el] of this.textMap) {
        if (!currentIds.has(id)) {
          el.remove();
          this.textMap.delete(id);
        }
      }
      
      this.updatePositions();
    }
    
    updatePositions() {
        if (!this.textMap.size) return;
        
        const viewport = this.osdViewer.viewport;
        
        this.textMap.forEach((el) => {
            const x = parseFloat(el.dataset.worldX || '0');
            const y = parseFloat(el.dataset.worldY || '0');
            const pixel = viewport.viewportToViewerElementCoordinates(
                new OpenSeadragon.Point(x, y)
            );
            
            // Text position
            el.style.left = `${pixel.x}px`;
            el.style.top = `${pixel.y}px`;
            
            // Text scale
            // Use Fixed Screen Size (scale 1) to ensure text remains readable/visible 
            // regardless of zoom level. Scaling with the map (Fixed World Size) caused 
            // text to become invisible when zoomed out.
            el.style.transformOrigin = 'top left';
            el.style.transform = 'scale(1)';
        });
    }

    clear() {
        this.container.innerHTML = '';
        this.textMap.clear();
    }
    
    setVisible(visible: boolean) {
        this.container.style.display = visible ? 'block' : 'none';
    }
  }

  let textRenderer: TextRenderer | null = null;
  // Initialize TextRenderer
  const initTextRenderer = () => {
    if (!textRenderer) {
      textRenderer = new TextRenderer(osd);
    }
  };

  // Add click handler for text tool
  osd.addHandler('canvas-click', (event: any) => {
    if (!isEnabled || currentTool !== 'text') return;
    if (event.quick) {
      event.preventDefaultAction = true;

      const viewportPoint = osd.viewport.pointFromPixel(event.position);
      const webPoint = event.position; // Screen pixel

      overlays.showInput(
        webPoint.x,
        webPoint.y,
        '',
        currentFontSize,
        text => {
          // Create Shape
          const shape: Shape = {
            id: crypto.randomUUID(),
            type: 'text',
            text: text,
            fontSize: currentFontSize,
            color: currentColor,
            pos: [viewportPoint.x, viewportPoint.y],
            filled: true,
            strokeWidth: 0, // Text doesn't use stroke width
          };
          // Text shapes are stored separately
          textShapes.push(shape);
          pushHistory({ type: 'add', shape: { ...shape, pos: [...shape.pos] } });
          
          initTextRenderer();
          textRenderer?.sync(textShapes);
          callbacks?.onShapeChange?.();
        },
        () => { /* cancel */ }
      );
    }
  });

  const manager: DrawingManager = {
    onHistoryChange: undefined,

    enable() {
      isEnabled = true;
      applyState();
      textRenderer?.setVisible(true);
    },

    disable() {
      isEnabled = false;
      applyState();
      // textRenderer?.setVisible(false); // Keep text visible even if drawing disabled? Usually yes.
    },

    isEnabled() {
      return isEnabled;
    },

    setTool(tool: ShapeType) {
      currentTool = tool;
      if (isEnabled) {
        if (tool === 'text') {
          doodle.setMode('move');
          doodle.setPan(true);
        } else {
          doodle.setMode(tool);
          doodle.setPan(tool === 'move');
        }
      }
    },

    getTool() {
      return currentTool;
    },

    setColor(color: string) {
      currentColor = color;
      doodle.setBrushColor(color);
      doodle.setDefaultColor(color);
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
      // Disabled
      // console.log('[DoodleIntegration] setFill called with:', filled);
      // currentFill = filled;
    },

    getFill(): boolean {
      return false; // currentFill;
    },

    setFontSize(size: number) {
      currentFontSize = size;
    },

    getFontSize(): number {
      return currentFontSize;
    },

    getShapes(): Shape[] {
      return [...doodle.getShapes(), ...textShapes];
    },

    loadShapes(shapes: Shape[]) {
      doodle.clear();
      undoStack.length = 0;
      redoStack.length = 0;
      textShapes = [];
      let skippedCount = 0;

      if (shapes.length > 0) {
        const doodleShapes: Shape[] = [];
        const allowedDoodleTypes = new Set([
          'rect',
          'polygon',
          'circle',
          'ellipse',
          'path',
          'closed_path',
          'line',
          'arrow_line',
          'point',
        ]);

        for (const shape of shapes) {
          const sanitizedShape = {
            ...shape,
            color: isValidHexColor(shape.color) ? shape.color : '#ffffff',
            strokeWidth: shape.strokeWidth || 5,
          };

          const coordLimit = 500000;
          if (
            !sanitizedShape.pos ||
            !Array.isArray(sanitizedShape.pos) ||
            sanitizedShape.pos.some(n => !Number.isFinite(n) || Math.abs(n) > coordLimit)
          ) {
            console.warn('[Doodle] Skipping invalid shape:', sanitizedShape.id);
            skippedCount++;
            continue;
          }

          if (sanitizedShape.type === 'text') {
            textShapes.push(sanitizedShape);
            continue;
          }

          if (!allowedDoodleTypes.has(sanitizedShape.type)) {
            skippedCount++;
            continue;
          }

          if (
            (sanitizedShape.type === 'path' ||
              sanitizedShape.type === 'closed_path' ||
              sanitizedShape.type === 'polygon') &&
            sanitizedShape.pos.length < 4
          ) {
            skippedCount++;
            continue;
          }

          doodleShapes.push(sanitizedShape);
        }

        if (doodleShapes.length > 0) {
          try {
            doodle.addShapes(doodleShapes);
          } catch (e) {
            console.error('[Doodle] Error adding shapes:', e);
          }
        }
      }

      if (skippedCount > 0) {
        window.dispatchEvent(new CustomEvent('drawing-shapes-skipped', { detail: { count: skippedCount } }));
      }

      notifyHistoryChange();
      callbacks?.onShapeChange?.();

      initTextRenderer();
      textRenderer?.sync(textShapes);
    },

    clearShapes() {
      const shapes = [...doodle.getShapes(), ...textShapes];
      if (shapes.length > 0) {
        // Deep copy shapes for history
        const deepShapes = shapes.map(s => ({ ...s, pos: [...s.pos] }));
        pushHistory({ type: 'clear', shapes: deepShapes });
      }
      doodle.clear();
      textShapes = [];
      callbacks?.onShapeChange?.();
      textRenderer?.sync([]);
    },

    resetShapes() {
      if (doodle.pixiApp?.stage) {
        doodle.pixiApp.stage.visible = false;
        doodle.pixiApp.stage.alpha = 0;
      }

      doodle.clear();
      undoStack.length = 0;
      redoStack.length = 0;
      textShapes = [];

      const doodleAny = doodle as any;
      if (Array.isArray(doodleAny.shapes)) {
        doodleAny.shapes = [];
      }
      if (doodleAny.tempShape) {
        doodleAny.tempShape = null;
      }

      if (doodle.pixiApp?.renderer) {
        doodle.pixiApp.renderer.render(doodle.pixiApp.stage);
      }

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
      textRenderer?.sync([]);
    },

    setVisibility(show: boolean) {
      visible = show;
      if (doodle.pixiApp?.stage) {
        doodle.pixiApp.stage.visible = show;
        doodle.pixiApp.stage.alpha = show ? 1 : 0;
        doodle.pixiApp.stage.renderable = show;
      }
      textRenderer?.setVisible(show);
    },

    isVisible() {
      return visible;
    },

    getCanvas(): HTMLCanvasElement | null {
      return doodle.pixiApp?.canvas ?? doodle.pixiApp?.view ?? null;
    },

    extractCanvas(): HTMLCanvasElement | null {
      const pixiApp = doodle.pixiApp;
      if (!pixiApp) return null;

      try {
        if (pixiApp.renderer?.extract) {
          pixiApp.renderer.render(pixiApp.stage);
          return pixiApp.renderer.extract.canvas(pixiApp.stage) as HTMLCanvasElement;
        }
      } catch (e) {
        console.warn('[Doodle] Failed to extract canvas:', e);
      }
      return this.getCanvas();
    },

    undo() {
      const entry = undoStack.pop();
      if (!entry) return;

      isUndoRedoAction = true;
      try {
        switch (entry.type) {
          case 'add':
            if (entry.shape.type === 'text') {
              const idx = textShapes.findIndex(s => s.id === entry.shape.id);
              if (idx !== -1) textShapes.splice(idx, 1);
            } else {
              doodle.removeShape(entry.shape);
            }
            break;
          case 'remove':
            if (entry.shape.type === 'text') {
               textShapes.push({ ...entry.shape, pos: [...entry.shape.pos] });
            } else {
               doodle.addShape({ ...entry.shape, pos: [...entry.shape.pos] });
            }
            break;
          case 'update':
            if (entry.oldShape.type === 'text') {
               const idx = textShapes.findIndex(s => s.id === entry.oldShape.id);
               if (idx !== -1) textShapes[idx] = { ...entry.oldShape, pos: [...entry.oldShape.pos] };
            } else {
               doodle.updateShape({ ...entry.oldShape, pos: [...entry.oldShape.pos] });
            }
            break;
          case 'clear':
            const textToRestore = entry.shapes.filter(s => s.type === 'text');
            const doodleToRestore = entry.shapes.filter(s => s.type !== 'text');
            
            textShapes.push(...textToRestore.map(s => ({ ...s, pos: [...s.pos] })));
            doodle.addShapes(doodleToRestore.map(s => ({ ...s, pos: [...s.pos] })));
            break;
        }
        redoStack.push(entry);
        callbacks?.onShapeChange?.();

        initTextRenderer();
        textRenderer?.sync(textShapes);
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
            if (entry.shape.type === 'text') {
                textShapes.push({ ...entry.shape, pos: [...entry.shape.pos] });
            } else {
                doodle.addShape({ ...entry.shape, pos: [...entry.shape.pos] });
            }
            break;
          case 'remove':
            if (entry.shape.type === 'text') {
                const idx = textShapes.findIndex(s => s.id === entry.shape.id);
                if (idx !== -1) textShapes.splice(idx, 1);
            } else {
                doodle.removeShape(entry.shape);
            }
            break;
          case 'update':
            if (entry.newShape.type === 'text') {
                const idx = textShapes.findIndex(s => s.id === entry.newShape.id);
                if (idx !== -1) textShapes[idx] = { ...entry.newShape, pos: [...entry.newShape.pos] };
            } else {
                doodle.updateShape({ ...entry.newShape, pos: [...entry.newShape.pos] });
            }
            break;
          case 'clear':
            doodle.clear();
            textShapes = [];
            break;
        }
        undoStack.push(entry);
        callbacks?.onShapeChange?.();

        initTextRenderer();
        textRenderer?.sync(textShapes);
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
        const shape = { ...doodleAny.tempShape };
        doodleAny.conf.onRemove?.(shape);
        return true;
      }
      return false;
    },

    destroy() {
      doodle.destroy();
      overlays.closeInput();
      if (textRenderer) {
         textRenderer.clear();
         textRenderer = null;
      }
    },
  };
  
  return manager;
}