import { bindText } from './i18n';
import { quotaTiming } from './messages';
import { currentQuota, watchQuota } from './quota-state';

const messages = {
  worker: 'The game service has reached its daily limit.',
  starts: 'New games are paused to let active games finish.',
  checking: 'New games are paused while availability is checked.',
  ranked: 'Ranked play is paused. Practice is available.',
} as const;
export function createQuotaBanner(): HTMLElement {
  const bar = document.createElement('aside');
  bar.className = 'guessr-quota-bar';
  bar.setAttribute('role', 'status');
  const icon = document.createElement('i');
  icon.className = 'bi bi-exclamation-triangle';
  icon.setAttribute('aria-hidden', 'true');
  const text = document.createElement('span');
  const reason = document.createElement('span');
  const countdown = document.createElement('time');
  countdown.setAttribute('role', 'timer');
  countdown.setAttribute('aria-live', 'off');
  text.append(reason, ' ', countdown);
  bar.append(icon, text);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let scope: keyof typeof messages | undefined;
  const render = () => {
    clearTimeout(timer);
    const now = Date.now(),
      notice = currentQuota(now);
    bar.hidden = !notice;
    if (!notice) {
      scope = undefined;
      return;
    }
    if (scope !== notice.scope) bindText(reason, messages[notice.scope]);
    scope = notice.scope;
    countdown.dateTime = new Date(notice.resetAt).toISOString();
    bindText(countdown, () => quotaTiming(notice.resetAt, notice.scope === 'checking'));
    const remaining = notice.resetAt - now,
      tick = remaining <= 60000 ? 1000 : 60000;
    timer = setTimeout(render, ((remaining - 1) % tick) + 1);
  };
  watchQuota(render);
  render();
  return bar;
}
