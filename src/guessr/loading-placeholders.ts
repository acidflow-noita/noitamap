/** Default Bootstrap placeholders; the caller supplies the accessible status. */
export function loadingPlaceholders(): HTMLDivElement {
  const skeleton = document.createElement('div');
  skeleton.className = 'placeholder-wave d-grid gap-2';
  skeleton.setAttribute('aria-hidden', 'true');
  for (const width of [8, 11, 6]) {
    const line = document.createElement('span');
    line.className = `placeholder col-${width}`;
    skeleton.append(line);
  }
  return skeleton;
}

export function clueLoadingPlaceholder(): HTMLDivElement {
  const frame = document.createElement('div');
  frame.className = 'clue-placeholder';
  frame.setAttribute('aria-hidden', 'true');
  const image = document.createElement('span'); image.className = 'placeholder placeholder-wave';
  frame.append(image);
  return frame;
}
