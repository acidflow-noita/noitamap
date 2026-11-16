import { bindAttribute, bindText, clearTextBinding, tr } from './i18n';
import { hoverHelp } from './hover-help';
import { iconLabel } from './control-icons';

const controls = new WeakMap<HTMLButtonElement, { label: HTMLElement; feedback: HTMLElement; state: string; source: string }>();

export function updateSubmit(button: HTMLButtonElement, label: string, state: 'ready' | 'waiting' | 'received' = 'ready') {
  let parts = controls.get(button);
  if (!parts) {
    clearTextBinding(button);
    button.classList.add('guess-submit'); button.setAttribute('aria-live', 'polite'); button.setAttribute('aria-atomic', 'true');
    const wrap = document.createElement('span'); wrap.className = 'submit-label';
    const text = document.createElement('span'); wrap.append(text);
    for (const key of ['Send guess', 'Update guess', 'Sending…', 'Waiting for confirmation', 'Guess received', 'Auto-submitted', 'Guess locked']) {
      const size = document.createElement('span'); size.className = 'label-sizer'; size.setAttribute('aria-hidden', 'true'); bindAttribute(size, 'data-label', key); wrap.append(size);
    }
    const feedback = document.createElement('span'); feedback.className = 'submit-feedback'; feedback.setAttribute('aria-hidden', 'true');
    button.replaceChildren(wrap, feedback); parts = { label: text, feedback, state: '', source: '' }; controls.set(button, parts);
  }
  if (parts.source !== label) { parts.source = label; bindText(parts.label, label); }
  button.dataset.state = state; button.setAttribute('aria-busy', String(state === 'waiting'));
  if (parts.state === state) return;
  parts.state = state;
  if (state === 'waiting') {
    const spinner = document.createElement('span'); spinner.className = 'spinner-border'; parts.feedback.replaceChildren(spinner);
  } else {
    const symbol = iconLabel(state === 'received' ? 'check-lg' : 'send', '');
    symbol.querySelector('span')?.remove();
    if (state === 'received') symbol.querySelector('svg')?.classList.add('animation-pop');
    parts.feedback.replaceChildren(symbol);
  }
}

/** Native disabled semantics, with hover/focus help on its wrapper. */
export function submitHelp(button: HTMLButtonElement, reason: () => string) {
  const wrapper = document.createElement('span'); wrapper.className = 'stream-send-control';
  button.replaceWith(wrapper); wrapper.append(button);
  const help = hoverHelp(wrapper, () => tr(reason()), button);
  const update = () => { wrapper.tabIndex = button.disabled ? 0 : -1; help.update(); };
  const observer = new MutationObserver(update); observer.observe(button, { attributes: true, attributeFilter: ['disabled', 'data-state'] }); update();
  return () => { observer.disconnect(); help.dispose(); };
}
