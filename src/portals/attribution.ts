import i18next from '../i18n';
export { usesDustAnimation } from './card-data';

function poweredBy(): string {
  return i18next.t('attribution.poweredBy', { defaultValue: 'Powered by' });
}

export function createDustAttribution(): HTMLSpanElement {
  const credit = document.createElement('span');
  credit.className = 'dust-credit';
  const link = document.createElement('a');
  link.href = 'https://dust.runfast.stream';
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  const label = document.createElement('span');
  label.className = 'dust-credit-label';
  label.textContent = poweredBy();
  const logo = document.createElement('img');
  logo.src = '/assets/dust-logo.svg';
  logo.alt = 'Dust';
  logo.width = 63;
  logo.height = 25;
  link.append(logo);
  link.addEventListener('click', event => event.stopPropagation());
  credit.append(label, link);
  return credit;
}

// One listener for all cards, including static cards that stay open on a locale change.
i18next.on('languageChanged', () => {
  if (typeof document === 'undefined') return;
  for (const label of document.querySelectorAll('.dust-credit-label')) label.textContent = poweredBy();
});
