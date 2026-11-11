import Dialog from 'bootstrap/js/dist/dialog.js';
import i18next, { initializeTranslations, registerTranslationNamespace } from '../i18n';
import { bindAuthText } from './control-translations';
import english from './locales/en.json';

const catalogs = import.meta.glob<Record<string, string>>('./locales/*.json', { import: 'default' });
registerTranslationNamespace('authSecurity', english, language => catalogs[`./locales/${language}.json`]?.() ?? Promise.resolve(english));
export interface AccountLinkReview {
  current: { provider: 'twitch' | 'patreon'; userId: string; name: string }[];
  target: { provider: 'twitch' | 'patreon'; userId: string; name: string };
}
export async function confirmAccountLink(review: AccountLinkReview): Promise<boolean> {
  await initializeTranslations(); await i18next.loadNamespaces('authSecurity');
  return new Promise(resolve => {
    const dialog = document.createElement('dialog'); dialog.className = 'dialog';
    const header = document.createElement('div'); header.className = 'dialog-header';
    const title = document.createElement('h1'); title.className = 'dialog-title fs-lg'; title.id = 'confirm-link-title';
    const body = document.createElement('div'); body.className = 'dialog-body';
    const current = document.createElement('p'); bindAuthText(current, 'auth.signedInAs', 'Signed in as');
    const identities = document.createElement('ul');
    const identityText = (value: AccountLinkReview['target']) => `${value.provider === 'twitch' ? 'Twitch' : 'Patreon'}: ${value.name} (${value.userId})`;
    for (const identity of review.current) { const item = document.createElement('li'); item.textContent = identityText(identity); identities.append(item); }
    const targetLabel = document.createElement('p'), target = document.createElement('strong'); target.textContent = identityText(review.target);
    const footer = document.createElement('div'); footer.className = 'dialog-footer';
    const cancel = document.createElement('button'); cancel.type = 'button'; cancel.className = 'btn btn-outline theme-secondary';
    bindAuthText(cancel, 'gameContent.ui.menu_cancel', 'Cancel');
    const confirm = document.createElement('button'); confirm.type = 'button'; confirm.className = 'btn theme-primary';
    const translate = () => {
      title.textContent = String(i18next.t('Confirm account connection', { ns: 'authSecurity', defaultValue: 'Confirm account connection' }));
      targetLabel.textContent = String(i18next.t('Account to connect', { ns: 'authSecurity', defaultValue: 'Account to connect' }));
      confirm.textContent = String(i18next.t('Connect account', { ns: 'authSecurity', defaultValue: 'Connect account' }));
    };
    translate(); i18next.on('languageChanged', translate);
    header.append(title); body.append(current, identities, targetLabel, target); footer.append(cancel, confirm);
    dialog.append(header, body, footer); dialog.setAttribute('aria-labelledby', title.id); document.body.append(dialog);
    const instance = new Dialog(dialog);
    let accepted = false, ready = false, settled = false;
    const done = () => { if (settled) return; settled = true; i18next.off('languageChanged', translate); instance.dispose(); dialog.remove(); resolve(accepted); };
    cancel.onclick = () => { void instance.hide(); };
    confirm.onclick = event => { if (ready && event.detail < 2) { accepted = true; void instance.hide(); } };
    dialog.addEventListener('shown.bs.dialog', () => { ready = true; cancel.focus(); }, { once: true });
    dialog.addEventListener('hidden.bs.dialog', done, { once: true });
    void instance.show().catch(done);
  });
}
