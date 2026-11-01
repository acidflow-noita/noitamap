/** Shared navigation row: return/exit on the left, title centered on the page. */
export function pageHeading(title: HTMLElement, back: HTMLButtonElement | HTMLAnchorElement): HTMLElement {
  const heading = document.createElement('header');
  heading.className = 'page-heading';
  title.classList.add('page-heading-title');
  back.classList.remove('small', 'secondary', 'primary');
  back.classList.add('btn', 'btn-sm', 'btn-outline', 'theme-secondary', 'page-back');
  heading.append(back, title);
  return heading;
}
