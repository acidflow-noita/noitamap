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
import { playbackSteps, type PlaybackStep, type ReplayLoader } from './clue-replay';
import type { MapPose } from './guess-map-replay';
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
  'map-view': ['map', 'Guess map'],
  'map-pan': ['arrows-move', 'Pan guess map'],
  'map-zoom-in': ['zoom-in', 'Zoom in'],
  'map-zoom-out': ['zoom-out', 'Zoom out'],
  'map-home': ['map', 'Show entire map'],
  'map-center': ['geo-alt', 'Center map on marker'],
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

/** One full-width replay per results page. Sorting rebinds the return button by player and round. */
export function createScoreReplay(load: ReplayLoader, anchor: HTMLElement, config?: ImageGameConfig) {
  const prefix = 'score-replay-' + ++tableSequence;
  let active:
    | {
        player: string;
        round: number;
        scope: Element;
        panel: HTMLElement;
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
    entry.panel.remove();
    if (restoreFocus && entry.trigger.isConnected) {
      entry.trigger.focus({ preventScroll: true });
      entry.trigger.scrollIntoView?.({ block: 'center', inline: 'nearest', behavior: 'instant' });
    }
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
      closePrevious?.();
      const panel = document.createElement('section');
      panel.className = 'accordion score-replay-disclosure';
      panel.id = id;
      panel.dataset.player = player.id;
      panel.dataset.round = String(round.number);
      anchor.before(panel);
      const destroy = openClueReplay(player.id, player.name, round, load, {
        mount: panel, config, onToggle: open => { if (!open && active?.panel === panel) close(true); },
      });
      active = { player: player.id, round: round.number, panel, scope, trigger: button, destroy };
      panel.querySelector('summary')?.focus({preventScroll:true});
      panel.scrollIntoView?.({block:'start', inline:'nearest', behavior:'instant'});
      activeReplays.set(scope, close);
      button.setAttribute('aria-expanded', 'true');
    };
    return button;
  }
  function discardHidden() {
    if (active && !active.trigger.isConnected) close();
  }

  return {
    scoreButton,
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
  const play = control('Pause', 'pause-fill');
  play.classList.add('replay-play');
  const closeButton = control('Close', 'x-lg');
  closeButton.onclick = () => { item.open = false; context.onToggle?.(false); };
  toolbar.append(play, closeButton);
  const stage = document.createElement('div');
  stage.className = 'clue-replay-stage border rounded-9 overflow-hidden';
  const clue = document.createElement('div');
  clue.className = 'clue';
  const badge = document.createElement('span');
  badge.className = 'replay-action-badge';
  badge.setAttribute('aria-hidden', 'true');
  const boards = document.createElement('div'); boards.className = 'replay-boards';
  function pane(title: string, kind: string, surface: HTMLElement) {
    const figure = document.createElement('figure'); figure.className = 'replay-pane'; figure.dataset.board = kind;
    figure.append(bindText(document.createElement('figcaption'), title), surface); boards.append(figure);
    return figure;
  }
  stage.append(clue, badge);
  pane('Clue map', 'clue', stage);
  const mapStage = document.createElement('div'); mapStage.className = 'replay-map-stage border rounded-9 overflow-hidden';
  const guessPane = pane('Guess map', 'guess', mapStage);
  const mapNote = bindText(document.createElement('span'), 'No guess-map movement was recorded.');
  mapNote.className = 'replay-map-note'; mapStage.append(mapNote);
  const switches = document.createElement('div'); switches.className = 'replay-board-switch';
  switches.setAttribute('role','group'); bindAttribute(switches,'aria-label','Replay view');
  let selection: 'follow' | 'clue' | 'guess' = 'follow', actionBoard = 'clue';
  function selectBoard() {
    boards.dataset.visible = selection === 'follow' ? actionBoard : selection;
    for (const button of switches.querySelectorAll('button'))
      button.setAttribute('aria-pressed', String(button.dataset.view === selection));
  }
  for (const [view, text] of [['follow','Follow actions'],['clue','Clue map'],['guess','Guess map']] as const) {
    const button = control(text); button.dataset.view = view;
    button.onclick = () => { selection = view; selectBoard(); };
    switches.append(button);
  }
  selectBoard();
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
  content.append(switches, boards, timeline, toolbar, status, retry);
  panel.append(content);

  let viewport: ClueViewport | undefined, request: AbortController | undefined;
  let motion: ReplayMotion | undefined;
  let board: MapBoard | undefined, mapSurface: HTMLDivElement | undefined, initialMap: MapPose | undefined;
  let shownClue = -2, shownGuess = -2, shownMap = -2;
  function removeMap() {
    board?.destroy(); board = undefined; mapSurface?.remove(); mapSurface = undefined;
    shownClue = shownGuess = shownMap = -2;
  }
  function interrupt() { motion?.cancel(); viewport?.stop(); }
  function reveal() { revealReviewPreview(boards, toggle); }
  let steps: PlaybackStep[] = [], priorCamera: number[] = [], priorGuess: number[] = [], priorMap: number[] = [];
  let active = -1,
    run = 0,
    paint = 0,
    rendering = false,
    dead = false;
  let playback: 'playing' | 'paused' | 'finished' = 'paused';
  let sequencing = false;
  let nextStep: { index: number; delay: number; due: number } | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined, fade: ReturnType<typeof setTimeout> | undefined;
  const nodes = new Map<number, HTMLButtonElement>();
  const stamp = (sec: number) =>
    new Intl.NumberFormat(guessrLocale(), { style: 'unit', unit: 'second', unitDisplay: 'narrow' }).format(sec);
  const label = (index: number) =>
    index === 0 && steps[index].action === 'view' ? 'Started view' : actions[steps[index].action][1];
  const stepTitle = (index: number) => 'map' in steps[index] && !['map-view','map-pan'].includes(steps[index].action)
    ? tr('Guess map') + ' — ' + tr(label(index)) : tr(label(index));
  let thumbnail: ClueViewport | undefined;
  let cached: Awaited<ReturnType<ReplayLoader>> | undefined;
  function setPlayback(state: typeof playback) {
    playback = state;
    play.replaceChildren(
      glyph(state === 'playing' ? 'pause-fill' : state === 'finished' ? 'arrow-counterclockwise' : 'play-fill'),
      bindText(document.createElement('span'), state === 'playing' ? 'Pause' : state === 'finished' ? 'Replay' : 'Resume playback')
    );
  }
  function stopSequence(finished = false) {
    ++run;
    clearTimeout(timeout);
    nextStep = undefined;
    sequencing = false;
    setPlayback(finished ? 'finished' : 'paused');
  }
  function scheduleNext() {
    if (!nextStep || playback !== 'playing') return;
    const { index, delay } = nextStep, token = run;
    nextStep.due = performance.now() + delay;
    timeout = setTimeout(() => {
      nextStep = undefined;
      void sequence(index, token);
    }, delay);
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
        bindAttribute(node, 'aria-label', () => stepTitle(i) + ', ' + stamp(step.second));
        bindAttribute(node, 'title', () => stepTitle(i));
        const preview = () => {
          stopSequence(i === steps.length - 1);
          if (active !== i) void display(i);
        };
        node.onpointerenter = e => { if (e.pointerType !== 'touch' && playback !== 'playing') preview(); };
        node.onpointermove = e => {
          if (e.pointerType !== 'touch' && playback === 'playing' && (e.movementX || e.movementY)) preview();
        };
        node.onfocus = preview;
        node.onclick = () => {
          stopSequence(i === steps.length - 1);
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
      const clueIndex = 'camera' in step ? i : priorCamera[i];
      const mapIndex = 'map' in step ? i : priorMap[i];
      const guessIndex = 'point' in step ? i : priorGuess[i];
      actionBoard = 'camera' in step ? 'clue' : 'guess';
      selectBoard();
      const activeStage = actionBoard === 'clue' ? stage : mapStage;
      activeStage.append(badge);
      const work: Promise<unknown>[] = [];
      if (clueIndex !== shownClue || 'camera' in step) {
        shownClue = -2;
        const cameraStep = steps[clueIndex], previous = steps[priorCamera[i]];
        const camera = cameraStep && 'camera' in cameraStep ? cameraStep.camera : { dx:0, dy:0, level:0 };
        const transition = 'camera' in step && previous && 'camera' in previous ? { replayFrom: previous.camera, motion: movement } : false;
        work.push(viewport.show(camera, 'camera' in step ? announce : undefined, transition).then(drawn => {
          if (drawn && serial === paint && !dead) shownClue = clueIndex;
        }));
      }
      const mapStep = steps[mapIndex], pose = mapStep && 'map' in mapStep ? mapStep.map : initialMap;
      const guessStep = steps[guessIndex];
      if (pose || (guessStep && 'point' in guessStep)) {
        if (!mapSurface) {
          mapSurface = document.createElement('div'); mapSurface.className = 'map-board replay-guess-map';
          mapStage.prepend(mapSurface);
          if (context.config) {
            board = new MapBoard(mapSurface, context.config.bounds, context.config.overview, () => {}, context.config.map);
            board.setLocked(true); mapSurface.tabIndex = -1;
            bindAttribute(mapSurface, 'aria-label', 'Guess map');
          }
          mapSurface.inert = true;
        }
        mapNote.hidden = !!board || !!guessStep;
        mapSurface.hidden = false;
        if (pose && board && (shownMap !== mapIndex || 'map' in step)) {
          const previous = steps[priorMap[i]];
          const from = previous && 'map' in previous ? previous.map : initialMap;
          if ('map' in step && from && shownMap !== priorMap[i]) {
            await board.setReplayPose(from);
          }
          if (dead || serial !== paint) return false;
          work.push(board.setReplayPose(pose, 'map' in step ? movement : undefined));
          shownMap = mapIndex;
        } else if (!pose && cached?.mapSteps?.length) { board?.clearReplayPose(); shownMap = -2; }
        if (shownGuess !== guessIndex || 'point' in step) {
          shownGuess = guessIndex;
          if (guessStep && 'point' in guessStep) {
            const previous = steps[priorGuess[guessIndex]];
            const prior = previous && 'point' in previous ? previous.point : undefined;
            const pins = [{ id:'current', name, guess:guessStep.point, color:'#56b9ff' }];
            if (prior) pins.push({ id:'previous', name:tr('Previous guess'), guess:prior, color:'#a2aab9' });
            if (board) {
              board.setPlayers(pins, round.answer, () => {});
              const pin = board.highlightPlayer('current');
              if (pin && 'point' in step && !movement.reduced) {
                const carrier = document.createElementNS('http://www.w3.org/2000/svg','g');
                pin.before(carrier); carrier.append(pin);
                const dx = prior ? prior.x - step.point.x : 0;
                const dy = prior ? prior.y - step.point.y : -HIGHLIGHT_PIN_HEIGHT / (2 * (board.svg.getScreenCTM()?.a || 1));
                work.push(movement.animate(carrier, [{ transform:`translate(${dx}px, ${dy}px)`, opacity:prior ? 1 : .4 },
                  { transform:'translate(0px, 0px)', opacity:1 }]));
              }
            } else mapSurface.textContent = formatGuessrNumber(guessStep.point.x) + ', ' + formatGuessrNumber(guessStep.point.y);
          } else board?.setMarkers(null);
        }
      } else {
        if (mapSurface) mapSurface.hidden = true;
        mapNote.hidden = false;
        shownGuess = shownMap = -2;
      }
      if (!('camera' in step)) announce();
      await Promise.all(work);
      return serial === paint && !dead;
    } catch {
      if (serial === paint && !dead) {
        stopSequence();
        bindText(status, 'Preview unavailable');
        status.hidden = false;
        retry.hidden = false;
      }
      return false;
    } finally {
      if (serial === paint) rendering = false;
    }
  }
  async function sequence(index: number, token: number) {
    moveIntoView(index);
    let presentedAt = performance.now();
    if (!(await display(index, () => { presentedAt = performance.now(); })) || dead || token !== run) return;
    if (index + 1 === steps.length) {
      stopSequence(true);
      return;
    }
    const initialView = index === 0 && steps[index].action === 'view';
    const remaining = initialView ? 0 : Math.max(0, REPLAY_MOVE_MS - (performance.now() - presentedAt));
    nextStep = { index: index + 1, delay: remaining + STEP_HOLD_MS, due: 0 };
    scheduleNext();
  }
  function startSequence(index: number) {
    sequencing = true;
    setPlayback('playing');
    void sequence(index, ++run);
  }
  async function selectRound() {
    request?.abort();
    paint++;
    stopSequence();
    clearTimeout(fade);
    interrupt();
    viewport?.destroy();
    viewport = undefined;
    removeMap();
    clue.inert = false;
    steps = [];
    active = -1;
    nodes.clear();
    strip.replaceChildren();
    timeline.scrollTop = 0;
    boards.hidden = switches.hidden = true;
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
      if (!data || (!data.steps.length && !data.mapSteps?.length)) {
        boards.hidden = true;
        bindText(status, 'No replay was recorded for this round.');
        return;
      }
      steps = playbackSteps(data);
      const firstMap = data.mapSteps?.[0];
      initialMap = firstMap?.action === 'map-view' && firstMap.before <= 1 && firstMap.second <= 1 ? firstMap.map : undefined;
      if (initialMap && steps.length > 1) steps = steps.filter(s => s !== firstMap);
      const hasGuessMap = !!data.mapSteps?.length || steps.some(s => 'point' in s);
      guessPane.hidden = !hasGuessMap;
      boards.classList.toggle('single-board', !hasGuessMap);
      switches.hidden = !hasGuessMap;
      bindText(mapNote, data.mapSteps?.length ? 'Guess map' : 'No guess-map movement was recorded.');
      const lastSecond = steps.reduce((end, step) => Math.max(end, step.second), 0);
      bindText(timeMeasure, () => stamp(lastSecond));
      priorCamera = [];
      priorGuess = []; priorMap = [];
      let cam = -1, guess = -1, map = -1;
      steps.forEach((step, i) => {
        priorCamera.push(cam);
        priorGuess.push(guess); priorMap.push(map);
        if ('camera' in step) cam = i;
        else if ('map' in step) map = i;
        else guess = i;
      });
      viewport = new ClueViewport(clue, data.clue);
      boards.hidden = timeline.hidden = false;
      layoutSteps();
      toolbar.hidden = play.hidden = false;
      status.hidden = !data.partial;
      if (data.partial) bindText(status, 'Recording limit reached');
      startSequence(0);
    } catch {
      if (!controller.signal.aborted) {
        boards.hidden = !viewport;
        status.hidden = false;
        bindText(status, 'Preview unavailable');
        retry.hidden = false;
      }
    }
  }
  play.onclick = () => {
    if (playback === 'playing') {
      clearTimeout(timeout);
      if (nextStep) nextStep.delay = Math.max(0, nextStep.due - performance.now());
      setPlayback('paused');
      motion?.pause();
    } else if (sequencing) {
      setPlayback('playing');
      motion?.resume();
      scheduleNext();
    } else startSequence(playback === 'finished' ? 0 : Math.min(active + 1, steps.length - 1));
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
      stopSequence();
      paint++;
      request?.abort();
      clearTimeout(fade);
      interrupt();
      viewport?.destroy();
      viewport = undefined;
      removeMap();
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
    removeMap();
    item.remove();
  };
}
