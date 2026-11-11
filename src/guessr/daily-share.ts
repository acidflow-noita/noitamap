import Dialog from 'bootstrap/js/dist/dialog.js';
import { downloadBlob } from '../image-export';
import { dailyShareData, dailyShareFilename, type DailyShareData, type DailyShareSource } from './daily-share-data';
import { bindAttribute, bindText, guessrLocale, onGuessrLanguageChanged, tr } from './i18n';
import { buttonNotice } from './button-notice';

function action(label: string, icon: string): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'btn btn-outline theme-secondary with-icon';
  const glyph = document.createElement('i');
  glyph.className = `bi bi-${icon}`;
  glyph.setAttribute('aria-hidden', 'true');
  button.append(glyph, bindText(document.createElement('span'), label));
  return button;
}

function canCopyImage(): boolean {
  return !!navigator.clipboard?.write && typeof ClipboardItem !== 'undefined'
    && (typeof ClipboardItem.supports !== 'function' || ClipboardItem.supports('image/png'));
}
function canShareFile(file: File): boolean {
  try { return !!navigator.share && !!navigator.canShare?.({ files: [file] }); }
  catch { return false; }
}

function showShareDialog(data: DailyShareData, trigger: HTMLElement): () => void {
  const dialog = document.createElement('dialog');
  dialog.className = 'dialog daily-share-dialog';
  dialog.setAttribute('aria-labelledby', 'daily-share-title');
  const header = document.createElement('div'); header.className = 'dialog-header';
  const title = bindText(document.createElement('h1'), 'Share result');
  title.className = 'dialog-title fs-lg'; title.id = 'daily-share-title';
  const close = document.createElement('button'); close.type = 'button'; close.className = 'btn-close';
  close.setAttribute('data-bs-dismiss', 'dialog'); bindAttribute(close, 'aria-label', 'Close');
  header.append(title, close);

  const body = document.createElement('div'); body.className = 'dialog-body';
  const frame = document.createElement('div'); frame.className = 'daily-share-preview';
  const placeholder = document.createElement('span'); placeholder.className = 'placeholder placeholder-wave';
  placeholder.setAttribute('aria-hidden', 'true');
  const preview = document.createElement('img'); preview.width = 1200; preview.height = 720; preview.hidden = true;
  frame.append(placeholder, preview);
  const feedback = document.createElement('p'); feedback.className = 'daily-share-feedback'; feedback.setAttribute('role', 'status');
  const retry = action('Retry', 'arrow-clockwise'); retry.hidden = true;
  body.append(frame, feedback, retry);

  const footer = document.createElement('div'); footer.className = 'dialog-footer';
  const copy = action('Copy image', 'clipboard');
  const download = action('Download PNG', 'download');
  const share = action('Share image', 'share');
  copy.hidden = !canCopyImage();
  share.hidden = true;
  footer.append(copy, download, share);
  dialog.append(header, body, footer); document.body.append(dialog);
  const instance = new Dialog(dialog);
  // Popovers must live in the dialog's top layer to remain visible.
  const notice = buttonNotice(copy, dialog);
  let closed = false, revision = 0, objectUrl: string | undefined, file: File | undefined;
  let busy = false;
  const buttons = () => { copy.disabled = download.disabled = share.disabled = !file || busy; };
  const clearImage = () => {
    file = undefined;
    preview.hidden = true;
    preview.removeAttribute('src');
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    objectUrl = undefined;
  };
  const render = async () => {
    const current = ++revision;
    clearImage(); notice.dispose(); buttons();
    retry.hidden = true; placeholder.hidden = false; frame.setAttribute('aria-busy', 'true');
    bindText(feedback, 'Preparing image…');
    try {
      const { dailyShareLabels, renderDailyShareImage } = await import('./daily-share-image');
      if (closed || current !== revision) return;
      const labels = dailyShareLabels(data, guessrLocale(), tr);
      const blob = await renderDailyShareImage(labels);
      if (closed || current !== revision) return;
      file = new File([blob], dailyShareFilename(data), { type: 'image/png' });
      objectUrl = URL.createObjectURL(blob);
      preview.src = objectUrl;
      preview.alt = `${labels.title}, ${labels.date}, ${labels.total} ${labels.maximum}`;
      preview.hidden = false; placeholder.hidden = true;
      share.hidden = !canShareFile(file);
      bindText(feedback, () => '');
    } catch {
      if (closed || current !== revision) return;
      placeholder.hidden = true; retry.hidden = false;
      bindText(feedback, 'Could not create the image. Try again.');
    } finally {
      if (!closed && current === revision) { frame.setAttribute('aria-busy', 'false'); buttons(); }
    }
  };
  copy.addEventListener('click', async () => {
    if (!file || busy) return;
    const current = revision;
    busy = true; buttons(); notice.dispose(); bindText(feedback, () => '');
    try {
      // The ready PNG is written in the click handler, retaining user activation.
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': file })]);
      if (!closed && revision === current) notice.show(tr('Copied'));
    } catch {
      if (!closed && revision === current) bindText(feedback, 'Could not copy the image. Download the PNG instead.');
    } finally { busy = false; if (!closed) buttons(); }
  });
  download.addEventListener('click', () => {
    if (file && !busy) downloadBlob(file, file.name);
  });
  share.addEventListener('click', async () => {
    if (!file || busy) return;
    const current = revision;
    busy = true; buttons(); bindText(feedback, () => '');
    try {
      // No attempt URL, credentials or page query string enters the share sheet.
      await navigator.share({ files: [file], title: `NoitaGuessr, ${data.day}` });
    } catch (error) {
      if (!closed && revision === current && (error as { name?: string })?.name !== 'AbortError')
        bindText(feedback, 'Could not share the image. Download the PNG instead.');
    } finally { busy = false; if (!closed) buttons(); }
  });
  retry.addEventListener('click', () => { void render(); });
  const unsubscribe = onGuessrLanguageChanged(() => { void render(); });
  const destroy = () => {
    if (closed) return;
    closed = true; ++revision;
    unsubscribe(); notice.dispose(); clearImage(); instance.dispose(); dialog.remove();
    if (trigger.isConnected) trigger.focus({ preventScroll: true });
  };
  dialog.addEventListener('hidden.bs.dialog', destroy, { once: true });
  buttons();
  void instance.show(trigger);
  void render();
  return destroy;
}

/** Reopening a saved completed Daily uses exactly the same loaded result. */
export function dailyResultShare(state: DailyShareSource): { element: HTMLButtonElement; destroy: () => void } | null {
  const data = dailyShareData(state);
  if (!data) return null;
  const element = action('Share result', 'share');
  element.classList.add('daily-share-open');
  let close: (() => void) | undefined;
  element.addEventListener('click', () => { close?.(); close = showShareDialog(data, element); });
  return { element, destroy: () => { close?.(); } };
}
