/**
 * Pre-pro-bundle skeleton shells for the drawing sidebar and toolbar.
 *
 * Inserted the moment the user clicks "Drawing Tools" / "Get Pro" so the
 * UI slides in instantly with Bootstrap placeholders, instead of freezing
 * while the 2+ MB pro bundle downloads and evaluates.
 *
 * Bootstrap supplies the placeholder sizes, colors and reduced-motion behavior.
 * The sidebar and toolbar keep their normal outer layout during the hand-off.
 *
 * Removed by `hideDrawingSkeleton` once the real UI mounts or pro-load fails.
 */
import i18next from "../i18n";

const SIDEBAR_ID = "drawing-sidebar-skel";
const TOOLBAR_ID = "drawing-toolbar-skel";
let hideTimer: ReturnType<typeof setTimeout> | undefined;

export function showDrawingSkeleton(): void {
  clearTimeout(hideTimer);
  hideTimer = undefined;
  const existing = document.getElementById(SIDEBAR_ID);
  if (existing) {
    existing.classList.add("open");
    document.getElementById(TOOLBAR_ID)?.classList.add("open");
    return;
  }

  const sidebar = document.createElement("div");
  sidebar.id = SIDEBAR_ID;
  sidebar.className = "drawing-sidebar";
  sidebar.setAttribute("aria-busy", "true");
  sidebar.innerHTML = `
    <div class="sidebar-header p-2 border-bottom" aria-hidden="true">
      <h2 class="h5 mb-0 placeholder-wave"><span class="placeholder col-6"></span></h2>
    </div>
    <div id="drawing-sidebar-skel-content" class="overflow-auto" aria-hidden="true">
      <div class="sidebar-section placeholder-wave">
        <p><span class="placeholder placeholder-sm col-4"></span></p>
        <div class="d-flex flex-wrap gap-1">${Array.from({ length: 6 }, () => '<span class="btn btn-sm disabled placeholder col-2"></span>').join('')}</div>
      </div>
      ${[8, 10, 7].map(width => `
        <div class="sidebar-section placeholder-wave">
          <p><span class="placeholder placeholder-sm col-4"></span></p>
          <p class="mb-0">
            <span class="placeholder col-${width}"></span>
            <span class="placeholder col-6"></span>
          </p>
        </div>
      `).join('')}
    </div>
  `;
  const status = document.createElement("span");
  status.className = "visually-hidden";
  status.setAttribute("role", "status");
  status.textContent = i18next.t("search.indexing", "Loading data...");
  sidebar.append(status);
  document.body.appendChild(sidebar);

  const toolbar = document.createElement("div");
  toolbar.id = TOOLBAR_ID;
  toolbar.className = "drawing-toolbar";
  toolbar.setAttribute("aria-hidden", "true");
  toolbar.innerHTML = `<div class="d-flex flex-wrap gap-1 placeholder-wave">${Array.from({ length: 10 }, () => '<span class="btn btn-sm disabled placeholder"></span>').join('')}</div>`;
  document.body.appendChild(toolbar);

  // Force reflow, then add .open so the CSS transition runs (instant slide-in).
  void sidebar.offsetWidth;
  void toolbar.offsetWidth;
  sidebar.classList.add("open");
  toolbar.classList.add("open");
}

/** Swap loading shells for the mounted UI in one frame, not two slide animations. */
export function replaceDrawingSkeleton(show: () => void): void {
  if (!document.getElementById(SIDEBAR_ID)) { show(); return; }
  const elements = [
    document.getElementById("drawing-sidebar"),
    document.querySelector<HTMLElement>(`.drawing-toolbar:not(#${TOOLBAR_ID})`),
  ].filter((element): element is HTMLElement => !!element);
  const transitions = elements.map(element => element.style.transition);
  for (const element of elements) element.style.transition = "none";
  show();
  hideDrawingSkeleton(true);
  for (const element of elements) element.getBoundingClientRect();
  requestAnimationFrame(() => {
    elements.forEach((element, index) => {
      if (element.style.transition === "none") element.style.transition = transitions[index];
    });
  });
}

export function hideDrawingSkeleton(immediate = false): void {
  clearTimeout(hideTimer);
  hideTimer = undefined;
  const sidebar = document.getElementById(SIDEBAR_ID);
  const toolbar = document.getElementById(TOOLBAR_ID);
  if (immediate) { sidebar?.remove(); toolbar?.remove(); return; }
  sidebar?.classList.remove("open");
  toolbar?.classList.remove("open");
  hideTimer = setTimeout(() => { sidebar?.remove(); toolbar?.remove(); hideTimer = undefined; }, 300);
}
