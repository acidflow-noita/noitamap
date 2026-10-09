import i18next from './i18n';

export type CreatureSpawnNoticeStatus = 'locked' | 'unavailable' | null;

/** Explain an inactive shared spawn selection without opening a modal. */
export function mountCreatureSpawnNotice(
  parent: HTMLElement,
  onUpgrade: () => void,
  onDismiss: () => void,
): { update(status: CreatureSpawnNoticeStatus): void; dispose(): void } {
  const notice = document.createElement('div');
  notice.id = 'creature-spawn-notice';
  notice.hidden = true;
  const message = document.createElement('span');
  message.className = 'creature-spawn-notice-message';
  message.setAttribute('role', 'status');
  const upgrade = document.createElement('button');
  upgrade.type = 'button';
  upgrade.className = 'btn btn-sm btn-outline-light';
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'btn btn-sm btn-outline-light creature-spawn-notice-close';
  const icon = document.createElement('i');
  icon.className = 'bi bi-x-lg';
  icon.setAttribute('aria-hidden', 'true');
  close.append(icon);
  notice.append(message, upgrade, close);
  parent.append(notice);

  let status: CreatureSpawnNoticeStatus = null;
  let disposed = false;
  const translate = () => {
    message.textContent = status === 'locked'
      ? i18next.t('extended.spawnBiomesPro', 'Spawn biome highlighting is a Pro feature.')
      : status === 'unavailable'
        ? i18next.t('extended.spawnBiomesUnavailable', 'Spawn biomes are unavailable for this creature on this map.')
        : '';
    upgrade.textContent = i18next.t('extended.cta', 'Unlock with Pro');
    const closeLabel = i18next.t('seedReport.close', 'Close');
    close.title = closeLabel;
    close.setAttribute('aria-label', closeLabel);
  };
  const update = (next: CreatureSpawnNoticeStatus) => {
    if (disposed) return;
    status = next;
    upgrade.hidden = status !== 'locked';
    notice.hidden = status === null;
    translate();
    if ((notice.hidden && notice.contains(document.activeElement)) ||
        (upgrade.hidden && document.activeElement === upgrade)) {
      (document.activeElement as HTMLElement).blur();
    }
  };
  const upgradeClick = () => { if (!disposed && status === 'locked') onUpgrade(); };
  const dismissClick = () => {
    if (disposed || status === null) return;
    update(null);
    onDismiss();
  };
  upgrade.addEventListener('click', upgradeClick);
  close.addEventListener('click', dismissClick);
  i18next.on('languageChanged', translate);
  update(null);

  return {
    update,
    dispose: () => {
      disposed = true;
      i18next.off('languageChanged', translate);
      upgrade.removeEventListener('click', upgradeClick);
      close.removeEventListener('click', dismissClick);
      notice.remove();
    },
  };
}
