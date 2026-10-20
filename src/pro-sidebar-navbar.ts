import { Drawer } from './bootstrap';
import { onProSidebarIntent } from './pro-sidebar-intent';

/** Pro panels live outside the navbar's native modal dialog. Close that
 * dialog when a panel is requested so it cannot leave the panel inert. */
export function installProNavbarDismissal(): () => void {
  let pending: HTMLDialogElement | undefined;
  const hide = () => { if (pending) void Drawer.getOrCreateInstance(pending).hide(); };
  const clear = () => {
    pending?.removeEventListener('shown.bs.drawer', hide);
    pending?.removeEventListener('hidden.bs.drawer', clear);
    pending = undefined;
  };
  const unsubscribe = onProSidebarIntent(sidebar => {
    if (!sidebar) return;
    const drawer = document.getElementById('collapsibleMapMenu');
    if (!(drawer instanceof HTMLDialogElement) || !drawer.open || pending === drawer) return;
    clear();
    pending = drawer;
    // hide() is ignored during the opening transition; try again once shown.
    drawer.addEventListener('shown.bs.drawer', hide, { once: true });
    drawer.addEventListener('hidden.bs.drawer', clear, { once: true });
    hide();
  });
  return () => { unsubscribe(); clear(); };
}
