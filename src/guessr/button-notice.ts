import Popover from 'bootstrap/js/dist/popover.js';

/** Brief button feedback lives outside document flow and never moves panels. */
export function buttonNotice(button: HTMLElement) {
  let popup: Popover | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const dispose = () => { clearTimeout(timer); popup?.dispose(); popup = undefined; };
  return {
    show(message: string, theme: 'neutral' | 'success' | 'danger' = 'neutral') {
      dispose();
      const current = popup = new Popover(button, { trigger: 'manual', placement: 'top', container: 'body',
        content: message, html: false, animation: false,
        customClass: `guessr-button-notice${theme === 'neutral' ? '' : ` theme-${theme}`}` });
      void current.show().then(() => {
        if (popup === current) timer = setTimeout(dispose, 2400);
      }).catch(() => { if (popup === current) dispose(); });
    },
    dispose,
  };
}
