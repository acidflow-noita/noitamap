import { gameFetch } from './quota-state';
import { gameAuth } from './api';
import { gameApiOrigin } from './api-origin';
import { bindText, guessrLocale, onGuessrLanguageChanged } from './i18n';
import type { StreamResult } from './stream-types';
import { featureLabel } from './release-features';

export function reviewDisclosure(read: (signal: AbortSignal) => Promise<string[]>) {
  const element = document.createElement('section');
  element.className = 'host-review-notice';
  const title = document.createElement('strong');
  title.append(featureLabel('hostReview', 'Host review suggested'));
  const warning = bindText(
    document.createElement('p'),
    'Keep the reasoning off stream. It contains private moderation details.'
  );
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'btn btn-sm btn-outline theme-warning';
  const body = document.createElement('div');
  body.setAttribute('role', 'status');
  let request: AbortController | undefined;
  function hide() {
    request?.abort();
    request = undefined;
    body.replaceChildren();
    button.setAttribute('aria-expanded', 'false');
    bindText(button, 'Reveal reasoning');
  }
  button.onclick = async () => {
    if (request) {
      hide();
      return;
    }
    const controller = (request = new AbortController());
    button.setAttribute('aria-expanded', 'true');
    bindText(button, 'Hide reasoning');
    body.replaceChildren(bindText(document.createElement('span'), 'Loading…'));
    try {
      const reasons = await read(controller.signal);
      if (controller.signal.aborted) return;
      body.replaceChildren(...reasons.map(text => Object.assign(document.createElement('p'), { textContent: text })));
    } catch {
      if (!controller.signal.aborted) {
        hide();
        body.replaceChildren(bindText(document.createElement('span'), 'Could not load the private review.'));
      }
    }
  };
  hide();
  element.append(title, warning, button, body);
  return { element, hide };
}

/** Only final results mount this control. The Worker also verifies the signed host identity on every read. */
export function privateResultReview(result: StreamResult) {
  const origin = gameApiOrigin();
  if (!result.reviewSuggested || !origin) return;
  const ui = reviewDisclosure(async signal => {
    const auth = await gameAuth();
    const sessionToken = auth.getToken();
    if (!sessionToken) throw Error('Sign in required');
    const issued = await fetch(auth.getWorkerUrl() + '/auth/result-ticket', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + sessionToken },
      cache: 'no-store',
      signal,
    });
    if (!issued.ok) throw Error('Review unavailable');
    const { token } = await issued.json();
    const response = await gameFetch(origin + '/api/streams/results/' + result.id + '/review', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Accept-Language': guessrLocale() },
      cache: 'no-store',
      signal,
    });
    if (!response.ok) throw Error('Review unavailable');
    return (await response.json()).reasons;
  });
  ui.element.hidden = true;
  const language = onGuessrLanguageChanged(ui.hide);
  let closed = false,
    unsubscribe: (() => void) | undefined;
  void gameAuth()
    .then(auth => {
      if (closed) return;
      const refresh = () => {
        const state = auth.getState();
        const isHost =
          state.authenticated &&
          state.linkedAccounts?.some(a => a.provider === 'twitch' && a.userId === result.host.id);
        ui.element.hidden = !isHost;
        if (!isHost) ui.hide();
      };
      refresh();
      unsubscribe = auth.subscribe(refresh);
    })
    .catch(() => {});
  return {
    element: ui.element,
    destroy() {
      closed = true;
      unsubscribe?.();
      language();
      ui.hide();
    },
  };
}
