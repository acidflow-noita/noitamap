import i18next from '../i18n';
import { getPOISpawnDetails } from '../telescope/poi-spawn-details';
import { getPOIDisplayName } from '../telescope/poi-display-name';

/** Called only by the authenticated extended-card renderer. */
export function renderExtendedSpawns(poi: { type: string; item?: string; entity?: string }): HTMLElement | null {
  const details = getPOISpawnDetails(poi, true);
  if (!details) return null;
  const root = document.createElement('div');
  root.className = 'extended-info-spawner';
  const percent = new Intl.NumberFormat(i18next.resolvedLanguage || i18next.language, {
    style: 'percent', maximumFractionDigits: 7,
  });
  for (const [entity, count, numerator, denominator] of details.outcomes) {
    if (numerator == null || denominator == null) continue;
    const row = document.createElement('div');
    row.className = 'extended-info-row';
    const label = document.createElement('span');
    label.className = 'extended-info-label';
    label.textContent = `${count}× ${getPOIDisplayName({ type: 'entity', entity })}`;
    const value = document.createElement('span');
    value.className = 'extended-info-value';
    value.textContent = `${numerator}/${denominator} (${percent.format(numerator / denominator)})`;
    row.append(label, value);
    root.appendChild(row);
  }
  for (const note of details.notes) {
    const text = document.createElement('div');
    text.className = 'extended-info-desc';
    text.textContent = note;
    root.appendChild(text);
  }
  return root.childElementCount ? root : null;
}
