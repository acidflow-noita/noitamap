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
import { hoverHelp } from './hover-help';

let controlId = 0;

/** The camera stays inside the widest clue image. Moving it never moves the answer. */
export function attachClueControls(
  clue: HTMLElement,
  place: ClueSource,
  progress: ClueProgress,
  travelStep: number,
  onChange: () => void,
  options: { compact?: boolean } = {},
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
  clue.after(controls);
  let stopped = false,
    pending = false;
  let retryHelp: ReturnType<typeof hoverHelp> | undefined;
  const buttons: {
    button: HTMLButtonElement;
    anchor: HTMLSpanElement;
    help: ReturnType<typeof hoverHelp>;
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
    button.className = "small";
    setControlIcon(button, icon, label, false);
    button.addEventListener("click", () => void load(...target()));
    // A disabled button cannot receive hover/focus; its wrapper can explain why.
    const anchor = document.createElement('span');
    anchor.className = 'control-help';
    anchor.setAttribute('aria-labelledby', button.id);
    anchor.append(button); parent.append(anchor);
    const help = hoverHelp(anchor, () => tr(label), button);
    buttons.push({ button, anchor, help, target, label });
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

  function update(): void {
    for (const { button, anchor, help, target, label } of buttons) {
      const [dx, dy, level] = target();
      const next = { ...progress, visited: [...progress.visited] };
      const available = changeClue(place, next, dx, dy, level);
      const same =
        dx === progress.dx && dy === progress.dy && level === progress.level;
      button.disabled = pending || !available || same;
      anchor.tabIndex = button.disabled ? 0 : -1;
      const cost = available ? maximumScore(progress) - maximumScore(next) : 0;
      help.update(() => {
        if (!available) return actionHint(label, tr("No further views"));
        if (same) return button.dataset.direction
          ? actionHint(label, tr(progress.level === 6 ? "Zoom in to move" : "Edge of available area"))
          : tr(label);
        return actionHint(label, cost
          ? tr("Costs {{points}} points", { count: cost, points: formatGuessrNumber(cost) })
          : tr("Free action"));
      });
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
        .join(" · ");
      return position
        ? tr("{{position}} from start. Your original starting spot stays the answer.", { position })
        : tr("The centre marks your starting spot. Zoom out or move to explore.");
    });
  }

  async function load(dx: number, dy: number, level: number): Promise<void> {
    if (stopped || pending || !supportedCamera(place, { dx, dy, level }))
      return;
    pending = true;
    retryHelp?.dispose(); retryHelp = undefined;
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
        retry.className = "small";
        bindText(retry, "Retry image");
        const next = { ...progress, visited: [...progress.visited] };
        changeClue(place, next, dx, dy, level);
        const cost = maximumScore(progress) - maximumScore(next);
        retryHelp = hoverHelp(retry, () => actionHint("Retry image", cost
          ? tr("Costs {{points}} points if the image loads", { count: cost, points: formatGuessrNumber(cost) })
          : tr("Free action")));
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
    retryHelp?.dispose();
    for (const { help } of buttons) help.dispose();
    viewport.destroy();
    controls.remove();
  };
}
