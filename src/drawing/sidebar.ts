/**
 * Drawing Sidebar - UI component for drawing tools and saved drawings
 */

import type { DrawingManager, ShapeType, Shape, TextZoomStrategyType } from './doodle-integration';
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
  onNew?: () => void;
  onScreenshot?: () => void;
  onClose?: () => void;
  onMapChange?: (mapName: string) => Promise<void>;
}

interface ToolConfig {
  id: string; // UI ID
  type: ShapeType; // Doodle shape type
  filled: boolean; // Filled state
  icon: string;
  titleKey: string;
  svg?: string; // Custom SVG instead of Bootstrap icon
}

const ELLIPSE_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" class="bi" viewBox="0 0 16 16"><ellipse cx="8" cy="8" rx="7" ry="3.5" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>';

/*
const ELLIPSE_FILLED_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" class="bi" viewBox="0 0 16 16"><ellipse cx="8" cy="8" rx="7" ry="3.5" fill="currentColor" stroke="none"/></svg>';
*/

const TOOLS: ToolConfig[] = [
  { id: 'move', type: 'move', filled: false, icon: 'bi-arrows-move', titleKey: 'drawing.tools.move' },
  { id: 'path', type: 'path', filled: false, icon: 'bi-pencil', titleKey: 'drawing.tools.freehand' },
  { id: 'line', type: 'line', filled: false, icon: 'bi-slash-lg', titleKey: 'drawing.tools.line' },
  { id: 'arrow_line', type: 'arrow_line', filled: false, icon: 'bi-arrow-up-right', titleKey: 'drawing.tools.arrow' },
  { id: 'rect', type: 'rect', filled: false, icon: 'bi-square', titleKey: 'drawing.tools.rectangle' },
  /*
  { id: 'rect_filled', type: 'rect', filled: true, icon: 'bi-square-fill', titleKey: 'drawing.tools.rectangleFilled' },
  */
  { id: 'circle', type: 'circle', filled: false, icon: 'bi-circle', titleKey: 'drawing.tools.circle' },
  /*
  { id: 'circle_filled', type: 'circle', filled: true, icon: 'bi-circle-fill', titleKey: 'drawing.tools.circleFilled' },
  */
  { id: 'ellipse', type: 'ellipse', filled: false, icon: '', titleKey: 'drawing.tools.ellipse', svg: ELLIPSE_SVG },
  /*
  {
    id: 'ellipse_filled',
    type: 'ellipse',
    filled: true,
    icon: '',
    titleKey: 'drawing.tools.ellipseFilled',
    svg: ELLIPSE_FILLED_SVG,
  },
  */
  { id: 'polygon', type: 'polygon', filled: false, icon: 'bi-pentagon', titleKey: 'drawing.tools.polygon' },
  /*
  {
    id: 'polygon_filled',
    type: 'polygon',
    filled: true,
    icon: 'bi-pentagon-fill',
    titleKey: 'drawing.tools.polygonFilled',
  },
  */
  { id: 'point', type: 'point', filled: false, icon: 'bi-dot', titleKey: 'drawing.tools.point' },
];

import { COLOR_PALETTE, COLOR_NAME_KEYS, STROKE_WIDTHS, FONT_SIZES } from './constants';
import { extractDrawingData } from './screenshot';

interface ColorPreset {
  color: string;
  nameKey: string;
}

const COLOR_PRESETS: ColorPreset[] = COLOR_PALETTE.map((color, i) => ({
  color,
  nameKey: COLOR_NAME_KEYS[i],
}));

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
  private toolButtons: Map<string, HTMLElement> = new Map();
  private visibilityBtn!: HTMLElement;
  private drawingsList!: HTMLElement;
  private undoBtn!: HTMLButtonElement;
  private redoBtn!: HTMLButtonElement;
  private deleteBtn!: HTMLButtonElement;
  private keyboardHandler: ((e: KeyboardEvent) => void) | null = null;
  private keyupHandler: ((e: KeyboardEvent) => void) | null = null;
  private simplifiedHandler: (() => void) | null = null;
  private previousTool: ShapeType | null = null;
  private catboxSourceUrl: string | null = null;

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

    // DISABLED: Simplification warnings no longer needed - drawings shared via catbox.moe lossless upload
    // this.simplifiedHandler = () => this.showSimplifiedWarning();
    // window.addEventListener('drawing-simplified', this.simplifiedHandler);

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
    if (this.keyupHandler) {
      document.removeEventListener('keyup', this.keyupHandler);
      this.keyupHandler = null;
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
      <div class="sidebar-section p-2 border-top border-secondary">
        <p class="text-secondary small mb-2">${i18next.t('drawing.import.viewOnly', 'You can view shared drawings:')}</p>
        <button class="btn btn-sm btn-outline-light w-100" id="import-webp-btn-unauth" title="${i18next.t('drawing.actions.importWebpTitle')}">
          <i class="bi bi-upload me-2"></i>${i18next.t('drawing.actions.importWebp')}
        </button>
        <input type="file" id="import-webp-input-unauth" accept="image/webp" style="display: none;">
        <div id="catbox-source-container" class="mt-2" style="display: none;">
          <a id="catbox-source-link" href="#" target="_blank" class="btn btn-sm btn-outline-info w-100">
            <i class="bi bi-cloud me-2"></i>${i18next.t('drawing.actions.openSource', 'Open source on Catbox')}
          </a>
        </div>
      </div>
    `;

    this.contentArea.querySelector('#auth-login-btn')?.addEventListener('click', () => {
      authService.login();
    });

    // Bind import button for unauthenticated users
    this.bindImportButton('import-webp-btn-unauth', 'import-webp-input-unauth');

    // Disable drawing when not authenticated
    this.drawingManager.disable();

    this.updateCatboxSourceUI();
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
      <div class="sidebar-section p-2 border-top border-secondary">
        <p class="text-secondary small mb-2">${i18next.t('drawing.import.viewOnly', 'You can view shared drawings:')}</p>
        <button class="btn btn-sm btn-outline-light w-100" id="import-webp-btn-nonsub" title="${i18next.t('drawing.actions.importWebpTitle')}">
          <i class="bi bi-upload me-2"></i>${i18next.t('drawing.actions.importWebp')}
        </button>
        <input type="file" id="import-webp-input-nonsub" accept="image/webp" style="display: none;">
        <div id="catbox-source-container" class="mt-2" style="display: none;">
          <a id="catbox-source-link" href="#" target="_blank" class="btn btn-sm btn-outline-info w-100">
            <i class="bi bi-cloud me-2"></i>${i18next.t('drawing.actions.openSource', 'Open source on Catbox')}
          </a>
        </div>
      </div>
    `;

    this.contentArea.querySelector('#auth-logout-btn')?.addEventListener('click', async () => {
      await authService.logout();
    });

    // Bind import button for non-subscriber users
    this.bindImportButton('import-webp-btn-nonsub', 'import-webp-input-nonsub');

    // Disable drawing when not subscribed
    this.drawingManager.disable();

    this.updateCatboxSourceUI();
  }

  private renderSubscriberContent(): void {
    const extendedTools = [
      ...TOOLS,
      { id: 'text', type: 'text', filled: false, icon: 'bi-type', titleKey: 'drawing.tools.text', svg: undefined },
    ];

    this.contentArea.innerHTML = `
      <div class="sidebar-section p-2 border-bottom border-secondary">
        <label class="form-label text-secondary small mb-1">${i18next.t('drawing.tools.label')}</label>
        <div class="d-flex flex-wrap gap-1" id="tool-buttons">
          <input type="radio" class="btn-check" name="drawing-tool" id="tool-move" autocomplete="off">
          <label class="btn btn-sm btn-outline-light" for="tool-move" data-tool="move" title="${i18next.t('drawing.tools.move')}">
            <i class="bi-arrows-move"></i>
          </label>
          ${extendedTools
            .slice(1)
            .map(
              tool => `
          <input type="radio" class="btn-check" name="drawing-tool" id="tool-${tool.id}" autocomplete="off" ${tool.id === 'path' ? 'checked' : ''}>
          <label class="btn btn-sm btn-outline-light" for="tool-${tool.id}" data-tool="${tool.id}" title="${i18next.t(tool.titleKey)}">
            ${tool.svg ? tool.svg : `<i class="${tool.icon}"></i>`}
          </label>`
            )
            .join('')}
        </div>
      </div>

      <div class="sidebar-section p-2 border-bottom border-secondary">
        <label class="form-label text-secondary small mb-1">${i18next.t('drawing.color.label')}</label>
        <div class="d-flex flex-wrap gap-1">
          ${COLOR_PRESETS.map(
            color => `
            <button type="button" class="btn btn-sm p-0 border rounded" data-color="${color.color}" style="background-color: ${color.color}; width: 24px; height: 24px;" title="${i18next.t(color.nameKey)}"></button>
          `
          ).join('')}
        </div>
      </div>

      <div class="sidebar-section p-2 border-bottom border-secondary" id="stroke-width-section">
        <label class="form-label text-secondary small mb-1">${i18next.t('drawing.stroke.label')}</label>
        <div class="btn-group btn-group-sm w-100" role="group" id="stroke-buttons">
          ${STROKE_WIDTHS.map((width, index) => {
            const labels = ['Thin', 'Normal', 'Thick', 'Heavy'];
            const label = labels[index] || width + 'px';
            return `<input type="radio" class="btn-check" name="stroke-width" id="stroke-${width}" autocomplete="off" ${index === 1 ? 'checked' : ''}>
            <label class="btn btn-outline-light" for="stroke-${width}">${label}</label>`;
          }).join('')}
        </div>
      </div>

      <div class="sidebar-section p-2 border-bottom border-secondary" id="font-size-section" style="display: none;">
        <label class="form-label text-secondary small mb-1">Font Size</label>
        <div class="btn-group btn-group-sm w-100" role="group" id="font-size-buttons">
          ${FONT_SIZES.map((size, index) => {
            const labels = ['Small', 'Medium', 'Large', 'Huge'];
            const label = labels[index];
            return `<input type="radio" class="btn-check" name="font-size" id="font-${size}" autocomplete="off" ${index === 0 ? 'checked' : ''}>
            <label class="btn btn-outline-light" for="font-${size}">${label}</label>`;
          }).join('')}
        </div>
      </div>

      <div class="sidebar-section p-2 border-bottom border-secondary" id="text-zoom-section" style="display: none;">
        <label class="form-label text-secondary small mb-1">Text Zoom (Debug)</label>
        <div class="btn-group btn-group-sm w-100" role="group" id="text-zoom-buttons">
          <input type="radio" class="btn-check" name="text-zoom" id="text-zoom-fixed-screen" autocomplete="off" checked>
          <label class="btn btn-outline-warning" for="text-zoom-fixed-screen" title="Text stays same screen size regardless of zoom">Screen</label>
          <input type="radio" class="btn-check" name="text-zoom" id="text-zoom-fixed-world" autocomplete="off">
          <label class="btn btn-outline-warning" for="text-zoom-fixed-world" title="Text scales with the map (like other shapes)">World</label>
          <input type="radio" class="btn-check" name="text-zoom" id="text-zoom-hybrid" autocomplete="off">
          <label class="btn btn-outline-warning" for="text-zoom-hybrid" title="Text scale clamped between 0.5x and 2x">Hybrid</label>
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
          <button class="btn btn-sm btn-outline-light flex-fill" id="import-webp-btn" title="${i18next.t('drawing.actions.importWebpTitle')}">
            <i class="bi bi-upload"></i> ${i18next.t('drawing.actions.importWebp')}
          </button>
          <input type="file" id="import-webp-input" accept="image/webp" style="display: none;">
          <button class="btn btn-sm btn-outline-light flex-fill" id="export-json-btn" title="${i18next.t('drawing.actions.exportJsonTitle')}">
            <i class="bi bi-filetype-json"></i> ${i18next.t('drawing.actions.exportJson')}
          </button>
        </div>
        <div id="catbox-source-container" class="mt-2" style="display: none;">
          <a id="catbox-source-link" href="#" target="_blank" class="btn btn-sm btn-outline-info w-100">
            <i class="bi bi-cloud me-2"></i>${i18next.t('drawing.actions.openSource', 'Open source on Catbox')}
          </a>
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
    // Cache standard tools
    TOOLS.forEach(tool => {
      const btn = this.contentArea.querySelector(`label[data-tool="${tool.id}"]`) as HTMLElement;
      if (btn) this.toolButtons.set(tool.id, btn);
    });
    // Cache text tool
    const textBtn = this.contentArea.querySelector(`label[data-tool="text"]`) as HTMLElement;
    if (textBtn) this.toolButtons.set('text', textBtn);

    this.visibilityBtn = this.contentArea.querySelector('#toggle-visibility') as HTMLElement;
    this.drawingsList = this.contentArea.querySelector('#drawings-list') as HTMLElement;
    this.undoBtn = this.contentArea.querySelector('#undo-btn') as HTMLButtonElement;
    this.redoBtn = this.contentArea.querySelector('#redo-btn') as HTMLButtonElement;
    this.deleteBtn = this.contentArea.querySelector('#delete-selected-btn') as HTMLButtonElement;

    // Bind events for subscriber content
    this.bindSubscriberEvents();
    this.updateToolUI(this.drawingManager.getTool()); // Ensure UI state matches active tool
    this.refreshDrawingsList();

    // Preserve current stroke width and color, or use defaults for first render
    const currentStroke = this.drawingManager.getStrokeWidth();
    const currentColor = this.drawingManager.getColor();
    // Update UI to match current values (don't reset them)
    this.setStrokeWidth(currentStroke);
    this.setColor(currentColor);

    // Set up history change callback to update undo/redo buttons
    this.drawingManager.onHistoryChange = (canUndo, canRedo) => {
      this.undoBtn.disabled = !canUndo;
      this.redoBtn.disabled = !canRedo;
    };

    // Enable drawing if sidebar is open
    if (this.isOpen) {
      this.drawingManager.enable();
    }

    this.bindHotkeys();

    // Update catbox source link if set
    this.updateCatboxSourceUI();
  }

  private bindHotkeys(): void {
    let spaceHeld = false;

    this.keyboardHandler = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;

      if (e.code === 'Space') {
        // Spacebar: temporarily disable drawing to allow map panning
        if (!e.repeat && !spaceHeld) {
          e.preventDefault();
          e.stopPropagation();
          if (document.activeElement instanceof HTMLElement) {
            document.activeElement.blur();
          }
          spaceHeld = true;
          // Disable doodle so OSD can receive pan gestures
          this.drawingManager.disable();
        }
        return;
      }

      // Other hotkeys only work when drawing is enabled
      if (!this.drawingManager.isEnabled()) return;

      if (e.code === 'KeyV') {
        // V: switch to move tool (for moving shapes)
        if (!e.repeat) {
          e.preventDefault();
          this.drawingManager.setTool('move');
          this.updateToolUI('move');
        }
      } else if ((e.ctrlKey || e.metaKey) && e.code === 'KeyZ') {
        e.preventDefault();
        if (e.shiftKey) {
          this.drawingManager.redo();
        } else {
          this.drawingManager.undo();
        }
      } else if ((e.ctrlKey || e.metaKey) && e.code === 'KeyY') {
        e.preventDefault();
        this.drawingManager.redo();
      }
    };

    this.keyupHandler = (e: KeyboardEvent) => {
      if (e.code === 'Space' && spaceHeld) {
        spaceHeld = false;
        // Re-enable drawing when spacebar is released
        this.drawingManager.enable();
      }
    };

    document.addEventListener('keydown', this.keyboardHandler);
    document.addEventListener('keyup', this.keyupHandler);
  }

  private updateToolUI(toolId: string): void {
    console.log('[Sidebar] updateToolUI called with:', toolId);
    const radio = this.contentArea.querySelector(`#tool-${toolId}`) as HTMLInputElement;
    if (radio) radio.checked = true;

    // Toggle stroke/font/zoom UI based on tool
    const strokeSection = this.contentArea.querySelector('#stroke-width-section') as HTMLElement;
    const fontSection = this.contentArea.querySelector('#font-size-section') as HTMLElement;
    const textZoomSection = this.contentArea.querySelector('#text-zoom-section') as HTMLElement;

    if (!strokeSection || !fontSection) {
      console.warn('[Sidebar] Warning: One or more UI sections not found:', { strokeSection, fontSection });
    }

    if (strokeSection && fontSection) {
      if (toolId === 'text') {
        strokeSection.style.display = 'none';
        fontSection.style.display = 'block';
        if (textZoomSection) textZoomSection.style.display = 'block';
      } else {
        strokeSection.style.display = 'block';
        fontSection.style.display = 'none';
        if (textZoomSection) textZoomSection.style.display = 'none';
      }
    }
  }

  private bindSubscriberEvents(): void {
    // Tool selection - use radio button change event
    this.contentArea.querySelectorAll('input[name="drawing-tool"]').forEach(input => {
      input.addEventListener('change', () => {
        const inputId = (input as HTMLInputElement).id.replace('tool-', '');

        // Handle text tool special case or lookup in standard tools
        const config =
          TOOLS.find(t => t.id === inputId) || (inputId === 'text' ? { id: 'text', type: 'text', filled: false } : null);

        if (config) {
          console.log('[Sidebar] Selected tool:', config.id);
          this.drawingManager.setTool(config.type as ShapeType);
          // Only set fill for non-text tools (text tool handles its own rendering)
          // DISABLED: Filled shapes don't work properly with doodle library
          // if (config.type !== 'text') {
          //   this.drawingManager.setFill(config.filled);
          // }
          this.updateToolUI(config.id);
        } else if (inputId === 'move') {
          console.log('[Sidebar] Selected move tool');
          this.drawingManager.setTool('move');
          this.updateToolUI('move');
        }
      });
    });

    // Color presets
    this.contentArea.querySelectorAll('[data-color]').forEach(btn => {
      btn.addEventListener('click', () => {
        const color = btn.getAttribute('data-color');
        if (color) {
          this.drawingManager.setColor(color);
          this.updateActiveColorSwatch(color);
        }
      });
    });

    // Initialize active swatch
    this.updateActiveColorSwatch('#ffffff');

    // Stroke width buttons
    this.contentArea.querySelectorAll('input[name="stroke-width"]').forEach(input => {
      input.addEventListener('change', () => {
        const width = parseInt((input as HTMLInputElement).id.replace('stroke-', ''), 10);
        this.drawingManager.setStrokeWidth(width);
      });
    });

    // Font size buttons
    this.contentArea.querySelectorAll('input[name="font-size"]').forEach(input => {
      input.addEventListener('change', () => {
        const size = parseInt((input as HTMLInputElement).id.replace('font-', ''), 10);
        this.drawingManager.setFontSize(size);
      });
    });

    // Text zoom strategy buttons (debug)
    this.contentArea.querySelectorAll('input[name="text-zoom"]').forEach(input => {
      input.addEventListener('change', () => {
        const strategy = (input as HTMLInputElement).id.replace('text-zoom-', '') as 'fixed-screen' | 'fixed-world' | 'hybrid';
        this.drawingManager.setTextZoomStrategy(strategy);
      });
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
      this.options.onNew?.();
    });

    // Screenshot
    this.contentArea.querySelector('#screenshot-btn')?.addEventListener('click', () => {
      this.options.onScreenshot?.();
    });

    // Export JSON
    this.contentArea.querySelector('#export-json-btn')?.addEventListener('click', () => {
      this.exportJson();
    });

    // Import WebP with embedded drawing data
    const importBtn = this.contentArea.querySelector('#import-webp-btn');
    const importInput = this.contentArea.querySelector('#import-webp-input') as HTMLInputElement;
    importBtn?.addEventListener('click', () => {
      importInput?.click();
    });
    importInput?.addEventListener('change', async () => {
      const file = importInput.files?.[0];
      if (file) {
        await this.importWebp(file);
        importInput.value = ''; // Reset for next import
      }
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

  private async importWebp(file: File): Promise<void> {
    const result = await extractDrawingData(file);
    if (!result || result.shapes.length === 0) {
      console.log('[Sidebar] No drawing data found in WebP file');
      alert(i18next.t('drawing.import.noData'));
      return;
    }

    // Switch to the correct map if embedded map name differs from current
    const currentMap = this.session.getMapName();
    if (result.mapName && result.mapName !== currentMap && this.options.onMapChange) {
      await this.options.onMapChange(result.mapName);
      this.session.setMap(result.mapName);
    }

    // Load shapes into drawing manager
    this.drawingManager.loadShapes(result.shapes);

    // Update stroke width if available (both manager and UI)
    if (result.strokeWidth) {
      this.drawingManager.setStrokeWidth(result.strokeWidth);
      this.setStrokeWidth(result.strokeWidth);
    }

    console.log('[Sidebar] Imported', result.shapes.length, 'shapes from WebP, map:', result.mapName);

    // Save to session and refresh list
    await this.session.save();
    this.refreshDrawingsList();
  }

  /**
   * Helper to bind import button and file input by IDs
   * Used for both subscriber and non-subscriber views
   */
  private bindImportButton(buttonId: string, inputId: string): void {
    const importBtn = this.contentArea.querySelector(`#${buttonId}`);
    const importInput = this.contentArea.querySelector(`#${inputId}`) as HTMLInputElement;
    importBtn?.addEventListener('click', () => {
      importInput?.click();
    });
    importInput?.addEventListener('change', async () => {
      const file = importInput.files?.[0];
      if (file) {
        await this.importWebp(file);
        importInput.value = ''; // Reset for next import
      }
    });
  }

  private strokeWidthToSlider(width: number): number {
    // Map stroke width to slider value (0-3)
    const widths = [2, 5, 10, 15];
    let closest = 0;
    let minDiff = Math.abs(widths[0] - width);
    for (let i = 1; i < widths.length; i++) {
      const diff = Math.abs(widths[i] - width);
      if (diff < minDiff) {
        minDiff = diff;
        closest = i;
      }
    }
    return closest;
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
          <button type="button" class="btn btn-sm btn-outline-danger border-0 delete" style="position: relative; z-index: 2;" title="${i18next.t('drawing.savedDrawings.deleteTitle')}"><i class="bi bi-trash"></i></button>
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
    // this.colorPicker.value = color; // Removed
    this.updateActiveColorSwatch(color);
  }

  /**
   * Set the stroke width in the UI
   */
  setStrokeWidth(width: number): void {
    const radio = this.contentArea.querySelector(`#stroke-${width}`) as HTMLInputElement;
    if (radio) radio.checked = true;
  }
  private updateActiveColorSwatch(color: string): void {
    const normalize = (c: string) => c.toLowerCase();
    const target = normalize(color);

    this.contentArea.querySelectorAll('[data-color]').forEach(el => {
      const btn = el as HTMLElement;
      const btnColor = normalize(btn.getAttribute('data-color') || '');
      if (btnColor === target) {
        btn.classList.add('border-light', 'border-2', 'opacity-100');
        btn.classList.remove('border', 'opacity-75'); // Remove default border if needed
        btn.style.transform = 'scale(1.1)';
        btn.style.zIndex = '1';
      } else {
        btn.classList.remove('border-light', 'border-2', 'opacity-100');
        btn.classList.add('border'); // Restore default
        btn.style.transform = '';
        btn.style.zIndex = '';
      }
    });
  }

  /**
   * Set the Catbox source URL to display a link to the original image
   */
  setCatboxSource(fileId: string | null): void {
    if (!fileId) {
      this.catboxSourceUrl = null;
    } else {
      // If fileId already has extension (e.g. from regex match), don't append it again
      const file = fileId.endsWith('.webp') ? fileId : `${fileId}.webp`;
      this.catboxSourceUrl = `https://files.catbox.moe/${file}`;
    }
    this.updateCatboxSourceUI();
  }

  private updateCatboxSourceUI(): void {
    const container = this.contentArea.querySelector('#catbox-source-container') as HTMLElement;
    const link = this.contentArea.querySelector('#catbox-source-link') as HTMLAnchorElement;

    if (container && link) {
      if (this.catboxSourceUrl) {
        link.href = this.catboxSourceUrl;
        container.style.display = 'block';
      } else {
        container.style.display = 'none';
      }
    }
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
