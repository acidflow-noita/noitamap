import Popover from 'bootstrap/js/dist/popover.js';
import { onGuessrLanguageChanged } from './i18n';

/** Map-style hover/focus help, with live translated content and explicit cleanup. */
export function hoverHelp(anchor: HTMLElement, content: () => string, described = anchor) {
  let render = content;
  const popup = new Popover(anchor, {
    trigger: 'hover focus', placement: 'top', container: 'body',
    content: () => render(), html: false, animation: false,
    delay: { show: 80, hide: 120 },
  });
  const update = (next = render) => {
    render = next;
    const text = render();
    described.setAttribute('aria-description', text);
    if (described !== anchor) anchor.setAttribute('aria-description', text);
    popup.setContent({ '.popover-body': text });
  };
  const unsubscribe = onGuessrLanguageChanged(() => update());
  update();
  return { update, dispose() { unsubscribe(); popup.dispose(); } };
}
