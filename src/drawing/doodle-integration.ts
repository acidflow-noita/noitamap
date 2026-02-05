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
import { debounce } from '../util';

/**
 * Check if a string is a valid hex color
 */
function isValidHexColor(color: string): boolean {
  return /^#[0-9A-Fa-f]{6}$/.test(color) || /^#[0-9A-Fa-f]{3}$/.test(color);
}

/**
 * Convert HTML from contenteditable to plain text with newlines
 */
function htmlToText(html: string): string {
  // Replace <br> and <div>/ <p> tags with newlines
  let text = html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<div>/gi, '')
    .replace(/<\/p>/gi, '\n')
    .replace(/<p>/gi, '');

  // Decode basic HTML entities
  const temp = document.createElement('div');
  temp.innerHTML = text;
  text = temp.textContent || '';

  return text.trim();
}

/**
 * Convert plain text with newlines to HTML for contenteditable
 */
function textToHtml(text: string): string {
  return (text || '').replace(/\n/g, '<br>');
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
  width?: number;
}

export type TextZoomStrategyType = 'fixed-screen' | 'fixed-world' | 'hybrid';

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
  setTextZoomStrategy(strategy: TextZoomStrategyType): void;
  getTextZoomStrategy(): TextZoomStrategyType;
}

/**
 * Creates a drawing manager that wraps the doodle plugin.
 */
export async function createDrawingManager(
  osd: AppOSD,
  callbacks?: {
    onShapeChange?: () => void;
    onToolChange?: (tool: ShapeType) => void;
    onTextSelect?: (shape: Shape | null) => void;
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

  // Text zoom strategy
  let textZoomStrategy: TextZoomStrategyType = 'fixed-screen';

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

  // DOM-based Text Renderer with edit/move support
  class TextRenderer {
    private container: HTMLDivElement;
    private textMap: Map<string, HTMLDivElement> = new Map();
    private osdViewer: AppOSD;
    private selectedId: string | null = null;
    private isDragging = false;
    private dragStartPos: { x: number; y: number } | null = null;
    private dragStartWorld: { x: number; y: number } | null = null;
    private onRequestToolChange: (tool: ShapeType) => void;
    private onTextSelect: (shape: Shape | null) => void;

    // Inline editing state
    private editingId: string | null = null;
    private editOriginalText: string = '';
    private editHandlers: {
      keydown: (e: KeyboardEvent) => void;
      blur: (e: FocusEvent) => void;
      input: (e: Event) => void;
    } | null = null;

    constructor(
      viewer: AppOSD,
      onRequestToolChange: (tool: ShapeType) => void,
      onTextSelect: (shape: Shape | null) => void
    ) {
      this.osdViewer = viewer;
      this.onRequestToolChange = onRequestToolChange;
      this.onTextSelect = onTextSelect;
      this.container = document.createElement('div');
      this.container.className = 'doodle-text-layer';
      Object.assign(this.container.style, {
        position: 'absolute',
        top: '0',
        left: '0',
        width: '100%',
        height: '100%',
        pointerEvents: 'none',
        zIndex: '2000',
        overflow: 'hidden',
      });

      viewer.element.appendChild(this.container);

      // Update positions on zoom/pan
      viewer.addHandler('animation', () => this.updatePositions());
      viewer.addHandler('open', () => this.updatePositions());

      // Global mouse move/up for dragging
      document.addEventListener('mousemove', this.onMouseMove.bind(this));
      document.addEventListener('mouseup', this.onMouseUp.bind(this));
    }

    private onMouseMove(e: MouseEvent) {
      if (!this.isDragging || !this.dragStartPos || !this.dragStartWorld || !this.selectedId) return;

      const dx = e.clientX - this.dragStartPos.x;
      const dy = e.clientY - this.dragStartPos.y;

      // Convert pixel delta to viewport delta using OSD API for accuracy
      const viewportDelta = this.osdViewer.viewport.deltaPointsFromPixels(new OpenSeadragon.Point(dx, dy));

      const newX = this.dragStartWorld.x + viewportDelta.x;
      const newY = this.dragStartWorld.y + viewportDelta.y;

      // Update the text element position directly for visual feedback
      const el = this.textMap.get(this.selectedId);
      if (el) {
        el.dataset.worldX = String(newX);
        el.dataset.worldY = String(newY);
        this.updatePositions();
      }
    }

    private onMouseUp(_e: MouseEvent) {
      if (this.isDragging && this.selectedId) {
        // Commit the move to the shape
        const el = this.textMap.get(this.selectedId);
        if (el) {
          const newX = parseFloat(el.dataset.worldX || '0');
          const newY = parseFloat(el.dataset.worldY || '0');

          // Find and update the shape
          const shapeIndex = textShapes.findIndex(s => s.id === this.selectedId);
          if (shapeIndex !== -1) {
            const oldShape = { ...textShapes[shapeIndex], pos: [...textShapes[shapeIndex].pos] };
            textShapes[shapeIndex].pos = [newX, newY];
            const newShape = { ...textShapes[shapeIndex], pos: [...textShapes[shapeIndex].pos] };
            pushHistory({ type: 'update', oldShape, newShape });
            callbacks?.onShapeChange?.();
          }
        }
      }
      this.isDragging = false;
      this.dragStartPos = null;
      this.dragStartWorld = null;
    }

    private setupTextElement(textEl: HTMLDivElement, shapeId: string) {
      textEl.style.cursor = 'move';
      textEl.style.resize = 'horizontal';
      textEl.style.overflow = 'hidden';
      textEl.style.minWidth = '50px';

      // Resize observer to catch width changes
      const ro = new ResizeObserver(entries => {
        if (!isEnabled || this.isDragging) return;
        for (const entry of entries) {
          const newWidth = entry.contentRect.width;
          const shape = textShapes.find(s => s.id === shapeId);
          if (shape && Math.abs((shape.width || 0) - newWidth) > 1) {
            shape.width = newWidth;
            callbacks?.onShapeChange?.();
          }
        }
      });
      ro.observe(textEl);

      // Click to select
      textEl.addEventListener('mousedown', e => {
        if (!isEnabled) return;
        // Don't start drag/select if we are already editing this element
        if (this.editingId === shapeId) return;

        // NEW: Don't allow selecting other shapes if we are editing something else
        if (this.editingId && this.editingId !== shapeId) {
          e.stopPropagation();
          e.preventDefault();
          return;
        }

        // Don't start drag if clicking on the resize handle (bottom-right area)
        const rect = textEl.getBoundingClientRect();
        if (e.clientX > rect.right - 15 && e.clientY > rect.bottom - 15) {
          return;
        }

        e.stopPropagation();
        e.preventDefault();

        // Activate text tool if not already
        this.onRequestToolChange('text');

        this.selectText(shapeId);

        // Start drag
        this.isDragging = true;
        this.dragStartPos = { x: e.clientX, y: e.clientY };
        this.dragStartWorld = {
          x: parseFloat(textEl.dataset.worldX || '0'),
          y: parseFloat(textEl.dataset.worldY || '0'),
        };
      });

      // Double-click to edit
      textEl.addEventListener('dblclick', e => {
        if (!isEnabled) return;
        e.stopPropagation();
        e.preventDefault();

        // Use inline editing
        this.enterEditMode(shapeId, false);
      });
    }

    selectText(id: string | null) {
      // Deselect previous
      if (this.selectedId) {
        const prevEl = this.textMap.get(this.selectedId);
        if (prevEl) {
          prevEl.style.outline = 'none';
        }
      }

      this.selectedId = id;

      // Select new
      if (id) {
        const el = this.textMap.get(id);
        if (el) {
          el.style.outline = '2px dashed #ffffff';
          el.style.outlineOffset = '2px';
        }
        // Notify about the selected shape
        const shape = textShapes.find(s => s.id === id);
        this.onTextSelect(shape || null);
      } else {
        this.onTextSelect(null);
      }
    }

    getSelectedId(): string | null {
      return this.selectedId;
    }

    updateSelected(updates: Partial<Shape>) {
      if (!this.selectedId) return;

      const idx = textShapes.findIndex(s => s.id === this.selectedId);
      if (idx !== -1) {
        const oldShape = { ...textShapes[idx], pos: [...textShapes[idx].pos] };

        // Apply updates
        Object.assign(textShapes[idx], updates);

        const newShape = { ...textShapes[idx], pos: [...textShapes[idx].pos] };

        // Only push history if something actually changed
        if (JSON.stringify(oldShape) !== JSON.stringify(newShape)) {
          pushHistory({ type: 'update', oldShape, newShape });
          callbacks?.onShapeChange?.();
          this.sync(textShapes);
        }
      }
    }

    deleteSelected(): boolean {
      if (!this.selectedId) return false;

      const index = textShapes.findIndex(s => s.id === this.selectedId);
      if (index !== -1) {
        const removed = textShapes.splice(index, 1)[0];
        pushHistory({ type: 'remove', shape: { ...removed, pos: [...removed.pos] } });
        this.sync(textShapes);
        this.selectedId = null;
        callbacks?.onShapeChange?.();
        return true;
      }
      return false;
    }

    isEditing(): boolean {
      return this.editingId !== null;
    }

    getEditingId(): string | null {
      return this.editingId;
    }

    enterEditMode(shapeId: string, isNewShape: boolean = false) {
      // Exit any current edit first
      if (this.editingId) {
        this.exitEditMode(true);
      }

      const textEl = this.textMap.get(shapeId);
      const shape = textShapes.find(s => s.id === shapeId);
      if (!textEl || !shape) return;

      // Ensure the shape is selected so sidebar controls update IT and not a previous selection
      this.selectText(shapeId);

      this.editingId = shapeId;
      this.editOriginalText = shape.text || '';

      // NEW: Set class on container to allow CSS to block doodle interactions
      this.container.classList.add('doodle-text-editing');

      // Make contenteditable
      textEl.contentEditable = 'true';
      textEl.style.outline = '2px dashed #ffffff';
      textEl.style.outlineOffset = '2px';
      textEl.style.cursor = 'text';
      textEl.style.minWidth = '50px';
      textEl.style.minHeight = '1em';
      textEl.style.backgroundColor = 'rgba(0, 0, 0, 0.5)';
      textEl.style.padding = '4px';
      textEl.style.borderRadius = '2px';

      // Focus and select all
      textEl.focus();
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(textEl);
      selection?.removeAllRanges();
      selection?.addRange(range);

      // Event handlers
      const keydownHandler = (e: KeyboardEvent) => {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          e.stopPropagation();
          this.exitEditMode(true);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          this.exitEditMode(false);
        }
        // Stop propagation for all keys while editing to prevent OSD shortcuts
        e.stopPropagation();
      };

      const blurHandler = debounce(150, (currentShapeId: string) => {
        if (this.editingId === currentShapeId) {
          // If focus moved to a "safe" sidebar control, don't exit edit mode
          const activeEl = document.activeElement;
          if (activeEl && (activeEl.closest('#color-section') || activeEl.closest('#text-controls'))) {
            // Re-focus the text element to allow continued typing
            textEl.focus();
            return;
          }
          this.exitEditMode(true);
        }
      });

      const inputHandler = () => {
        // Update shape text in real-time for visual feedback
        // Use helper to handle various newline formats from different browsers
        const newText = htmlToText(textEl.innerHTML);
        shape.text = newText;
      };

      const blurWrapper = () => blurHandler(shapeId);

      textEl.addEventListener('keydown', keydownHandler);
      textEl.addEventListener('blur', blurWrapper);
      textEl.addEventListener('input', inputHandler);

      this.editHandlers = { keydown: keydownHandler, blur: blurWrapper, input: inputHandler };

      // Store whether this is a new shape for potential cleanup
      textEl.dataset.isNewShape = isNewShape ? 'true' : 'false';
    }

    exitEditMode(save: boolean) {
      if (!this.editingId) return;

      const textEl = this.textMap.get(this.editingId);
      const shape = textShapes.find(s => s.id === this.editingId);
      const shapeId = this.editingId;
      const isNewShape = textEl?.dataset.isNewShape === 'true';

      if (textEl && this.editHandlers) {
        textEl.removeEventListener('keydown', this.editHandlers.keydown);
        textEl.removeEventListener('blur', this.editHandlers.blur);
        textEl.removeEventListener('input', this.editHandlers.input);
      }

      if (textEl) {
        textEl.contentEditable = 'false';
        textEl.style.cursor = 'move';
        textEl.style.backgroundColor = 'transparent';
        textEl.style.padding = '0';
        delete textEl.dataset.isNewShape;
      }

      if (save && shape) {
        // Use helper to preserve line breaks correctly
        const newText = htmlToText(textEl?.innerHTML || '');

        if (newText) {
          // Save the text
          if (isNewShape) {
            // For new shapes, the add history was already pushed, just update text
            shape.text = newText;
          } else if (newText !== this.editOriginalText) {
            // For existing shapes, push update history if changed
            const oldShape = { ...shape, pos: [...shape.pos], text: this.editOriginalText };
            shape.text = newText;
            const newShape = { ...shape, pos: [...shape.pos] };
            pushHistory({ type: 'update', oldShape, newShape });
          }
          callbacks?.onShapeChange?.();
        } else {
          // Empty text - remove the shape
          const index = textShapes.findIndex(s => s.id === shapeId);
          if (index !== -1) {
            const removed = textShapes.splice(index, 1)[0];
            if (!isNewShape) {
              // Only push history for existing shapes
              pushHistory({ type: 'remove', shape: { ...removed, pos: [...removed.pos] } });
            } else {
              // For new shapes, remove the add history entry
              const lastEntry = undoStack[undoStack.length - 1];
              if (lastEntry && lastEntry.type === 'add' && lastEntry.shape.id === shapeId) {
                undoStack.pop();
                notifyHistoryChange();
              }
            }
            callbacks?.onShapeChange?.();
          }
        }
      } else if (!save) {
        // Cancel - restore original
        if (shape) {
          shape.text = this.editOriginalText;
        }
        if (isNewShape) {
          // For new shapes that are cancelled, remove them
          const index = textShapes.findIndex(s => s.id === shapeId);
          if (index !== -1) {
            textShapes.splice(index, 1);
            // Remove the add history entry
            const lastEntry = undoStack[undoStack.length - 1];
            if (lastEntry && lastEntry.type === 'add' && lastEntry.shape.id === shapeId) {
              undoStack.pop();
              notifyHistoryChange();
            }
          }
        }
      }

      this.editingId = null;
      this.editOriginalText = '';
      this.editHandlers = null;

      // NEW: Remove class from container
      this.container.classList.remove('doodle-text-editing');

      // Re-sync to update display
      this.sync(textShapes);
    }

    sync(shapes: Shape[]) {
      const currentIds = new Set<string>();

      shapes.forEach(shape => {
        // Allow empty text for shapes being created/edited
        if (shape.type === 'text') {
          currentIds.add(shape.id);
          let textEl = this.textMap.get(shape.id);

          if (!textEl) {
            textEl = document.createElement('div');
            textEl.className = 'doodle-text-label';
            textEl.style.position = 'absolute';
            textEl.style.pointerEvents = 'auto';
            textEl.style.whiteSpace = 'pre-wrap';
            textEl.style.wordBreak = 'break-word';
            textEl.style.textShadow = '0 0 4px #000';
            textEl.dataset.shapeId = shape.id;
            this.container.appendChild(textEl);
            this.textMap.set(shape.id, textEl);
            this.setupTextElement(textEl, shape.id);
          }

          // Don't update content if this element is currently being edited
          if (this.editingId !== shape.id) {
            textEl.innerHTML = textToHtml(shape.text || '');
          }
          textEl.style.fontFamily = 'Inter, sans-serif';
          textEl.style.fontSize = `${shape.fontSize || 16}px`;
          textEl.style.color = shape.color || '#ffffff';
          textEl.dataset.worldX = String(shape.pos[0]);
          textEl.dataset.worldY = String(shape.pos[1]);
          textEl.dataset.baseFontSize = String(shape.fontSize || 16);

          if (shape.width) {
            textEl.style.width = `${shape.width}px`;
          } else {
            textEl.style.width = 'auto';
          }

          // Restore selection outline if selected (but not editing)
          if (shape.id === this.selectedId && this.editingId !== shape.id) {
            textEl.style.outline = '2px dashed #ffffff';
            textEl.style.outlineOffset = '2px';
          } else if (this.editingId !== shape.id) {
            textEl.style.outline = 'none';
          }
        }
      });

      // Remove old
      for (const [id, el] of this.textMap) {
        if (!currentIds.has(id)) {
          el.remove();
          this.textMap.delete(id);
          if (this.selectedId === id) {
            this.selectedId = null;
          }
        }
      }

      this.updatePositions();
    }

    updatePositions() {
      if (!this.textMap.size) return;

      const viewport = this.osdViewer.viewport;
      const zoom = viewport.getZoom(true);

      this.textMap.forEach(el => {
        const x = parseFloat(el.dataset.worldX || '0');
        const y = parseFloat(el.dataset.worldY || '0');
        const baseFontSize = parseFloat(el.dataset.baseFontSize || '16');
        const pixel = viewport.viewportToViewerElementCoordinates(new OpenSeadragon.Point(x, y));

        el.style.left = `${pixel.x}px`;
        el.style.top = `${pixel.y}px`;
        el.style.transformOrigin = 'top left';

        // Apply zoom strategy
        switch (textZoomStrategy) {
          case 'fixed-screen':
            // Text stays same screen size regardless of zoom
            el.style.transform = 'scale(1)';
            el.style.fontSize = `${baseFontSize}px`;
            break;
          case 'fixed-world':
            // Text scales with the map (like other shapes)
            el.style.transform = `scale(${zoom})`;
            el.style.fontSize = `${baseFontSize}px`;
            break;
          case 'hybrid':
            // Clamp scale between 0.5 and 2 for readability
            const clampedScale = Math.max(0.5, Math.min(2, zoom));
            el.style.transform = `scale(${clampedScale})`;
            el.style.fontSize = `${baseFontSize}px`;
            break;
        }
      });
    }

    clear() {
      this.container.innerHTML = '';
      this.textMap.clear();
      this.selectedId = null;
    }

    setVisible(visible: boolean) {
      this.container.style.display = visible ? 'block' : 'none';
    }
  }

  let textRenderer: TextRenderer | null = null;

  // Forward declaration of setTool logic for internal use
  const setToolInternal = (tool: ShapeType) => {
    // Exit any active text edit before switching tools
    if (textRenderer?.isEditing()) {
      textRenderer.exitEditMode(true);
    }

    currentTool = tool;
    if (isEnabled) {
      if (tool === 'text') {
        doodle.setMode('move');
        doodle.setPan(true);
        // Clear text selection when switching TO text tool (avoids updating previous shape)
        textRenderer?.selectText(null);
      } else {
        doodle.setMode(tool);
        doodle.setPan(tool === 'move');
        // Clear text selection when switching to non-text tool
        textRenderer?.selectText(null);
      }
    }
    callbacks?.onToolChange?.(tool);
  };

  // Initialize TextRenderer
  const initTextRenderer = () => {
    if (!textRenderer) {
      textRenderer = new TextRenderer(
        osd,
        tool => setToolInternal(tool),
        shape => callbacks?.onTextSelect?.(shape)
      );
    }
  };

  // --- Text Tool Drag-to-Define-Area Implementation ---

  // Preview rectangle for text area definition
  let textPreviewRect: HTMLDivElement | null = null;
  let textDragState: {
    isDragging: boolean;
    startPixel: { x: number; y: number };
    startViewport: { x: number; y: number };
  } | null = null;

  const createTextPreviewRect = () => {
    if (textPreviewRect) return textPreviewRect;

    const rect = document.createElement('div');
    Object.assign(rect.style, {
      position: 'absolute',
      border: '2px dashed #ffffff',
      backgroundColor: 'rgba(255, 255, 255, 0.1)',
      pointerEvents: 'none',
      zIndex: '9999',
      display: 'none',
    });
    osd.element.appendChild(rect);
    textPreviewRect = rect;
    return rect;
  };

  const updateTextPreviewRect = (startX: number, startY: number, currentX: number, currentY: number) => {
    const rect = createTextPreviewRect();
    const left = Math.min(startX, currentX);
    const top = Math.min(startY, currentY);
    const width = Math.abs(currentX - startX);
    const height = Math.abs(currentY - startY);

    Object.assign(rect.style, {
      left: `${left}px`,
      top: `${top}px`,
      width: `${width}px`,
      height: `${height}px`,
      display: 'block',
    });
  };

  const hideTextPreviewRect = () => {
    if (textPreviewRect) {
      textPreviewRect.style.display = 'none';
    }
  };

  const completeTextPlacement = (
    startPixel: { x: number; y: number },
    endPixel: { x: number; y: number },
    startViewport: { x: number; y: number }
  ) => {
    const width = Math.abs(endPixel.x - startPixel.x);
    const height = Math.abs(endPixel.y - startPixel.y);
    const minX = Math.min(startPixel.x, endPixel.x);
    const minY = Math.min(startPixel.y, endPixel.y);

    // If user dragged to create a region (min 50px in either dimension), use that size
    const hasDraggedArea = width > 50 || height > 50;
    const textWidth = hasDraggedArea ? Math.max(width, 100) : undefined;

    // Use top-left corner of the rectangle for position
    const placementX = hasDraggedArea ? minX : startPixel.x;
    const placementY = hasDraggedArea ? minY : startPixel.y;

    // Convert placement pixel to viewport coordinates
    const placementViewport = hasDraggedArea
      ? osd.viewport.pointFromPixel(new OpenSeadragon.Point(placementX, placementY))
      : { x: startViewport.x, y: startViewport.y };

    // Create Shape immediately with empty text
    const shape: Shape = {
      id: crypto.randomUUID(),
      type: 'text',
      text: '', // Start empty, will be filled via inline editing
      fontSize: currentFontSize,
      color: currentColor,
      pos: [placementViewport.x, placementViewport.y],
      filled: true,
      strokeWidth: 0,
      width: textWidth,
    };
    textShapes.push(shape);
    pushHistory({ type: 'add', shape: { ...shape, pos: [...shape.pos] } });

    initTextRenderer();
    textRenderer?.sync(textShapes);

    // Enter edit mode on the new element (use requestAnimationFrame to ensure DOM is ready)
    requestAnimationFrame(() => {
      textRenderer?.enterEditMode(shape.id, true);
    });
  };

  // Add drag handlers for text tool
  osd.addHandler('canvas-press', (event: any) => {
    if (!isEnabled || currentTool !== 'text') return;

    event.preventDefaultAction = true;

    const viewportPoint = osd.viewport.pointFromPixel(event.position);
    textDragState = {
      isDragging: true,
      startPixel: { x: event.position.x, y: event.position.y },
      startViewport: { x: viewportPoint.x, y: viewportPoint.y },
    };
  });

  osd.addHandler('canvas-drag', (event: any) => {
    if (!isEnabled || currentTool !== 'text' || !textDragState?.isDragging) return;

    event.preventDefaultAction = true;

    updateTextPreviewRect(textDragState.startPixel.x, textDragState.startPixel.y, event.position.x, event.position.y);
  });

  osd.addHandler('canvas-release', (event: any) => {
    if (!isEnabled || currentTool !== 'text' || !textDragState) return;

    event.preventDefaultAction = true;
    hideTextPreviewRect();

    completeTextPlacement(
      textDragState.startPixel,
      { x: event.position.x, y: event.position.y },
      textDragState.startViewport
    );

    textDragState = null;
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
      setToolInternal(tool);
    },

    getTool() {
      return currentTool;
    },

    setColor(color: string) {
      currentColor = color;
      doodle.setBrushColor(color);
      doodle.setDefaultColor(color);
      // Update selected text if any
      textRenderer?.updateSelected({ color });
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
      // Update selected text if any
      textRenderer?.updateSelected({ fontSize: size });
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

          // Basic validation - just check pos exists and values are finite
          if (
            !sanitizedShape.pos ||
            !Array.isArray(sanitizedShape.pos) ||
            sanitizedShape.pos.some(n => !Number.isFinite(n))
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
      // First try to delete selected text
      if (textRenderer?.deleteSelected()) {
        return true;
      }
      // Then try to delete selected doodle shape
      const doodleAny = doodle as any;
      if (doodleAny.tempShape?.id) {
        const shape = { ...doodleAny.tempShape };
        doodleAny.conf.onRemove?.(shape);
        return true;
      }
      return false;
    },

    setTextZoomStrategy(strategy: TextZoomStrategyType) {
      textZoomStrategy = strategy;
      textRenderer?.updatePositions();
    },

    getTextZoomStrategy(): TextZoomStrategyType {
      return textZoomStrategy;
    },

    destroy() {
      doodle.destroy();
      if (textPreviewRect) {
        textPreviewRect.remove();
        textPreviewRect = null;
      }
      if (textRenderer) {
        // Exit any active edit mode before clearing
        textRenderer.exitEditMode(false);
        textRenderer.clear();
        textRenderer = null;
      }
    },
  };

  return manager;
}
