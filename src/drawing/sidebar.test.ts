// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DrawingSidebar } from './sidebar';
import { DrawingManager } from './doodle-integration';
import { DrawingSession } from './storage';
import { authService } from '../auth/auth-service';
import i18next from '../i18n';

// Mock dependencies
vi.mock('../i18n', () => ({
  default: {
    t: (key: string) => key,
    on: vi.fn(),
  },
}));

vi.mock('../auth/auth-service', () => ({
  authService: {
    getState: vi.fn(() => ({ authenticated: true, isSubscriber: true, username: 'TestUser' })),
    subscribe: vi.fn(() => vi.fn()),
  },
}));

vi.mock('./storage', () => ({
  getAllDrawings: vi.fn(() => Promise.resolve([])),
  getAllMapDefinitions: vi.fn(() => new Map()),
}));

describe('DrawingSidebar', () => {
  let container: HTMLElement;
  let drawingManager: DrawingManager;
  let session: DrawingSession;

  beforeEach(() => {
    // Setup DOM
    container = document.createElement('div');
    document.body.appendChild(container);

    // Setup Mocks
    drawingManager = {
      enable: vi.fn(),
      disable: vi.fn(),
      isEnabled: vi.fn().mockReturnValue(true),
      setTool: vi.fn(),
      getTool: vi.fn().mockReturnValue('move'),
      setColor: vi.fn(),
      getColor: vi.fn().mockReturnValue('#ffffff'),
      setStrokeWidth: vi.fn(),
      getStrokeWidth: vi.fn().mockReturnValue(5),
      setFontSize: vi.fn(),
      getFontSize: vi.fn().mockReturnValue(16),
      getShapes: vi.fn().mockReturnValue([]),
      loadShapes: vi.fn(),
      clearShapes: vi.fn(),
      resetShapes: vi.fn(),
      setVisibility: vi.fn(),
      isVisible: vi.fn().mockReturnValue(true),
      getCanvas: vi.fn(),
      extractCanvas: vi.fn(),
      undo: vi.fn(),
      redo: vi.fn(),
      canUndo: vi.fn(),
      canRedo: vi.fn(),
      deleteSelected: vi.fn(),
      setFill: vi.fn(),
      destroy: vi.fn(),
    } as unknown as DrawingManager;

    session = {
      save: vi.fn(),
      clear: vi.fn(),
      getMapName: vi.fn(),
      setMap: vi.fn(),
      getCurrent: vi.fn(),
    } as unknown as DrawingSession;
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('should render sidebar structure', () => {
    new DrawingSidebar(container, { drawingManager, session });
    expect(container.querySelector('.drawing-sidebar')).toBeTruthy();
  });

  it('should show stroke width and hide font size by default (move tool)', () => {
    new DrawingSidebar(container, { drawingManager, session });

    // Simulate initial render state
    // Note: The constructor calls updateToolUI which sets initial visibility

    const strokeSection = container.querySelector('#stroke-width-section') as HTMLElement;
    const fontSection = container.querySelector('#font-size-section') as HTMLElement;

    expect(strokeSection.style.display).not.toBe('none');
    expect(fontSection.style.display).toBe('none');
  });

  it('should show font size and hide stroke width when text tool is selected', () => {
    // Start with text tool
    (drawingManager.getTool as any).mockReturnValue('text');

    new DrawingSidebar(container, { drawingManager, session });

    const strokeSection = container.querySelector('#stroke-width-section') as HTMLElement;
    const fontSection = container.querySelector('#font-size-section') as HTMLElement;

    expect(strokeSection.style.display).toBe('none');
    expect(fontSection.style.display).toBe('block');
  });

  it('should toggle sections when switching tools', () => {
    const sidebar = new DrawingSidebar(container, { drawingManager, session });

    // Manually trigger tool change logic (simulating click)
    // We can access private method by casting if needed, or by simulating the event
    // Simulating DOM event is better

    const toolButtons = container.querySelectorAll('input[name="drawing-tool"]');
    const textRadio = Array.from(toolButtons).find(b => b.id === 'tool-text') as HTMLInputElement;
    const moveRadio = Array.from(toolButtons).find(b => b.id === 'tool-move') as HTMLInputElement;

    expect(textRadio).toBeTruthy();
    expect(moveRadio).toBeTruthy();

    // Click Text Tool
    textRadio.click();

    expect(drawingManager.setTool).toHaveBeenCalledWith('text');

    const strokeSection = container.querySelector('#stroke-width-section') as HTMLElement;
    const fontSection = container.querySelector('#font-size-section') as HTMLElement;

    expect(strokeSection.style.display).toBe('none');
    expect(fontSection.style.display).toBe('block');

    // Reset spy
    (drawingManager.setTool as any).mockClear();

    // Click Move Tool
    moveRadio.click();

    expect(drawingManager.setTool).toHaveBeenCalledWith('move');

    expect(strokeSection.style.display).toBe('block');
    expect(fontSection.style.display).toBe('none');
  });
});
