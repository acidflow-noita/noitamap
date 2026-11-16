import { bindText, tr } from './i18n';

const notices = new WeakMap<HTMLElement, { shownAt: number; timer?: ReturnType<typeof setTimeout>; player: string; color: string }>();
/** Coalesce bursts from the existing host feed without introducing broadcasts. */
export function showActivity(node: HTMLElement, player: string, color: string) {
  let state = notices.get(node);
  if (!state) { state = { shownAt: 0, player, color }; notices.set(node, state); }
  state.player = player; state.color = color;
  const paint = () => {
    state!.timer = undefined;
    if (!node.isConnected) return;
    const marker = '\uFFF0', copy = () => tr('{{player}} submitted a guess', { player: marker }).split(marker);
    const before = document.createTextNode(''), after = document.createTextNode(''), name = document.createElement('strong');
    bindText(before, () => copy()[0]); bindText(after, () => copy()[1] || ''); name.textContent = state!.player; name.dir = 'auto'; name.style.color = state!.color;
    node.replaceChildren(before, name, after); node.style.visibility = 'visible';
    if (state!.shownAt && typeof node.animate === 'function') {
      for (const animation of node.getAnimations()) animation.cancel();
      const reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
      node.animate(reduced ? [{ opacity: .5 }, { opacity: 1 }] : [{ opacity: 0, transform: 'translateY(35%)' }, { opacity: 1, transform: 'translateY(0)' }],
        { duration: 160, easing: 'cubic-bezier(.23,1,.32,1)' });
    }
    state!.shownAt = Date.now();
  };
  const wait = 1800 - (Date.now() - state.shownAt);
  if (wait <= 0) { clearTimeout(state.timer); paint(); }
  else if (!state.timer) state.timer = setTimeout(paint, wait);
}
export function clearActivity(node: HTMLElement | null) { if (node) { clearTimeout(notices.get(node)?.timer); notices.delete(node); } }
