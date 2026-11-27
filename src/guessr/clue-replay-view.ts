import { revealReviewPreview, reviewAccordionHeader } from './review-accordion-header';
import { gameFetch } from './quota-state';
import { ClueViewport } from './clue-viewport';
import { ReplayMotion, REPLAY_MOVE_MS } from './replay-motion';
import { HIGHLIGHT_PIN_HEIGHT } from './map-pin';
import { clueNavigation } from './control-icons';
import { gameApiOrigin } from './api-origin';
import { MapBoard } from './map-board';
import type { ImageGameConfig } from './image-game';
import type { Point } from './rules';
import type { ReplayLoader, ReplayStep } from './clue-replay';
import { bindAttribute, bindText, formatGuessrNumber, guessrGameTerm, guessrLocale, tr } from './i18n';

export function publishedReplayLoader(game: string): ReplayLoader {
  return async (round, player, signal) => {
    const origin = gameApiOrigin();
    if (!origin) return null;
    const response = await gameFetch(
      `${origin}/api/streams/results/${encodeURIComponent(game)}/rounds/${round}/replays/${encodeURIComponent(player)}`,
      { signal }
    );
    if (response.status === 404) return null;
    if (!response.ok) throw Error('Replay unavailable');
    return response.json();
  };
}
const actions = {
  view: ['eye', 'Clue view'],
  ...clueNavigation,
  submit: ['geo-alt-fill', 'Sent guess'],
  update: ['geo-fill', 'Updated guess'],
  automatic: ['stopwatch', 'Automatic guess'],
} as const;

function glyph(icon: string): HTMLElement {
  const el = document.createElement('i');
  el.className = 'bi bi-' + icon;
  el.setAttribute('aria-hidden', 'true');
  return el;
}
function control(label: string, icon?: string) {
  const el = document.createElement('button');
  el.type = 'button';
  el.className = 'btn btn-sm btn-outline theme-secondary';
  if (icon) el.append(glyph(icon));
  el.append(bindText(document.createElement('span'), label));
  return el;
}
interface ReplayRound {
  number: number;
  answer: Point;
  location: string;
}
let tableSequence = 0;
const activeReplays = new WeakMap<Element, () => void>();

/** A results page has one player replay. Sorting keeps it attached to its score. */
export function createReplayRows(load: ReplayLoader, config?: ImageGameConfig) {
  const prefix = 'score-replay-' + ++tableSequence;
  let active:
    | {
        player: string;
        round: number;
        scope: Element;
        row: HTMLTableRowElement;
        trigger: HTMLButtonElement;
        destroy(): void;
      }
    | undefined;
  function close(restoreFocus = false) {
    const entry = active;
    if (!entry) return;
    active = undefined;
    activeReplays.delete(entry.scope);
    entry.trigger.setAttribute('aria-expanded', 'false');
    entry.destroy();
    entry.row.remove();
    if (restoreFocus && entry.trigger.isConnected) entry.trigger.focus({ preventScroll: true });
  }
  function scoreButton(player: { id: string; name: string }, round: ReplayRound) {
    const id = prefix + '-' + player.id + '-' + round.number;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn btn-icon btn-outline theme-secondary clue-replay-open';
    button.append(glyph('play-fill'));
    const label = () =>
      tr('Replay for {{player}}', { player: player.name }) +
      ', ' +
      tr('Round {{round}}', { round: formatGuessrNumber(round.number) });
    bindAttribute(button, 'aria-label', label);
    bindAttribute(button, 'title', label);
    button.setAttribute('aria-controls', id);
    if (active?.player === player.id && active.round === round.number) active.trigger = button;
    button.setAttribute('aria-expanded', String(active?.trigger === button));
    let pressedBounds: DOMRect | undefined;
    button.onpointerdown = event => {
      if (!event.isPrimary || event.button !== 0) return;
      // A pending replay can resize the table between press and release.
      pressedBounds = button.getBoundingClientRect();
      button.setPointerCapture(event.pointerId);
    };
    button.onpointercancel = () => { pressedBounds = undefined; };
    button.onclick = event => {
      const bounds = pressedBounds;
      pressedBounds = undefined;
      if (bounds && event.detail > 0) {
        const { clientX: x, clientY: y } = event;
        const endedOnOriginalButton = x >= bounds.left && x < bounds.right && y >= bounds.top && y < bounds.bottom;
        if (!endedOnOriginalButton && !button.contains(document.elementFromPoint(x, y))) return;
      }
      const source = button.closest('tr');
      if (!source?.isConnected) return;
      if (active?.player === player.id && active.round === round.number) {
        close();
        return;
      }
      const scope =
        source.closest('.stream-results') ?? source.closest('.stream-result-reviews') ?? source.closest('table')!;
      const closePrevious = activeReplays.get(scope);
      const row = document.createElement('tr');
      row.className = 'score-replay-row';
      row.dataset.player = player.id;
      const cell = row.insertCell();
      cell.colSpan = source.cells.length;
      const slot = document.createElement('div');
      slot.className = 'accordion score-replay-disclosure';
      slot.id = id;
      cell.append(slot);
      source.after(row);
      const destroy = openClueReplay(player.id, player.name, round, load, {
        mount: slot,
        config,
        onToggle: isOpen => {
          if (!isOpen && active?.row === row) close(slot.contains(document.activeElement));
        },
      });
      // Keep the table tall enough to retain its scroll position throughout the switch.
      closePrevious?.();
      const frame = source.closest<HTMLElement>('.inline-round-review .stream-round-score-scroll');
      const size =
        frame && typeof ResizeObserver !== 'undefined'
          ? new ResizeObserver(() => {
              frame.style.setProperty('--open-replay-height', row.offsetHeight + 'px');
            })
          : undefined;
      size?.observe(row);
      active = {
        player: player.id,
        round: round.number,
        row,
        scope,
        trigger: button,
        destroy() {
          size?.disconnect();
          frame?.style.removeProperty('--open-replay-height');
          destroy();
        },
      };
      activeReplays.set(scope, close);
      button.setAttribute('aria-expanded', 'true');
    };
    return button;
  }
  function appendAfterScore(parent: DocumentFragment, player: string) {
    if (active?.player === player) parent.append(active.row);
  }
  function discardHidden() {
    if (active && !active.trigger.isConnected) close();
  }
  return {
    scoreButton,
    appendAfterScore,
    discardHidden,
    destroy: close,
  };
}
const MIN_STEP_WIDTH = 32;
const STEP_HOLD_MS = 500;

/** The selected score opens one round in a native accordion. Closing stops playback and pending image work. */
export function openClueReplay(
  player: string,
  name: string,
  round: ReplayRound,
  load: ReplayLoader,
  context: { mount: HTMLElement; config?: ImageGameConfig; onToggle?: (open: boolean) => void }
): () => void {
  const item = document.createElement('details');
  item.className = 'accordion-item replay-item border rounded-9 overflow-hidden';
  const { toggle, thumb } = reviewAccordionHeader(
    () =>
      [tr('Round {{round}}', { round: formatGuessrNumber(round.number) }), guessrGameTerm(round.location)]
        .filter(Boolean)
        .join(' — '),
    () => tr('Replay for {{player}}', { player: name })
  );
  const panel = document.createElement('div');
  panel.className = 'accordion-body clue-replay-panel';
  item.append(toggle, panel);
  item.open = true;
  context.mount.append(item);
  const toolbar = document.createElement('div');
  toolbar.className = 'clue-replay-toolbar';
  const play = control('Play all', 'play-fill');
  play.classList.add('replay-play');
  toolbar.append(play);
  const stage = document.createElement('div');
  stage.className = 'clue-replay-stage border rounded-9 overflow-hidden';
  const clue = document.createElement('div');
  clue.className = 'clue';
  const badge = document.createElement('span');
  badge.className = 'replay-action-badge';
  badge.setAttribute('aria-hidden', 'true');
  stage.append(clue, badge);
  const status = document.createElement('p');
  status.className = 'replay-status';
  status.setAttribute('role', 'status');
  const retry = control('Retry');
  retry.hidden = true;
  const timeline = document.createElement('div');
  timeline.className = 'replay-timeline';
  timeline.setAttribute('role', 'group');
  bindAttribute(timeline, 'aria-label', 'Action timeline');
  const strip = document.createElement('ol');
  strip.className = 'stepper stepper-horizontal replay-step-strip';
  const timeMeasure = document.createElement('small');
  timeMeasure.className = 'replay-step-time replay-time-measure';
  timeMeasure.setAttribute('aria-hidden', 'true');
  timeline.append(strip, timeMeasure);
  const content = document.createElement('div');
  content.className = 'replay-content';
  content.append(stage, timeline, toolbar, status, retry);
  panel.append(content);

  let viewport: ClueViewport | undefined, request: AbortController | undefined;
  let motion: ReplayMotion | undefined;
  type GuessMap = { element: HTMLDivElement; board?: MapBoard };
  let currentMap: GuessMap | undefined, outgoingMap: GuessMap | undefined;
  function removeMap(view: GuessMap | undefined) {
    if (!view) return;
    view.board?.destroy();
    view.element.remove();
  }
  function interrupt() {
    motion?.cancel();
    viewport?.stop();
    removeMap(outgoingMap);
    outgoingMap = undefined;
  }
  function reveal() {
    const row = item.closest('tr')?.previousElementSibling;
    revealReviewPreview(content, toggle, row instanceof HTMLElement ? row : undefined);
  }
  let steps: ReplayStep[] = [],
    priorCamera: number[] = [],
    priorGuess: number[] = [];
  let active = -1,
    run = 0,
    paint = 0,
    rendering = false,
    dead = false,
    playing = false;
  let timeout: ReturnType<typeof setTimeout> | undefined, fade: ReturnType<typeof setTimeout> | undefined;
  const nodes = new Map<number, HTMLButtonElement>();
  const stamp = (sec: number) =>
    new Intl.NumberFormat(guessrLocale(), { style: 'unit', unit: 'second', unitDisplay: 'narrow' }).format(sec);
  const label = (index: number) =>
    index === 0 && steps[index].action === 'view' ? 'Started view' : actions[steps[index].action][1];
  let thumbnail: ClueViewport | undefined;
  let cached: Awaited<ReturnType<ReplayLoader>> | undefined;
  function setPlaying(value: boolean) {
    if (playing === value) return;
    playing = value;
    run++;
    clearTimeout(timeout);
    play.replaceChildren(
      glyph(value ? 'pause-fill' : 'play-fill'),
      bindText(document.createElement('span'), value ? 'Pause' : 'Play all')
    );
  }
  let columns = 1,
    rowHeight = 56;
  function layoutSteps() {
    if (!steps.length) return;
    const width = timeline.clientWidth || 520;
    const minWidth = Math.max(MIN_STEP_WIDTH, Math.ceil(timeMeasure.getBoundingClientRect().width) + 2);
    const rows = Math.ceil(steps.length / Math.max(1, Math.floor(width / minWidth)));
    columns = Math.ceil(steps.length / rows);
    const target = Math.min(Math.max(40, minWidth), width / columns);
    strip.style.gridTemplateColumns = `repeat(${columns}, ${target}px)`;
    strip.style.gridTemplateRows = `repeat(${rows}, var(--replay-step-row))`;
    strip.style.setProperty('--bs-stepper-gap', (columns > 1 ? (width - columns * target) / (columns - 1) : 0) + 'px');
    rowHeight = parseFloat(getComputedStyle(strip).gridAutoRows) || 56;
    renderStrip();
  }
  function moveIntoView(index: number) {
    const top = Math.floor(index / columns) * rowHeight;
    const height = timeline.clientHeight || 4 * rowHeight;
    if (top < timeline.scrollTop) timeline.scrollTop = top;
    else if (top + rowHeight > timeline.scrollTop + height) timeline.scrollTop = top + rowHeight - height;
  }
  function renderStrip() {
    // A long recording scrolls continuously. Mount the visible rows and one extra on each side.
    const height = timeline.clientHeight || 4 * rowHeight;
    const start = columns * Math.max(0, Math.floor(timeline.scrollTop / rowHeight) - 1);
    const end = Math.min(steps.length, columns * (Math.ceil((timeline.scrollTop + height) / rowHeight) + 1));
    for (const [i, node] of nodes)
      if (i < start || i >= end) {
        node.parentElement?.remove();
        nodes.delete(i);
      }
    for (let i = start; i < end; i++) {
      let node = nodes.get(i);
      if (!node) {
        node = document.createElement('button');
        node.type = 'button';
        node.className = 'replay-step';
        node.dataset.step = String(i);
        const step = steps[i],
          circle = glyph(actions[step.action][0]);
        circle.classList.add('replay-step-icon');
        const time = document.createElement('small');
        time.className = 'replay-step-time';
        bindText(time, () => stamp(step.second));
        node.append(circle, time);
        bindAttribute(node, 'aria-label', () => tr(label(i)) + ', ' + stamp(step.second));
        bindAttribute(node, 'title', () => tr(label(i)));
        const preview = () => {
          setPlaying(false);
          if (active !== i) void display(i);
        };
        node.onpointerenter = e => {
          if (e.pointerType !== 'touch') {
            setPlaying(false);
            void display(i);
          }
        };
        node.onfocus = preview;
        node.onclick = () => {
          setPlaying(false);
          if (active !== i || !rendering) void display(i);
        };
        const next = strip.children[i - start] ?? null;
        const entry = document.createElement('li');
        entry.className = 'stepper-item';
        entry.append(node);
        strip.insertBefore(entry, next);
        nodes.set(i, node);
      }
      const entry = node.parentElement!;
      entry.style.gridColumn = String((i % columns) + 1);
      entry.style.gridRow = String(Math.floor(i / columns) + 1);
      entry.classList.toggle('replay-row-end', (i + 1) % columns === 0);
      entry.classList.toggle('active', i === active);
      node.tabIndex = i === (active >= start && active < end ? active : start) ? 0 : -1;
      if (i === active) node.setAttribute('aria-current', 'step');
      else node.removeAttribute('aria-current');
    }
  }
  async function display(i: number, presented?: () => void): Promise<boolean> {
    const serial = ++paint,
      step = steps[i];
    if (dead || !step || !viewport) return false;
    interrupt();
    const movement = motion = new ReplayMotion();
    rendering = true;
    active = i;
    renderStrip();
    clearTimeout(fade);
    const announce = () => {
      if (dead || paint !== serial) return;
      presented?.();
      badge.replaceChildren(glyph(actions[step.action][0]), bindText(document.createElement('span'), label(i)));
      badge.classList.add('visible');
      fade = setTimeout(() => badge.classList.remove('visible'), 1150);
    };
    try {
      if ('camera' in step) {
        const previous = steps[priorCamera[i]];
        const transition = previous && 'camera' in previous ? { replayFrom: previous.camera, motion: movement } : false;
        let fade: Promise<boolean> | undefined;
        const drawn = await viewport.show(step.camera, () => {
          if (serial !== paint || dead) return;
          announce();
          clue.inert = false;
          if (currentMap) {
            outgoingMap = currentMap;
            currentMap = undefined;
            outgoingMap.element.inert = true;
            outgoingMap.element.style.opacity = '0';
            fade = movement.animate(outgoingMap.element, [{ opacity: 1 }, { opacity: 0 }]);
          }
        }, transition);
        if (fade) await fade;
        return drawn && serial === paint;
      }
      outgoingMap = currentMap;
      if (outgoingMap) outgoingMap.element.inert = true;
      const map = document.createElement('div');
      map.className = 'map-board replay-guess-map';
      badge.before(map);
      currentMap = { element: map };
      clue.inert = true;
      const config = context.config, answer = round.answer;
      let pinMotion: Promise<boolean> | undefined;
      if (config && answer) {
        const board = currentMap.board = new MapBoard(map, config.bounds, config.overview, () => {}, config.map);
        board.setLocked(true);
        const previous = steps[priorGuess[i]];
        const pins = [{ id: 'current', name, guess: step.point, color: '#56b9ff' }];
        if (previous && 'point' in previous)
          pins.push({ id: 'previous', name: tr('Previous guess'), guess: previous.point, color: '#a2aab9' });
        board.setPlayers(pins, answer, () => {});
        const pin = board.highlightPlayer('current');
        if (pin && !movement.reduced) {
          // Keep the board's SVG positioning on the pin. Translate its parent in world coordinates.
          const carrier = document.createElementNS('http://www.w3.org/2000/svg', 'g');
          pin.before(carrier);
          carrier.append(pin);
          const prior = previous && 'point' in previous ? previous.point : undefined;
          const worldScale = board.svg.getScreenCTM()?.a || 1;
          const dx = prior ? prior.x - step.point.x : 0;
          const dy = prior ? prior.y - step.point.y : -HIGHLIGHT_PIN_HEIGHT / (2 * worldScale);
          pinMotion = movement.animate(carrier, [
            { transform: `translate(${dx}px, ${dy}px)`, opacity: dx || dy ? 1 : 0.4 },
            { transform: 'translate(0px, 0px)', opacity: 1 },
          ]);
        }
      } else map.textContent = formatGuessrNumber(step.point.x) + ', ' + formatGuessrNumber(step.point.y);
      announce();
      await Promise.all([movement.animate(map, [{ opacity: 0 }, { opacity: 1 }]), pinMotion]);
      return serial === paint && !dead;
    } catch {
      if (serial === paint && !dead) {
        setPlaying(false);
        bindText(status, 'Preview unavailable');
        status.hidden = false;
        retry.hidden = false;
      }
      return false;
    } finally {
      if (serial === paint) {
        removeMap(outgoingMap);
        outgoingMap = undefined;
        rendering = false;
      }
    }
  }
  async function sequence(index: number, token: number) {
    moveIntoView(index);
    let presentedAt = performance.now();
    if (!(await display(index, () => { presentedAt = performance.now(); })) || dead || !playing || token !== run) return;
    if (index + 1 === steps.length) {
      setPlaying(false);
      return;
    }
    const initialView = index === 0 && steps[index].action === 'view';
    const remaining = initialView ? 0 : Math.max(0, REPLAY_MOVE_MS - (performance.now() - presentedAt));
    timeout = setTimeout(() => void sequence(index + 1, token), remaining + STEP_HOLD_MS);
  }
  async function selectRound() {
    request?.abort();
    paint++;
    setPlaying(false);
    clearTimeout(fade);
    interrupt();
    viewport?.destroy();
    viewport = undefined;
    removeMap(currentMap);
    currentMap = undefined;
    clue.inert = false;
    steps = [];
    active = -1;
    nodes.clear();
    strip.replaceChildren();
    timeline.scrollTop = 0;
    stage.hidden = false;
    timeline.hidden = toolbar.hidden = retry.hidden = true;
    status.hidden = false;
    bindText(status, 'Loading…');
    badge.classList.remove('visible');
    const controller = (request = new AbortController());
    try {
      const data = cached === undefined ? await load(round.number, player, controller.signal) : cached;
      if (controller.signal.aborted || dead) return;
      cached = data;
      if (data && !thumbnail) {
        thumbnail = new ClueViewport(thumb, data.clue);
        void thumbnail.show({ dx: 0, dy: 0, level: 0 }).catch(() => {});
      }
      if (!data?.steps?.length) {
        stage.hidden = true;
        bindText(status, 'No replay was recorded for this round.');
        return;
      }
      steps = data.steps;
      const lastSecond = steps.reduce((end, step) => Math.max(end, step.second), 0);
      bindText(timeMeasure, () => stamp(lastSecond));
      priorCamera = [];
      priorGuess = [];
      let cam = -1,
        guess = -1;
      steps.forEach((step, i) => {
        priorCamera.push(cam);
        priorGuess.push(guess);
        if ('camera' in step) cam = i;
        else guess = i;
      });
      viewport = new ClueViewport(clue, data.clue);
      stage.hidden = timeline.hidden = false;
      layoutSteps();
      toolbar.hidden = play.hidden = steps.length < 2;
      status.hidden = !data.partial;
      if (data.partial) bindText(status, 'Recording limit reached');
      await display(0);
    } catch {
      if (!controller.signal.aborted) {
        stage.hidden = !viewport;
        status.hidden = false;
        bindText(status, 'Preview unavailable');
        retry.hidden = false;
      }
    }
  }
  play.onclick = () => {
    if (playing) {
      setPlaying(false);
      motion?.pause();
    }
    else {
      setPlaying(true);
      void sequence(0, run);
    }
  };
  timeline.onscroll = renderStrip;
  timeline.onkeydown = event => {
    const target = event.target;
    if (!(target instanceof HTMLButtonElement)) return;
    const i = Number(target.dataset.step);
    const next = (
      {
        ArrowLeft: Math.max(0, i - 1),
        ArrowRight: Math.min(steps.length - 1, i + 1),
        ArrowUp: Math.max(0, i - columns),
        ArrowDown: Math.min(steps.length - 1, i + columns),
        Home: 0,
        End: steps.length - 1,
      } as Record<string, number>
    )[event.key];
    if (next === undefined) return;
    event.preventDefault();
    moveIntoView(next);
    renderStrip();
    nodes.get(next)?.focus({ preventScroll: true });
  };
  const resize = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(layoutSteps) : undefined;
  resize?.observe(timeline);
  resize?.observe(timeMeasure);
  retry.onclick = () => {
    cached = undefined;
    void selectRound();
    reveal();
  };
  item.addEventListener('toggle', () => {
    if (dead) return;
    context.onToggle?.(item.open);
    if (dead) return;
    if (item.open) {
      if (!request || request.signal.aborted) void selectRound();
    } else {
      setPlaying(false);
      paint++;
      request?.abort();
      clearTimeout(fade);
      interrupt();
      viewport?.destroy();
      viewport = undefined;
      removeMap(currentMap);
      currentMap = undefined;
    }
  });
  void selectRound();
  reveal();
  return () => {
    dead = true;
    paint++;
    request?.abort();
    clearTimeout(timeout);
    clearTimeout(fade);
    resize?.disconnect();
    interrupt();
    viewport?.destroy();
    thumbnail?.destroy();
    removeMap(currentMap);
    currentMap = undefined;
    item.remove();
  };
}
