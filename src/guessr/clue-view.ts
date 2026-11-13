import { changeClue, maximumScore, type ClueProgress } from "./rules";
import {
  clampCamera,
  moveCamera,
  supportedCamera,
  type ClueSource,
} from "./clue-camera";
import { ClueViewport } from "./clue-viewport";
import { setControlIcon } from "./control-icons";
import { bindAttribute, bindText, formatGuessrNumber, tr } from "./i18n";
import type { AreaDifficulty } from './area-rules';
import { updateRoundIndicators } from './round-status';

let controlId = 0;

/** The camera stays inside the widest clue image. Moving it never moves the answer. */
export function attachClueControls(
  clue: HTMLElement,
  place: ClueSource,
  progress: ClueProgress,
  travelStep: number,
  onChange: () => void,
  options: { compact?: boolean; difficultyTier?: AreaDifficulty | null | (() => AreaDifficulty | null | undefined) } = {},
): () => void {
  const viewport = new ClueViewport(clue, place, travelStep);
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
  clue.before(controls);
  let stopped = false,
    pending = false;
  const buttons: {
    button: HTMLButtonElement;
    anchor: HTMLSpanElement;
    costLabel: HTMLElement;
    target: () => [number, number, number];
    label: string;
  }[] = [];

  const add = (
    parent: HTMLElement,
    label: string,
    icon: Parameters<typeof setControlIcon>[1],
    target: () => [number, number, number],
  ) => {
    const button = document.createElement("button");
    button.id = `guessr-clue-control-${++controlId}`;
    button.type = "button";
    button.className = "btn btn-sm btn-outline theme-secondary clue-control";
    setControlIcon(button, icon, label, false);
    button.addEventListener("click", () => void load(...target()));
    // Keep disabled actions keyboard-readable without an interactive popover.
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
    buttons.push({ button, anchor, costLabel, target, label });
    return button;
  };
  const zoomTarget = (level: number): [number, number, number] => {
    const target = clampCamera(place, { ...progress, level });
    return [target.dx, target.dy, target.level];
  };
  add(zoom, "Zoom in", "zoom-in", () => zoomTarget(progress.level - 1));
  add(zoom, "Zoom out", "zoom-out", () => zoomTarget(progress.level + 1));
  add(zoom, "Return to start", "arrow-counterclockwise", () => [
    0,
    0,
    progress.level,
  ]);
  for (const [label, dx, dy] of [
    ["Travel north", 0, -1],
    ["Travel west", -1, 0],
    ["Travel south", 0, 1],
    ["Travel east", 1, 0],
  ] as const) {
    const direction =
      dy < 0 ? "north" : dy > 0 ? "south" : dx < 0 ? "west" : "east";
    const icon =
      dy < 0
        ? "arrow-up"
        : dy > 0
          ? "arrow-down"
          : dx < 0
            ? "arrow-left"
            : "arrow-right";
    const button = add(pad, label, icon, () => {
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
    for (const { button, anchor, costLabel, target, label } of buttons) {
      const { available, same } = preview(target);
      button.disabled = pending || !available || same;
      anchor.tabIndex = button.disabled ? 0 : -1;
      bindText(costLabel, () => {
        const next = preview(target);
        return !next.available || next.same ? '—' : costText(next.cost);
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
      bindAttribute(button, 'aria-description', hint);
      bindAttribute(anchor, 'aria-description', hint);
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

  async function load(dx: number, dy: number, level: number): Promise<void> {
    if (stopped || pending || !supportedCamera(place, { dx, dy, level }))
      return;
    pending = true;
    error.replaceChildren();
    update();
    try {
      await viewport.show({ dx, dy, level }, () => {
        changeClue(place, progress, dx, dy, level);
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
        retry.onclick = () => void load(dx, dy, level);
        error.append(message, retry);
      }
    } finally {
      pending = false;
      if (!stopped) update();
    }
  }
  void load(progress.dx, progress.dy, progress.level);
  return () => {
    stopped = true;
    viewport.destroy();
    controls.remove();
  };
}
