/**
 * Drawing Hotkeys System
 *
 * Centralized hotkey definitions and handlers for the drawing tools.
 *
 * Hotkeys:
 *   V          - Selection/Move tool
 *   X          - Freehand drawing tool
 *   R          - Rectangle tool
 *   F          - Toggle fill on selected shape
 *   C          - Open color picker
 *   Space      - Hold for temporary pan mode (hand cursor)
 *   Ctrl+Z     - Undo
 *   Ctrl+Shift+Z / Ctrl+Y - Redo
 *   Delete     - Delete selected shape (handled by doodle library)
 */

import type { DrawingManager, ShapeType } from './doodle-integration';

/**
 * Hotkey configuration
 */
export interface HotkeyConfig {
  /** Keyboard event code (e.g., 'KeyV', 'Space') */
  code: string;
  /** Human-readable description */
  description: string;
  /** Whether this hotkey requires modifiers (ctrl/cmd) */
  requiresModifier?: boolean;
  /** Whether this hotkey requires shift */
  requiresShift?: boolean;
}

/**
 * All available hotkeys
 */
export const HOTKEYS: Record<string, HotkeyConfig> = {
  SELECT: { code: 'KeyV', description: 'Selection/Move tool' },
  FREEHAND: { code: 'KeyX', description: 'Freehand drawing' },
  RECTANGLE: { code: 'KeyR', description: 'Rectangle tool' },
  TOGGLE_FILL: { code: 'KeyF', description: 'Toggle fill on selected' },
  COLOR_PICKER: { code: 'KeyC', description: 'Color picker' },
  PAN: { code: 'Space', description: 'Hold for pan mode' },
  UNDO: { code: 'KeyZ', description: 'Undo', requiresModifier: true },
  REDO: { code: 'KeyY', description: 'Redo', requiresModifier: true },
  REDO_ALT: { code: 'KeyZ', description: 'Redo (Ctrl+Shift+Z)', requiresModifier: true, requiresShift: true },
};

export interface HotkeyHandlers {
  /** Callback to update the tool UI */
  updateToolUI: (toolId: string) => void;
  /** Reference to the color picker element */
  getColorPicker: () => HTMLInputElement | null;
}

export interface HotkeyState {
  spaceHeld: boolean;
  previousTool: ShapeType | null;
}

/**
 * Creates the keydown handler for drawing hotkeys
 */
export function createKeydownHandler(
  drawingManager: DrawingManager,
  handlers: HotkeyHandlers,
  state: HotkeyState
): (e: KeyboardEvent) => void {
  return (e: KeyboardEvent) => {
    // Don't intercept when typing in inputs
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
      return;
    }

    // === SPACEBAR: Temporary pan mode ===
    if (e.code === HOTKEYS.PAN.code) {
      if (!e.repeat && !state.spaceHeld) {
        e.preventDefault();
        e.stopPropagation();

        // Blur any focused element
        if (document.activeElement instanceof HTMLElement) {
          document.activeElement.blur();
        }

        state.spaceHeld = true;
        state.previousTool = drawingManager.getTool();

        // Disable doodle so OSD can receive pan gestures
        drawingManager.disable();

        // Change cursor to grab hand (like Photoshop)
        document.body.style.cursor = 'grab';
      }
      return;
    }

    // Other hotkeys only work when drawing is enabled
    if (!drawingManager.isEnabled()) return;

    // === TOOL HOTKEYS ===
    if (e.code === HOTKEYS.SELECT.code) {
      // V: Selection/Move tool
      if (!e.repeat) {
        e.preventDefault();
        drawingManager.setTool('move');
        handlers.updateToolUI('move');
      }
    } else if (e.code === HOTKEYS.FREEHAND.code) {
      // X: Freehand/Path tool
      if (!e.repeat) {
        e.preventDefault();
        drawingManager.setTool('path');
        drawingManager.setFill(false);
        handlers.updateToolUI('path');
      }
    } else if (e.code === HOTKEYS.RECTANGLE.code) {
      // R: Rectangle tool
      if (!e.repeat) {
        e.preventDefault();
        drawingManager.setTool('rect');
        drawingManager.setFill(false);
        handlers.updateToolUI('rect');
      }
    } else if (e.code === HOTKEYS.TOGGLE_FILL.code) {
      // F: Toggle fill on selected shape
      if (!e.repeat) {
        e.preventDefault();
        drawingManager.toggleSelectedFill();
      }
    } else if (e.code === HOTKEYS.COLOR_PICKER.code) {
      // C: Focus color picker
      if (!e.repeat) {
        e.preventDefault();
        const colorPicker = handlers.getColorPicker();
        if (colorPicker) {
          colorPicker.click();
        }
      }
    } else if ((e.ctrlKey || e.metaKey) && e.code === HOTKEYS.UNDO.code) {
      // Ctrl+Z / Cmd+Z: Undo (or Redo with Shift)
      e.preventDefault();
      if (e.shiftKey) {
        drawingManager.redo();
      } else {
        drawingManager.undo();
      }
    } else if ((e.ctrlKey || e.metaKey) && e.code === HOTKEYS.REDO.code) {
      // Ctrl+Y / Cmd+Y: Redo
      e.preventDefault();
      drawingManager.redo();
    }
  };
}

/**
 * Creates the keyup handler for drawing hotkeys
 */
export function createKeyupHandler(
  drawingManager: DrawingManager,
  handlers: HotkeyHandlers,
  state: HotkeyState
): (e: KeyboardEvent) => void {
  return (e: KeyboardEvent) => {
    // === SPACEBAR RELEASE: Exit pan mode ===
    if (e.code === HOTKEYS.PAN.code && state.spaceHeld) {
      state.spaceHeld = false;

      // Restore cursor
      document.body.style.cursor = '';

      // Re-enable drawing when spacebar is released
      drawingManager.enable();

      // Restore previous tool if it was set
      if (state.previousTool) {
        drawingManager.setTool(state.previousTool);
        handlers.updateToolUI(state.previousTool);
        state.previousTool = null;
      }
    }
  };
}

/**
 * Get a formatted list of all hotkeys for display
 */
export function getHotkeysList(): Array<{ key: string; description: string }> {
  return [
    { key: 'V', description: HOTKEYS.SELECT.description },
    { key: 'X', description: HOTKEYS.FREEHAND.description },
    { key: 'R', description: HOTKEYS.RECTANGLE.description },
    { key: 'F', description: HOTKEYS.TOGGLE_FILL.description },
    { key: 'C', description: HOTKEYS.COLOR_PICKER.description },
    { key: 'Space (hold)', description: HOTKEYS.PAN.description },
    { key: 'Ctrl+Z', description: HOTKEYS.UNDO.description },
    { key: 'Ctrl+Y', description: HOTKEYS.REDO.description },
  ];
}
