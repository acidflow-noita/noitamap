import { bindText } from './i18n';
import { defaultStreaming, type MultiplayerMode } from './match-settings';

export function streamingSetting(mode: MultiplayerMode, changed: (value: boolean) => void) {
  const element = document.createElement('div'); element.className = 'stream-streaming-setting';
  const row = document.createElement('div'); row.className = 'd-flex align-items-center gap-2';
  const control = document.createElement('span'); control.className = 'switch theme-primary';
  const input = document.createElement('input'); input.type = 'checkbox'; input.setAttribute('role', 'switch');
  input.id = `${mode}-streaming`; input.checked = defaultStreaming(mode);
  const label = bindText(document.createElement('label'), 'I’m streaming'); label.htmlFor = input.id;
  const help = document.createElement('p'); help.className = 'form-text'; help.id = `${input.id}-help`;
  input.setAttribute('aria-describedby', help.id);
  const update = () => {
    bindText(help, input.checked ? 'Other players guess each location before it appears on your stream.'
      : 'Everyone plays the same location at the same time.');
    changed(input.checked);
  };
  input.addEventListener('change', update);
  control.append(input); row.append(control, label); element.append(row, help); update();
  return { element, input };
}
