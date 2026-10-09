export type SearchShortcut = { updateHint(label: string): void; dispose(): void };

const activeShortcuts = new WeakMap<Document, SearchShortcut>();

function isEditing(element: Element | null): boolean {
  if (!element) return false;
  if (element.closest('input, textarea, select, [role="textbox"], [role="combobox"]')) return true;
  const editor = element.closest('[contenteditable]');
  return !!editor && editor.getAttribute('contenteditable') !== 'false';
}

function isVisible(element: Element): boolean {
  const view = element.ownerDocument.defaultView!;
  for (let current: Element | null = element; current; current = current.parentElement) {
    if (current.hasAttribute('hidden') || current.hasAttribute('inert')) return false;
    const style = view.getComputedStyle(current);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
  }
  return true;
}

/** Cancel slash's browser action on keydown (including Firefox Quick Find),
 * before moving focus. Never take keys from editors, IME or a modal. */
export function installSearchShortcut(input: HTMLInputElement, label: string): SearchShortcut {
  const doc = input.ownerDocument;
  const view = doc.defaultView!;
  activeShortcuts.get(doc)?.dispose();

  const hint = doc.createElement('button');
  hint.className = 'search-shortcut-hint';
  hint.type = 'button';
  hint.tabIndex = -1;
  const keycap = doc.createElement('kbd');
  keycap.textContent = '/';
  keycap.setAttribute('aria-hidden', 'true');
  hint.appendChild(keycap);
  input.insertAdjacentElement('afterend', hint);
  input.setAttribute('aria-keyshortcuts', '/ Control+/ Meta+/');

  const blockedByModal = () => Array.from(doc.querySelectorAll(
    'dialog[open], [aria-modal="true"], .modal.show',
  )).some(isVisible);

  const canFocus = () => input.isConnected && !input.disabled && !input.readOnly
    && !input.closest('[inert], [hidden]') && !blockedByModal();

  const focus = () => {
    input.focus({ preventScroll: true });
    input.select();
  };

  function revealAndFocus(): void {
    const menu = input.closest<HTMLElement>('.navbar-collapse');
    if (menu && view.getComputedStyle(menu).display === 'none') {
      const Collapse = (view as any).bootstrap?.Collapse;
      if (Collapse) Collapse.getOrCreateInstance(menu, { toggle: false }).show();
    }
    focus();
  }

  // A held shortcut must not start typing slashes after focus moves. Consume
  // its keyup too: UnifiedSearch's keyup means "the user edited the query".
  let consumedSlash = false;
  let consumedCode = '';
  const consumedModifiers = new Set<string>();
  const clearHeldKey = () => { consumedSlash = false; consumedCode = ''; consumedModifiers.clear(); };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== '/' || event.altKey || event.getModifierState('AltGraph')
      || event.isComposing || event.keyCode === 229 || event.ctrlKey && event.metaKey
      || event.defaultPrevented || !event.cancelable) return;
    if (event.repeat) {
      if (consumedSlash) { event.preventDefault(); event.stopPropagation(); }
      return;
    }
    const path = event.composedPath();
    if (path.some(node => node instanceof Element && isEditing(node))
      || isEditing(doc.activeElement) || !canFocus()) return;
    const menu = input.closest<HTMLElement>('.navbar-collapse');
    const canReveal = menu && view.getComputedStyle(menu).display === 'none'
      && !!(view as any).bootstrap?.Collapse;
    if (!isVisible(input) && !canReveal) return;

    // Synchronous and non-passive: focusing first would not cancel Quick Find.
    event.preventDefault();
    event.stopPropagation();
    consumedSlash = true;
    consumedCode = event.code;
    if (event.ctrlKey) consumedModifiers.add('Control');
    if (event.metaKey) consumedModifiers.add('Meta');
    if (event.shiftKey) consumedModifiers.add('Shift');
    revealAndFocus();
  };
  const onKeyUp = (event: KeyboardEvent) => {
    if (consumedModifiers.delete(event.key)) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    // Shift may be released before the physical slash-producing key on a
    // non-US layout; code is used only to pair an already accepted shortcut.
    if (!consumedSlash || event.key !== '/' && (!consumedCode || event.code !== consumedCode)) return;
    consumedSlash = false;
    consumedCode = '';
    event.preventDefault();
    event.stopPropagation();
  };
  const onHintClick = () => { if (canFocus()) revealAndFocus(); };
  doc.addEventListener('keydown', onKeyDown, { capture: true, passive: false });
  doc.addEventListener('keyup', onKeyUp, true);
  view.addEventListener('blur', clearHeldKey);
  hint.addEventListener('click', onHintClick);

  const shortcut: SearchShortcut = {
    updateHint(text) {
      hint.title = text;
      hint.setAttribute('aria-label', text);
      input.setAttribute('aria-description', text);
    },
    dispose() {
      doc.removeEventListener('keydown', onKeyDown, true);
      doc.removeEventListener('keyup', onKeyUp, true);
      view.removeEventListener('blur', clearHeldKey);
      hint.remove();
      input.removeAttribute('aria-keyshortcuts');
      input.removeAttribute('aria-description');
      if (activeShortcuts.get(doc) === shortcut) activeShortcuts.delete(doc);
    },
  };
  shortcut.updateHint(label);
  activeShortcuts.set(doc, shortcut);
  return shortcut;
}
