let cancelPulse = () => {};
let cancelPendingMenuCue = () => {};

/** Briefly identify the control that a spawn link just enabled, without moving
 * the layout or taking keyboard focus away from the map. */
function pulse(button: HTMLElement): void {
  cancelPulse();
  if (typeof button.animate !== 'function') return;
  const style = getComputedStyle(button);
  const accent = style.getPropertyValue('--accent-fg').trim() || style.color;
  const rest = {
    backgroundColor: style.backgroundColor,
    borderColor: style.borderColor,
    boxShadow: style.boxShadow,
  };
  const highlight = {
    backgroundColor: style.getPropertyValue('--accent-bg').trim() || style.backgroundColor,
    borderColor: accent,
    boxShadow: `inset 0 0 0 .125em ${accent}, 0 0 .5em ${accent}`,
  };
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const animation = button.animate(reduced ? [highlight, highlight] : [rest, { ...highlight, offset: .4 }, rest], {
    duration: reduced ? 1600 : 800,
    iterations: reduced ? 1 : 2,
    easing: 'ease-in-out',
  });
  // The sibling checkbox receives keyboard input; the label receives pointers.
  const interactionTarget = button.closest('#biome-boundaries-ui-wrapper') ?? button;
  const stop = () => {
    animation.cancel();
    animation.removeEventListener('finish', stop);
    interactionTarget.removeEventListener('pointerdown', stop);
    interactionTarget.removeEventListener('keydown', stop);
    cancelPulse = () => {};
  };
  cancelPulse = stop;
  animation.addEventListener('finish', stop, { once: true });
  interactionTarget.addEventListener('pointerdown', stop, { once: true });
  interactionTarget.addEventListener('keydown', stop, { once: true });
}

export function cueBiomeBoundariesButton(): void {
  cancelPendingMenuCue();
  const button = document.querySelector<HTMLElement>('label[for="biomeBoundariesToggler"]');
  if (!button) return;
  const menu = button.closest<HTMLElement>('.navbar-collapse');
  if (menu && (getComputedStyle(menu).display === 'none' || menu.classList.contains('collapsing'))) {
    // Mobile: identify the closed menu, then its actual control when opened.
    const menuButton = document.querySelector<HTMLElement>('.navbar-toggler[data-bs-target="#collapsibleMapMenu"]');
    if (menuButton) pulse(menuButton);
    const shown = (event: Event) => {
      if (event.target !== menu) return;
      cancelPendingMenuCue();
      const input = document.getElementById('biomeBoundariesToggler') as HTMLInputElement | null;
      if (input?.checked && !input.disabled
        && document.getElementById('osContainer')?.classList.contains('biome-spawn-focus')) pulse(button);
    };
    menu.addEventListener('shown.bs.collapse', shown);
    cancelPendingMenuCue = () => {
      menu.removeEventListener('shown.bs.collapse', shown);
      cancelPendingMenuCue = () => {};
    };
  } else {
    pulse(button);
  }
}
