/** Game shortcuts must never consume typing, browser shortcuts or modal input. */
export function gameShortcut(event: KeyboardEvent): boolean {
  if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey || event.isComposing
    || document.querySelector('dialog[open]')) return false;
  const target = event.target;
  return !(target instanceof Element && target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="combobox"], [role="menu"], .guessr-language-picker'));
}
