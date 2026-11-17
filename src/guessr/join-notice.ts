import Toast from 'bootstrap/js/dist/toast.js';
import { bindText } from './i18n';
import { iconLabel } from './control-icons';

/** One confirmation per player in this view, after the server admits them. */
export function gameJoinNotice() {
  const shown = new Set<string>();
  let element: HTMLElement | undefined, toast: Toast | undefined;
  const dispose = () => { toast?.dispose(); toast = undefined; element?.remove(); element = undefined; };
  return {
    show(playerId: string, channel: string) {
      if (shown.has(playerId)) return;
      shown.add(playerId); dispose();
      element = document.createElement('div');
      element.className = 'toast toast-instant guessr-join-toast';
      element.setAttribute('role', 'status'); element.setAttribute('aria-live', 'polite'); element.setAttribute('aria-atomic', 'true');
      const body = document.createElement('div'); body.className = 'toast-body';
      body.append(iconLabel('check-lg', ''));
      bindText(body.querySelector('span')!, 'Successfully joined {{channel}}’s game', { channel });
      element.append(body); document.body.append(element);
      element.addEventListener('hidden.bs.toast', dispose, { once: true });
      toast = new Toast(element, { autohide: true, delay: 4000 });
      void toast.show();
    },
    dispose,
  };
}
