/** Bootstrap's numbered, vertical instruction component. */
export function instructionSteps(...contents: HTMLElement[]): HTMLOListElement {
  const steps = document.createElement('ol');
  steps.className = 'stepper guessr-steps';
  for (const content of contents) {
    const item = document.createElement('li');
    item.className = 'stepper-item align-items-start';
    item.append(content); steps.append(item);
  }
  return steps;
}
