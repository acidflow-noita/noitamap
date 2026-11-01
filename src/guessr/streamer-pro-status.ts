import type { LiveRoomView } from './live-room-types';
import Popover from 'bootstrap/js/dist/popover.js';
import { onGuessrLanguageChanged, tr } from './i18n';

type ProProof = Pick<LiveRoomView, 'hostPro' | 'hostProVerifiedUntil'> & { gameId?: string | null };

/** Uses the existing room proof. Expiry never triggers a subscription request. */
export function streamerProStatus(options: { local?: boolean } = {}) {
  const badge = document.createElement('button');
  badge.type = 'button';
  let proof: ProProof = {}, expiry: ReturnType<typeof setTimeout> | undefined, explanation = '';
  const popup = new Popover(badge, { trigger: 'hover focus', placement: 'bottom', container: 'body',
    content: () => explanation, html: false, animation: false });
  const paint = () => {
    clearTimeout(expiry);
    const remaining = (proof.hostProVerifiedUntil ?? 0) - Date.now();
    const active = !options.local && proof.hostPro === 'active' && Number.isFinite(remaining) && remaining > 0;
    badge.hidden = !proof.gameId;
    badge.className = 'badge stream-pro-status' + (active ? ' pro animation-pop' : '');
    badge.dataset.proStatus = options.local ? 'local' : active ? 'active' : 'unknown';
    badge.textContent = options.local ? tr('Local test') : active ? tr('Streamer has Pro') : tr('Pro status unavailable');
    badge.setAttribute('aria-label', options.local ? tr('Local test') : active ? tr('Streamer has Pro') : tr('Streamer Pro status unavailable'));
    explanation = options.local ? tr('This is a local test game. Streamer Pro access is not checked here.')
      : active ? tr('The streamer’s Pro access was confirmed for this game.')
      : tr('The game’s last Pro confirmation has expired or is unavailable. The streamer may still have Pro.');
    badge.setAttribute('aria-description', explanation);
    popup.setContent({ '.popover-body': explanation });
    if (active) expiry = setTimeout(paint, Math.min(remaining, 2_147_483_647));
  };
  paint();
  const unsubscribe = onGuessrLanguageChanged(paint);
  return { badge, update(value: ProProof) { proof = value; paint(); },
    dispose() { clearTimeout(expiry); unsubscribe(); popup.dispose(); } };
}
