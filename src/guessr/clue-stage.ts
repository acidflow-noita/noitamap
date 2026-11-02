/** Fit a fixed clue crop into the available height without stretching its pixels
 * or shifting the starting pin. Controls remain outside the fitted viewport. */
export function fitClueToPanel(clue: HTMLElement): void {
  const stage = document.createElement('div');
  stage.className = 'clue-stage';
  clue.replaceWith(stage);
  stage.append(clue);
}
