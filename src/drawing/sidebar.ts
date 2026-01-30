/**
 * Drawing Sidebar - UI component for drawing tools and saved drawings
 */

import type { DrawingManager, ShapeType, Shape } from './doodle-integration';
import type { DrawingSession, StoredDrawing } from './storage';
import { getAllDrawings } from './storage';
import { getAllMapDefinitions } from '../data_sources/map_definitions';
import type { AuthState } from '../auth/auth-service';
import { authService } from '../auth/auth-service';
import i18next from '../i18n';

export interface SidebarOptions {
  drawingManager: DrawingManager;
  session: DrawingSession;
  onVisibilityChange?: (visible: boolean) => void;
  onSave?: () => void;
  onScreenshot?: () => void;
  onClose?: () => void;
  onMapChange?: (mapName: string) => Promise<void>;
}

interface ToolConfig {
  id: ShapeType;
  icon: string;
  titleKey: string;
  svg?: string; // Custom SVG instead of Bootstrap icon
}

const ELLIPSE_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" class="bi" viewBox="0 0 16 16"><ellipse cx="8" cy="8" rx="7" ry="3.5" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>';

const TOOLS: ToolConfig[] = [
  { id: 'move', icon: 'bi-arrows-move', titleKey: 'drawing.tools.move' },
  { id: 'path', icon: 'bi-pencil', titleKey: 'drawing.tools.freehand' },
  { id: 'line', icon: 'bi-slash-lg', titleKey: 'drawing.tools.line' },
  { id: 'arrow_line', icon: 'bi-arrow-up-right', titleKey: 'drawing.tools.arrow' },
  { id: 'rect', icon: 'bi-square', titleKey: 'drawing.tools.rectangle' },
  { id: 'circle', icon: 'bi-circle', titleKey: 'drawing.tools.circle' },
  { id: 'ellipse', icon: '', titleKey: 'drawing.tools.ellipse', svg: ELLIPSE_SVG },
  { id: 'polygon', icon: 'bi-pentagon', titleKey: 'drawing.tools.polygon' },
  { id: 'point', icon: 'bi-dot', titleKey: 'drawing.tools.point' },
];

interface ColorPreset {
  color: string;
  nameKey: string;
}

const COLOR_PRESETS: ColorPreset[] = [
  { color: '#ffffff', nameKey: 'drawing.color.white' },
  { color: '#ef4444', nameKey: 'drawing.color.red' },
  { color: '#f97316', nameKey: 'drawing.color.orange' },
  { color: '#eab308', nameKey: 'drawing.color.yellow' },
  { color: '#22c55e', nameKey: 'drawing.color.green' },
  { color: '#06b6d4', nameKey: 'drawing.color.cyan' },
  { color: '#3b82f6', nameKey: 'drawing.color.blue' },
  { color: '#8b5cf6', nameKey: 'drawing.color.violet' },
];

export class DrawingSidebar {
  private container: HTMLElement;
  private drawingManager: DrawingManager;
  private session: DrawingSession;
  private isOpen = false;
  private options: SidebarOptions;
  private authState: AuthState;
  private unsubscribeAuth: (() => void) | null = null;

  // UI elements
  private sidebar!: HTMLElement;
  private contentArea!: HTMLElement;
  private toolButtons: Map<ShapeType, HTMLElement> = new Map();
  private colorPicker!: HTMLInputElement;
  private strokeSlider!: HTMLInputElement;
  private strokeValue!: HTMLElement;
  private visibilityBtn!: HTMLElement;
  private drawingsList!: HTMLElement;
  private undoBtn!: HTMLButtonElement;
  private redoBtn!: HTMLButtonElement;
  private deleteBtn!: HTMLButtonElement;
  private keyboardHandler: ((e: KeyboardEvent) => void) | null = null;
  private simplifiedHandler: (() => void) | null = null;

  constructor(container: HTMLElement, options: SidebarOptions) {
    this.container = container;
    this.drawingManager = options.drawingManager;
    this.session = options.session;
    this.options = options;
    this.authState = authService.getState();

    this.createSidebar();
    this.bindCloseEvent();
    this.renderContent();

    // Subscribe to auth state changes
    this.unsubscribeAuth = authService.subscribe(state => {
      this.authState = state;
      this.renderContent();
    });

    // Listen for drawing simplification warnings
    this.simplifiedHandler = () => this.showSimplifiedWarning();
    window.addEventListener('drawing-simplified', this.simplifiedHandler);

    // Re-render when language changes
    i18next.on('languageChanged', () => {
      this.updateSidebarHeader();
      this.renderContent();
    });
  }

  private createSidebar(): void {
    this.sidebar = document.createElement('div');
    this.sidebar.className = 'drawing-sidebar';
    this.sidebar.id = 'drawing-sidebar';
    this.sidebar.innerHTML = `
      <div class="sidebar-header d-flex justify-content-between align-items-center p-2 border-bottom border-secondary">
        <h6 class="mb-0 text-light"><i class="bi bi-brush me-2"></i>${i18next.t('drawing.title')}</h6>
        <button class="btn btn-sm btn-outline-light border-0" id="close-sidebar" title="${i18next.t('drawing.close')}"><i class="bi bi-x-lg"></i></button>
      </div>
      <div id="sidebar-content"></div>
    `;

    this.container.appendChild(this.sidebar);
    this.contentArea = this.sidebar.querySelector('#sidebar-content') as HTMLElement;
  }

  private bindCloseEvent(): void {
    this.sidebar.querySelector('#close-sidebar')?.addEventListener('click', () => {
      this.close();
    });
  }

  private updateSidebarHeader(): void {
    const header = this.sidebar.querySelector('.sidebar-header h6');
    const closeBtn = this.sidebar.querySelector('#close-sidebar');
    if (header) {
      header.innerHTML = `<i class="bi bi-brush me-2"></i>${i18next.t('drawing.title')}`;
    }
    if (closeBtn) {
      closeBtn.setAttribute('title', i18next.t('drawing.close'));
    }
  }

  private renderContent(): void {
    // Clean up keyboard handler when re-rendering
    if (this.keyboardHandler) {
      document.removeEventListener('keydown', this.keyboardHandler);
      this.keyboardHandler = null;
    }

    // Dev bypass: localStorage flag, only on dev/localhost/file://
    const isDevHost =
      window.location.hostname === 'dev.noitamap.com' ||
      window.location.hostname === 'localhost' ||
      window.location.protocol === 'file:';
    const isDevMode = isDevHost && localStorage.getItem('noitamap-dev-drawing') === '1';

    // Determine which content to show based on auth state
    if (isDevMode) {
      // Dev mode - show full subscriber content for testing
      this.renderSubscriberContent();
    } else if (!this.authState.authenticated) {
      this.renderUnauthenticatedContent();
    } else if (!this.authState.isSubscriber) {
      this.renderNonSubscriberContent();
    } else {
      this.renderSubscriberContent();
    }
  }

  private renderUnauthenticatedContent(): void {
    this.contentArea.innerHTML = `
      <div class="p-4 text-center">
        <svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" fill="currentColor" class="bi bi-lock text-secondary" viewBox="0 0 16 16">
          <path fill-rule="evenodd" d="M8 0a4 4 0 0 1 4 4v2.05a2.5 2.5 0 0 1 2 2.45v5a2.5 2.5 0 0 1-2.5 2.5h-7A2.5 2.5 0 0 1 2 13.5v-5a2.5 2.5 0 0 1 2-2.45V4a4 4 0 0 1 4-4M4.5 7A1.5 1.5 0 0 0 3 8.5v5A1.5 1.5 0 0 0 4.5 15h7a1.5 1.5 0 0 0 1.5-1.5v-5A1.5 1.5 0 0 0 11.5 7zM8 1a3 3 0 0 0-3 3v2h6V4a3 3 0 0 0-3-3"/>
        </svg>
        <p class="text-light mt-3 mb-2">${i18next.t('drawing.auth.subscriberOnly')}</p>
        <p class="text-secondary small mb-4">${i18next.t('drawing.auth.signInPrompt')}</p>
        <button class="btn" id="auth-login-btn" style="background-color: #9146FF; color: white;">
          <i class="bi bi-twitch me-2"></i>${i18next.t('drawing.auth.signInButton')}
        </button>
      </div>
    `;

    this.contentArea.querySelector('#auth-login-btn')?.addEventListener('click', () => {
      authService.login();
    });

    // Disable drawing when not authenticated
    this.drawingManager.disable();
  }

  private renderNonSubscriberContent(): void {
    const username = this.authState.username || 'User';
    this.contentArea.innerHTML = `
      <div class="p-4 text-center">
        <i class="bi bi-star-fill text-warning" style="font-size: 2.5rem;"></i>
        <p class="text-light mt-3 mb-1">${i18next.t('drawing.auth.greeting', { username: this.escapeHtml(username) })}</p>
        <p class="text-secondary small mb-2">${i18next.t('drawing.auth.subscriberFeature')}</p>
        <p class="text-secondary small mb-4">${i18next.t('drawing.auth.subscribePrompt')}</p>
        <a href="https://www.twitch.tv/wuote/subscribe" target="_blank" class="btn mb-2" style="background-color: #9146FF; color: white;">
          <i class="bi bi-twitch me-2"></i>${i18next.t('drawing.auth.subscribeButton')}
        </a>
        <button class="btn btn-outline-secondary btn-sm d-block mx-auto" id="auth-logout-btn">
          ${i18next.t('drawing.auth.signOut')}
        </button>
      </div>
    `;

    this.contentArea.querySelector('#auth-logout-btn')?.addEventListener('click', async () => {
      await authService.logout();
    });

    // Disable drawing when not subscribed
    this.drawingManager.disable();
  }

  private renderSubscriberContent(): void {
    this.contentArea.innerHTML = `
      <div class="sidebar-section p-2 border-bottom border-secondary">
        <label class="form-label text-secondary small mb-1">${i18next.t('drawing.tools.label')}</label>
        <div class="d-flex gap-1" id="tool-buttons">
          <input type="radio" class="btn-check" name="drawing-tool" id="tool-move" autocomplete="off">
          <label class="btn btn-sm btn-outline-light" for="tool-move" data-tool="move" title="${i18next.t('drawing.tools.move')}">
            <i class="bi-arrows-move"></i>
          </label>
          <div class="btn-group btn-group-sm" role="group">
            ${TOOLS.slice(1)
              .map(
                tool => `
            <input type="radio" class="btn-check" name="drawing-tool" id="tool-${tool.id}" autocomplete="off" ${tool.id === 'path' ? 'checked' : ''}>
            <label class="btn btn-outline-light" for="tool-${tool.id}" data-tool="${tool.id}" title="${i18next.t(tool.titleKey)}">
              ${tool.svg ? tool.svg : `<i class="${tool.icon}"></i>`}
            </label>`
              )
              .join('')}
          </div>
        </div>
      </div>

      <div class="sidebar-section p-2 border-bottom border-secondary">
        <label class="form-label text-secondary small mb-1">${i18next.t('drawing.color.label')}</label>
        <div class="d-flex align-items-center gap-2">
          <input type="color" class="form-control form-control-color" id="draw-color" value="#ffffff" title="${i18next.t('drawing.color.choose')}">
          <div class="d-flex flex-wrap gap-1">
            ${COLOR_PRESETS.map(
              color => `
              <button type="button" class="btn btn-sm p-0 border rounded" data-color="${color.color}" style="background-color: ${color.color}; width: 24px; height: 24px;" title="${i18next.t(color.nameKey)}"></button>
            `
            ).join('')}
          </div>
        </div>
      </div>

      <div class="sidebar-section p-2 border-bottom border-secondary">
        <label class="form-label text-secondary small mb-1">${i18next.t('drawing.stroke.label')}</label>
        <div class="d-flex align-items-center gap-2">
          <input type="range" class="form-range flex-grow-1" id="draw-stroke" min="1" max="20" value="5">
          <span class="text-light small" id="stroke-value" style="min-width: 1.5rem;">5</span>
        </div>
      </div>

      <div class="sidebar-section p-2 border-bottom border-secondary">
        <div class="d-flex flex-wrap gap-1">
          <button class="btn btn-sm btn-outline-light flex-fill" id="undo-btn" title="${i18next.t('drawing.actions.undoTitle')}" disabled>
            <i class="bi bi-arrow-counterclockwise"></i> ${i18next.t('drawing.actions.undo')}
          </button>
          <button class="btn btn-sm btn-outline-light flex-fill" id="redo-btn" title="${i18next.t('drawing.actions.redoTitle')}" disabled>
            <i class="bi bi-arrow-clockwise"></i> ${i18next.t('drawing.actions.redo')}
          </button>
          <button class="btn btn-sm btn-outline-danger flex-fill" id="delete-selected-btn" title="${i18next.t('drawing.actions.deleteTitle')}">
            <i class="bi bi-trash3"></i> ${i18next.t('drawing.actions.delete')}
          </button>
        </div>
      </div>

      <div class="sidebar-section p-2 border-bottom border-secondary">
        <div class="d-flex flex-wrap gap-1">
          <button class="btn btn-sm btn-outline-light flex-fill" id="toggle-visibility" title="${i18next.t('drawing.actions.showHideTitle')}">
            <i class="bi bi-eye"></i> ${i18next.t('drawing.actions.showHide')}
          </button>
          <button class="btn btn-sm btn-outline-light flex-fill" id="save-drawing" title="${i18next.t('drawing.actions.saveTitle')}">
            <i class="bi bi-floppy"></i> ${i18next.t('drawing.actions.save')}
          </button>
          <button class="btn btn-sm btn-outline-light flex-fill" id="new-drawing" title="${i18next.t('drawing.actions.newTitle')}">
            <i class="bi bi-file-earmark-plus"></i> ${i18next.t('drawing.actions.new')}
          </button>
          <button class="btn btn-sm btn-outline-light flex-fill" id="screenshot-btn" title="${i18next.t('drawing.actions.downloadTitle')}">
            <i class="bi bi-download"></i> ${i18next.t('drawing.actions.download')}
          </button>
          <button class="btn btn-sm btn-outline-light flex-fill" id="export-json-btn" title="${i18next.t('drawing.actions.exportJsonTitle')}">
            <i class="bi bi-filetype-json"></i> ${i18next.t('drawing.actions.exportJson')}
          </button>
        </div>
      </div>

      <div class="sidebar-section p-2 flex-grow-1 overflow-auto">
        <label class="form-label text-secondary small mb-1">${i18next.t('drawing.savedDrawings.label')}</label>
        <div class="drawings-list" id="drawings-list">
          <div class="text-secondary small text-center py-3">${i18next.t('drawing.savedDrawings.empty')}</div>
        </div>
      </div>
    `;

    // Cache UI elements
    this.toolButtons.clear();
    TOOLS.forEach(tool => {
      const btn = this.contentArea.querySelector(`label[data-tool="${tool.id}"]`) as HTMLElement;
      if (btn) this.toolButtons.set(tool.id, btn);
    });

    this.colorPicker = this.contentArea.querySelector('#draw-color') as HTMLInputElement;
    this.strokeSlider = this.contentArea.querySelector('#draw-stroke') as HTMLInputElement;
    this.strokeValue = this.contentArea.querySelector('#stroke-value') as HTMLElement;
    this.visibilityBtn = this.contentArea.querySelector('#toggle-visibility') as HTMLElement;
    this.drawingsList = this.contentArea.querySelector('#drawings-list') as HTMLElement;
    this.undoBtn = this.contentArea.querySelector('#undo-btn') as HTMLButtonElement;
    this.redoBtn = this.contentArea.querySelector('#redo-btn') as HTMLButtonElement;
    this.deleteBtn = this.contentArea.querySelector('#delete-selected-btn') as HTMLButtonElement;

    // Bind events for subscriber content
    this.bindSubscriberEvents();
    this.refreshDrawingsList();

    // Set initial stroke width and color
    this.drawingManager.setStrokeWidth(5);
    this.drawingManager.setColor('#ffffff');

    // Set up history change callback to update undo/redo buttons
    this.drawingManager.onHistoryChange = (canUndo, canRedo) => {
      this.undoBtn.disabled = !canUndo;
      this.redoBtn.disabled = !canRedo;
    };

    // Enable drawing if sidebar is open
    if (this.isOpen) {
      this.drawingManager.enable();
    }
  }

  private bindSubscriberEvents(): void {
    // Tool selection - use radio button change event
    this.contentArea.querySelectorAll('input[name="drawing-tool"]').forEach(input => {
      input.addEventListener('change', () => {
        const toolId = (input as HTMLInputElement).id.replace('tool-', '') as ShapeType;
        this.drawingManager.setTool(toolId);
      });
    });

    // Color picker
    this.colorPicker.addEventListener('input', () => {
      this.drawingManager.setColor(this.colorPicker.value);
    });

    // Color presets
    this.contentArea.querySelectorAll('[data-color]').forEach(btn => {
      btn.addEventListener('click', () => {
        const color = btn.getAttribute('data-color');
        if (color) {
          this.colorPicker.value = color;
          this.drawingManager.setColor(color);
        }
      });
    });

    // Stroke width
    this.strokeSlider.addEventListener('input', () => {
      const value = parseInt(this.strokeSlider.value, 10);
      this.strokeValue.textContent = value.toString();
      this.drawingManager.setStrokeWidth(value);
    });

    // Visibility toggle
    this.visibilityBtn.addEventListener('click', () => {
      const visible = !this.drawingManager.isVisible();
      this.drawingManager.setVisibility(visible);
      this.updateVisibilityButton(visible);
      this.options.onVisibilityChange?.(visible);
    });

    // Save
    this.contentArea.querySelector('#save-drawing')?.addEventListener('click', async () => {
      await this.session.save();
      this.refreshDrawingsList();
      this.options.onSave?.();
    });

    // New drawing
    this.contentArea.querySelector('#new-drawing')?.addEventListener('click', () => {
      this.drawingManager.clearShapes();
      this.session.clear();
      this.refreshDrawingsList();
    });

    // Screenshot
    this.contentArea.querySelector('#screenshot-btn')?.addEventListener('click', () => {
      this.options.onScreenshot?.();
    });

    // Export JSON
    this.contentArea.querySelector('#export-json-btn')?.addEventListener('click', () => {
      this.exportJson();
    });

    // Undo
    this.undoBtn.addEventListener('click', () => {
      this.drawingManager.undo();
    });

    // Redo
    this.redoBtn.addEventListener('click', () => {
      this.drawingManager.redo();
    });

    // Delete selected shape
    this.deleteBtn.addEventListener('click', () => {
      this.drawingManager.deleteSelected();
    });

    // Keyboard shortcuts for undo/redo
    this.keyboardHandler = (e: KeyboardEvent) => {
      // Only handle if sidebar is open and user is authenticated subscriber
      if (!this.isOpen || !this.authState.authenticated || !this.authState.isSubscriber) return;
      // Don't intercept if user is typing in an input
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;

      if (e.ctrlKey || e.metaKey) {
        if (e.key === 'z' && !e.shiftKey) {
          e.preventDefault();
          this.drawingManager.undo();
        } else if ((e.key === 'z' && e.shiftKey) || e.key === 'y') {
          e.preventDefault();
          this.drawingManager.redo();
        }
      }
    };
    document.addEventListener('keydown', this.keyboardHandler);
  }

  private exportJson(): void {
    const shapes = this.drawingManager.getShapes();
    const data = {
      map: this.session.getMapName(),
      shapes,
      exported_at: new Date().toISOString(),
      shape_count: shapes.length,
    };
    const json = JSON.stringify(data, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);

    const a = document.createElement('a');
    a.href = url;
    a.download = `noitamap-drawing-${Date.now()}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  private selectTool(tool: ShapeType): void {
    // Update radio button
    const radio = this.sidebar.querySelector(`#tool-${tool}`) as HTMLInputElement;
    if (radio) radio.checked = true;

    // Update manager
    this.drawingManager.setTool(tool);
  }

  private updateVisibilityButton(visible: boolean): void {
    const icon = this.visibilityBtn.querySelector('i');
    if (icon) {
      icon.className = visible ? 'bi bi-eye' : 'bi bi-eye-slash';
    }
  }

  private simplifiedWarningShown = false;

  private showSimplifiedWarning(): void {
    // Only show this warning once per session to avoid spamming
    if (this.simplifiedWarningShown) return;
    this.simplifiedWarningShown = true;

    const toastEl = document.getElementById('drawingWarningToast');
    if (!toastEl) return;
    const toast = new bootstrap.Toast(toastEl, {
      autohide: false,
    });
    toast.show();
  }

  async refreshDrawingsList(): Promise<void> {
    // Get ALL drawings across all maps, not just current map
    const drawings = await getAllDrawings();
    const currentId = this.session.getCurrent()?.id;
    const currentMap = this.session.getMapName();

    // Build map name lookup
    const mapDefs = getAllMapDefinitions();
    const mapNameLookup = new Map<string, string>();
    for (const [key, def] of mapDefs) {
      const translatedLabel = def.labelKey ? i18next.t(def.labelKey) : def.label;
      mapNameLookup.set(key, translatedLabel);
    }

    if (drawings.length === 0) {
      this.drawingsList.innerHTML = `<div class="text-secondary small text-center py-3">${i18next.t('drawing.savedDrawings.empty')}</div>`;
      return;
    }

    this.drawingsList.innerHTML = drawings
      .map(drawing => {
        const date = new Date(drawing.updated_at);
        const dateStr = date.toLocaleDateString();
        const shapeCount = drawing.shapes.length;
        const isActive = drawing.id === currentId;
        const isCurrentMap = drawing.map_name === currentMap;
        const mapDisplayName = mapNameLookup.get(drawing.map_name) || drawing.map_name;

        // Detect default name marker and translate dynamically
        const displayName = drawing.name.startsWith('__default__:')
          ? `${i18next.t('drawing.savedDrawings.defaultName')} ${new Date(parseInt(drawing.name.slice(12))).toLocaleString()}`
          : drawing.name;

        return `
        <div class="list-group-item list-group-item-action d-flex align-items-center gap-2 bg-transparent text-light border-secondary ${isActive ? 'active' : ''}" data-id="${drawing.id}" data-map="${drawing.map_name}" role="button">
          <div class="flex-grow-1 min-width-0">
            <div class="small text-truncate">${this.escapeHtml(displayName)}</div>
            <div class="small text-secondary">
              ${shapeCount} ${i18next.t('drawing.savedDrawings.shapes')} · ${dateStr}
              ${!isCurrentMap ? `<br><i class="bi bi-map me-1"></i>${this.escapeHtml(mapDisplayName)}` : ''}
            </div>
          </div>
          <button class="btn btn-sm btn-outline-danger border-0 delete" title="${i18next.t('drawing.savedDrawings.deleteTitle')}"><i class="bi bi-trash"></i></button>
        </div>
      `;
      })
      .join('');

    // Bind events for drawing items
    this.drawingsList.querySelectorAll('.list-group-item').forEach(item => {
      const id = item.getAttribute('data-id');
      const mapName = item.getAttribute('data-map');
      if (!id) return;

      item.querySelector('.delete')?.addEventListener('click', async e => {
        e.stopPropagation();
        await this.deleteDrawing(id);
      });

      item.addEventListener('click', async () => {
        await this.loadDrawing(id, mapName || undefined);
      });
    });
  }

  private async loadDrawing(id: string, mapName?: string): Promise<void> {
    const currentMap = this.session.getMapName();

    // If drawing is from a different map, switch maps first
    if (mapName && mapName !== currentMap && this.options.onMapChange) {
      await this.options.onMapChange(mapName);
      this.session.setMap(mapName);
    }

    const drawing = await this.session.loadDrawing(id);
    if (drawing) {
      // Defer heavy rendering to next frame to avoid blocking UI
      requestAnimationFrame(() => {
        this.drawingManager.loadShapes(drawing.shapes);
        this.refreshDrawingsList();
      });
    }
  }

  private async deleteDrawing(id: string): Promise<void> {
    if (!confirm(i18next.t('drawing.savedDrawings.deleteConfirm'))) return;

    const { deleteDrawing } = await import('./storage');
    await deleteDrawing(id);

    // If deleting current drawing, clear the session
    if (this.session.getCurrent()?.id === id) {
      this.session.clear();
      this.drawingManager.clearShapes();
    }

    this.refreshDrawingsList();
  }

  private escapeHtml(str: string): string {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  open(): void {
    this.isOpen = true;
    this.sidebar.classList.add('open');
    // Only enable drawing for authenticated subscribers
    if (this.authState.authenticated && this.authState.isSubscriber) {
      this.drawingManager.enable();
    }
    this.renderContent();
  }

  close(): void {
    this.isOpen = false;
    this.sidebar.classList.remove('open');
    this.drawingManager.disable();
    this.options.onClose?.();
  }

  toggle(): void {
    if (this.isOpen) {
      this.close();
    } else {
      this.open();
    }
  }

  isOpened(): boolean {
    return this.isOpen;
  }

  /**
   * Update the selected tool in the UI (e.g., after programmatic change)
   */
  updateSelectedTool(tool: ShapeType): void {
    const radio = this.sidebar.querySelector(`#tool-${tool}`) as HTMLInputElement;
    if (radio) radio.checked = true;
  }

  /**
   * Set the current color in the UI
   */
  setColor(color: string): void {
    this.colorPicker.value = color;
  }

  /**
   * Set the stroke width in the UI
   */
  setStrokeWidth(width: number): void {
    this.strokeSlider.value = width.toString();
    this.strokeValue.textContent = width.toString();
  }
}

/**
 * Create the draw toggle button for the navbar
 */
export function createDrawToggleButton(): HTMLElement {
  const btn = document.createElement('button');
  btn.id = 'drawToggleBtn';
  btn.className = 'icon-button btn btn-sm btn-outline-light text-nowrap me-2';
  btn.setAttribute('data-bs-toggle', 'popover');
  btn.setAttribute('data-bs-placement', 'top');
  btn.setAttribute('data-bs-trigger', 'hover focus');
  btn.setAttribute('data-i18n-title', 'drawing.toggle.title');
  btn.setAttribute('data-bs-title', i18next.t('drawing.toggle.title'));
  btn.setAttribute('data-i18n-content', 'drawing.toggle.content');
  btn.setAttribute('data-bs-content', i18next.t('drawing.toggle.content'));
  btn.innerHTML = '<i class="bi bi-brush"></i>';
  return btn;
}
