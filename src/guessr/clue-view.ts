import type { CameraAction } from './clue-replay';
import { changeClue, maximumScore, type ClueProgress } from "./rules";
import {
  clampCamera,
  moveCamera,
  supportedCamera,
  type ClueSource,
} from "./clue-camera";
import { ClueViewport } from "./clue-viewport";
import { clueNavigation, setControlIcon } from "./control-icons";
import { bindAttribute, bindText, formatGuessrNumber, tr, onGuessrLanguageChanged } from "./i18n";
import type { AreaDifficulty } from './area-rules';
import { updateRoundIndicators } from './round-status';
import { gameShortcut } from './game-keyboard';
import { Popover } from '../bootstrap';

const shortcuts: Record<string, string> = { 'Travel north': 'W', 'Travel west': 'A', 'Travel south': 'S', 'Travel east': 'D', 'Zoom out': 'Q', 'Zoom in': 'E' };

let controlId = 0;

/** The camera stays inside the widest clue image. Moving it never moves the answer. */
export function attachClueControls(
  clue: HTMLElement,
  place: ClueSource,
  progress: ClueProgress,
  travelStep: number,
  onChange: () => void,
  options: { compact?: boolean; difficultyTier?: AreaDifficulty | null | (() => AreaDifficulty | null | undefined);
    onExplore?: () => void; onCamera?: (camera: import('./clue-camera').Camera, action: CameraAction) => void } = {},
): () => void {
  const viewport = new ClueViewport(clue, place, travelStep);
  clue.setAttribute('aria-keyshortcuts', 'W A S D Q E');
  bindAttribute(clue, 'aria-description', 'Clue controls: W, A, S and D move the view. Q zooms out and E zooms in.');
  const controls = document.createElement("div");
  controls.className = "clue-controls";
  controls.classList.toggle('clue-controls-compact', !!options.compact);
  const zoom = document.createElement("div"),
    toolbar = document.createElement("div"),
    pad = document.createElement("div");
  zoom.className = "camera-zoom";
  zoom.setAttribute("role", "group");
  bindAttribute(zoom, "aria-label", "Zoom and return to start");
  toolbar.className = "camera-controls";
  pad.className = "travel-pad";
  pad.setAttribute("role", "group");
  bindAttribute(pad, "aria-label", "Travel");
  toolbar.append(zoom, pad);
  const description = document.createElement("p");
  description.className = "fine-print";
  description.hidden = !!options.compact;
  const error = document.createElement("p");
  error.className = "error";
  error.setAttribute("role", "status");
  controls.append(toolbar, description, error);
  (clue.closest('.clue-stage') ?? clue).after(controls);
  let stopped = false,
    pending = false;
  const buttons: {
    button: HTMLButtonElement;
    anchor: HTMLSpanElement;
    costLabel: HTMLElement;
    target: () => [number, number, number];
    label: string;
    shortcut?: string;
    popover?: InstanceType<typeof Popover>;
  }[] = [];

  const add = (
    parent: HTMLElement,
    action: keyof typeof clueNavigation,
    target: () => [number, number, number],
  ) => {
    const [icon, label] = clueNavigation[action];
    const button = document.createElement("button");
    button.id = `guessr-clue-control-${++controlId}`;
    button.type = "button";
    button.className = "btn btn-sm btn-outline theme-secondary clue-control";
    setControlIcon(button, icon, label, false);
    button.addEventListener("click", () => void load(...target(), action));
    // The drawing toolbar's hotkey-letter presentation, including disabled controls.
    const anchor = document.createElement('span');
    anchor.className = 'control-help focus-ring';
    anchor.setAttribute('aria-labelledby', button.id);
    anchor.append(button); parent.append(anchor);
    const costLabel = document.createElement('small');
    costLabel.className = 'clue-control-cost';
    const price = document.createElement('span'); price.className = 'clue-control-price';
    price.append(costLabel);
    for (const source of [() => tr('Free'), () => formatGuessrNumber(-5000)]) {
      const sizer = document.createElement('small'); sizer.className = 'clue-control-cost-sizer';
      sizer.setAttribute('aria-hidden', 'true'); bindText(sizer, source); price.append(sizer);
    }
    button.append(price);
    const shortcut = shortcuts[label];
    let popover: InstanceType<typeof Popover> | undefined;
    if (shortcut) {
      const letter = document.createElement('span'); letter.className = 'hotkey-letter'; letter.textContent = shortcut;
      letter.setAttribute('aria-hidden', 'true'); button.append(letter);
      button.setAttribute('aria-keyshortcuts', shortcut);
      const content = letter.cloneNode(true) as HTMLElement;
      content.removeAttribute('aria-hidden');
      popover = new Popover(anchor, { title: () => tr(label), content, html: true, trigger: 'hover focus',
        placement: 'top', container: 'body', animation: false, delay: { show: 80, hide: 120 } });
      anchor.addEventListener('show.bs.popover', event => {
        if (typeof matchMedia === 'function' && matchMedia('(hover: none), (pointer: coarse)').matches && !anchor.matches(':focus-visible') && !button.matches(':focus-visible')) event.preventDefault();
      });
    }
    buttons.push({ button, anchor, costLabel, target, label, shortcut, popover });
    return button;
  };
  const zoomTarget = (level: number): [number, number, number] => {
    const target = clampCamera(place, { ...progress, level });
    return [target.dx, target.dy, target.level];
  };
  add(zoom, "zoom-in", () => zoomTarget(progress.level - 1));
  add(zoom, "zoom-out", () => zoomTarget(progress.level + 1));
  add(zoom, "return", () => [
    0,
    0,
    progress.level,
  ]);
  for (const [action, direction, dx, dy] of [
    ["up", "north", 0, -1],
    ["left", "west", -1, 0],
    ["down", "south", 0, 1],
    ["right", "east", 1, 0],
  ] as const) {
    const button = add(pad, action, () => {
      const next = moveCamera(place, progress, dx, dy);
      return [next.dx, next.dy, next.level];
    });
    button.dataset.direction = direction;
    button.parentElement!.dataset.direction = direction;
  }

  const actionHint = (label: string, hint: string) =>
    tr("{{action}} — {{hint}}", { action: tr(label), hint });

  function preview(target: () => [number, number, number]) {
    const [dx, dy, level] = target();
    const next = { ...progress, visited: [...progress.visited] };
    const available = changeClue(place, next, dx, dy, level);
    const same = dx === progress.dx && dy === progress.dy && level === progress.level;
    return { available, same, cost: available ? maximumScore(progress) - maximumScore(next) : 0 };
  }
  function costText(cost: number) {
    return cost ? formatGuessrNumber(-cost) : tr('Free');
  }

  function update(): void {
    updateRoundIndicators(clue.closest('.game-grid, .stream-viewer-layout') ?? clue.parentElement!, progress,
      typeof options.difficultyTier === 'function' ? options.difficultyTier() : options.difficultyTier);
    for (const { button, anchor, costLabel, target, label, shortcut } of buttons) {
      const { available, same } = preview(target);
      // The round owns the toolbar's inert state. It can unlock after this draw.
      button.disabled = pending || !available || same;
      anchor.tabIndex = button.disabled ? 0 : -1;
      bindText(costLabel, () => {
        const next = preview(target);
        return !next.available || next.same ? '—' : costText(next.cost);
      });
      bindAttribute(costLabel.parentElement!, 'data-compact-cost', () => {
        const next = preview(target);
        return next.available && !next.same ? formatGuessrNumber(-next.cost || 0) : '—';
      });
      const hint = () => {
        const { available, same, cost } = preview(target);
        if (!available) return actionHint(label, tr("No further views"));
        if (same) return button.dataset.direction
          ? actionHint(label, tr(progress.level === 6 ? "Zoom in to move" : "Edge of available area"))
          : actionHint(label, tr(label === 'Return to start' ? 'Already at the starting position' : 'No further views'));
        return actionHint(label, cost
          ? tr("Costs {{points}} points", { count: cost, points: formatGuessrNumber(cost) })
          : tr("Free action"));
      };
      bindAttribute(button, 'aria-description', () => hint() + (shortcut ? ` (${shortcut})` : ''));
      bindAttribute(anchor, 'aria-description', () => hint() + (shortcut ? ` (${shortcut})` : ''));
    }
    bindText(description, () => {
      const position = [
        progress.dy
          ? tr(progress.dy < 0 ? "{{distance}} px north" : "{{distance}} px south", {
            distance: formatGuessrNumber(Math.abs(progress.dy)),
          })
          : "",
        progress.dx
          ? tr(progress.dx < 0 ? "{{distance}} px west" : "{{distance}} px east", {
            distance: formatGuessrNumber(Math.abs(progress.dx)),
          })
          : "",
      ]
        .filter(Boolean)
        .join(", ");
      return position
        ? tr("{{position}} from start. Your original starting spot stays the answer.", { position })
        : tr("The centre marks your starting spot. Zoom out or move to explore.");
    });
  }

  async function load(dx: number, dy: number, level: number, action: CameraAction = 'view'): Promise<void> {
    if (stopped || controls.inert || pending || !supportedCamera(place, { dx, dy, level }))
      return;
    pending = true;
    error.replaceChildren();
    update();
    try {
      const explored = level > progress.level || level === progress.level && (dx !== progress.dx || dy !== progress.dy);
      await viewport.show({ dx, dy, level }, () => {
        changeClue(place, progress, dx, dy, level);
        options.onCamera?.({ dx, dy, level }, action);
        if (explored) options.onExplore?.();
        onChange();
        update();
      });
    } catch {
      if (!stopped) {
        const message = bindText(document.createTextNode(""), () =>
          `${tr("Image could not load. No points were charged.")} `);
        const retry = document.createElement("button");
        retry.type = "button";
        retry.className = "btn btn-sm btn-outline theme-secondary clue-retry";
        const retryLabel = document.createElement('span'); bindText(retryLabel, 'Retry image');
        const retryCost = document.createElement('small'); retryCost.className = 'clue-control-cost';
        const target = (): [number, number, number] => [dx, dy, level];
        bindText(retryCost, () => costText(preview(target).cost));
        bindAttribute(retry, 'aria-description', () => {
          const { cost } = preview(target);
          return actionHint('Retry image', cost
            ? tr('Costs {{points}} points if the image loads', { count: cost, points: formatGuessrNumber(cost) })
            : tr('Free action'));
        });
        retry.append(retryLabel, retryCost);
        retry.onclick = () => void load(dx, dy, level, action);
        error.append(message, retry);
      }
    } finally {
      pending = false;
      if (!stopped) update();
    }
  }
  let lastKey = 0;
  const keydown = (event: KeyboardEvent) => {
    if (stopped || controls.inert || !clue.isConnected || clue.closest('[hidden], [inert]') || !gameShortcut(event)) return;
    const labels: Record<string, string> = { KeyW: 'Travel north', KeyA: 'Travel west', KeyS: 'Travel south', KeyD: 'Travel east', KeyQ: 'Zoom out', KeyE: 'Zoom in' };
    const label = labels[event.code] ?? ({ w: 'Travel north', a: 'Travel west', s: 'Travel south', d: 'Travel east', q: 'Zoom out', e: 'Zoom in' } as Record<string, string>)[event.key.toLowerCase()];
    if (!label) return;
    event.preventDefault();
    if (event.repeat && performance.now() - lastKey < 180) return;
    const control = buttons.find(item => item.label === label);
    if (!control || control.button.disabled) return;
    lastKey = performance.now(); control.button.click();
  };
  document.addEventListener('keydown', keydown);
  const unsubscribeKeys = onGuessrLanguageChanged(() => {
    for (const { popover, label, shortcut } of buttons) if (popover) {
      const key = document.createElement('span'); key.className = 'hotkey-letter'; key.textContent = shortcut!;
      popover.setContent({ '.popover-header': tr(label), '.popover-body': key });
    }
  });
  void load(progress.dx, progress.dy, progress.level);
  return () => {
    stopped = true;
    document.removeEventListener('keydown', keydown);
    unsubscribeKeys(); for (const { popover } of buttons) popover?.dispose();
    viewport.destroy();
    controls.remove();
  };
}
