/**
 * Pre-pro-bundle skeleton shells for the drawing sidebar and toolbar.
 *
 * Inserted the moment the user clicks "Drawing Tools" / "Get Pro" so the
 * UI slides in instantly with shimmering placeholders, instead of freezing
 * while the 2+ MB pro bundle downloads and evaluates.
 *
 * The layout deliberately mirrors the real subscriber drawing sidebar
 * (sidebar.ts -> renderSubscriberContent) and the real bottom toolbar so
 * the hand-off to the real UI is visually seamless.
 *
 * Removed by `hideDrawingSkeleton` once the real UI mounts or pro-load fails.
 */

const SIDEBAR_ID = "drawing-sidebar-skel";
const TOOLBAR_ID = "drawing-toolbar-skel";

export function showDrawingSkeleton(): void {
  if (document.getElementById(SIDEBAR_ID)) return;

  const sidebar = document.createElement("div");
  sidebar.id = SIDEBAR_ID;
  sidebar.className = "drawing-sidebar";
  sidebar.setAttribute("aria-busy", "true");
  sidebar.innerHTML = `
    <div class="sidebar-header d-flex justify-content-between align-items-center p-2 border-bottom border-secondary">
      <div class="skeleton-pulse" style="height:16px;width:120px;"></div>
      <div class="skeleton-pulse" style="width:24px;height:24px;border-radius:4px;"></div>
    </div>
    <div id="drawing-sidebar-skel-content">
      ${sectionLabel("Tools")}
      ${sectionIconGrid(9)}
      ${sectionLabel("Colors")}
      ${sectionColorRow(8)}
      ${sectionLabel("Canvas")}
      ${sectionThreeRects()}
      ${sectionLabel("Brush")}
      ${sectionSlider()}
      ${sectionLabel("Layer ordering")}
      ${sectionIconGrid(4, true)}
      ${sectionLabel("Actions")}
      ${sectionWideButtons(3)}
      ${sectionLabel("Saved drawings")}
      ${sectionDrawingRows(3)}
    </div>
  `;
  document.body.appendChild(sidebar);

  const toolbar = document.createElement("div");
  toolbar.id = TOOLBAR_ID;
  toolbar.className = "drawing-toolbar";
  toolbar.setAttribute("aria-busy", "true");
  // The real toolbar has 10 icon buttons, each 2rem square, margin 0.15rem.
  const TOOL_COUNT = 10;
  let toolbarInner = "";
  for (let i = 0; i < TOOL_COUNT; i++) {
    toolbarInner += `<div class="skeleton-pulse" style="width:2rem;height:2rem;border-radius:0.25rem;margin:0.15rem;"></div>`;
  }
  toolbar.innerHTML = toolbarInner;
  document.body.appendChild(toolbar);

  // Force reflow, then add .open so the CSS transition runs (instant slide-in).
  void sidebar.offsetWidth;
  void toolbar.offsetWidth;
  sidebar.classList.add("open");
  toolbar.classList.add("open");
}

export function hideDrawingSkeleton(): void {
  const sidebar = document.getElementById(SIDEBAR_ID);
  const toolbar = document.getElementById(TOOLBAR_ID);
  if (sidebar) {
    sidebar.classList.remove("open");
    setTimeout(() => sidebar.remove(), 300);
  }
  if (toolbar) {
    toolbar.classList.remove("open");
    setTimeout(() => toolbar.remove(), 300);
  }
}

/** A small "form-label" style row above each section. */
function sectionLabel(_text: string): string {
  // No text — the real UI uses i18n labels; the bar shape is enough.
  return `
    <div class="sidebar-section">
      <div class="skeleton-pulse" style="height:10px;width:70px;border-radius:2px;"></div>
    </div>
  `;
}

/**
 * Icon grid matching `.drawing-sidebar .btn-group.flex-wrap` — gap 0.1rem,
 * buttons 1.75rem square (sidebar `.btn.btn-sm` min-size).
 */
function sectionIconGrid(count: number, small: boolean = false): string {
  const size = small ? "1.6rem" : "1.75rem";
  let cells = "";
  for (let i = 0; i < count; i++) {
    cells += `<div class="skeleton-pulse" style="width:${size};height:${size};border-radius:0.25rem;"></div>`;
  }
  return `
    <div class="sidebar-section">
      <div class="d-flex flex-wrap" style="gap:0.1rem;">${cells}</div>
    </div>
  `;
}

/** Row of color swatches (circle) + color picker circle on the left. */
function sectionColorRow(count: number): string {
  let dots = "";
  for (let i = 0; i < count; i++) {
    dots += `<div class="skeleton-pulse" style="width:1.6rem;height:1.6rem;border-radius:50%;"></div>`;
  }
  return `
    <div class="sidebar-section">
      <div class="d-flex align-items-center" style="gap:0.2rem;">
        <div class="skeleton-pulse" style="width:30px;height:30px;border-radius:50%;margin-right:0.4rem;"></div>
        ${dots}
      </div>
    </div>
  `;
}

/** Three equally-sized rectangular buttons (canvas: map / black / white). */
function sectionThreeRects(): string {
  return `
    <div class="sidebar-section">
      <div class="d-flex" style="gap:0.2rem;">
        <div class="skeleton-pulse flex-fill" style="height:1.75rem;border-radius:0.25rem;"></div>
        <div class="skeleton-pulse flex-fill" style="height:1.75rem;border-radius:0.25rem;"></div>
        <div class="skeleton-pulse flex-fill" style="height:1.75rem;border-radius:0.25rem;"></div>
      </div>
    </div>
  `;
}

/** A horizontal slider placeholder. */
function sectionSlider(): string {
  return `
    <div class="sidebar-section">
      <div class="skeleton-pulse" style="height:6px;width:100%;border-radius:3px;"></div>
    </div>
  `;
}

/** Full-width action buttons (screenshot, save, export). */
function sectionWideButtons(count: number): string {
  let rows = "";
  for (let i = 0; i < count; i++) {
    rows += `<div class="skeleton-pulse" style="height:1.75rem;width:100%;border-radius:0.25rem;margin-bottom:0.2rem;"></div>`;
  }
  return `<div class="sidebar-section">${rows}</div>`;
}

/** Saved-drawing rows (thumbnail + two text lines). */
function sectionDrawingRows(count: number): string {
  let rows = "";
  for (let i = 0; i < count; i++) {
    rows += `
      <div class="d-flex align-items-center" style="gap:0.4rem;margin-bottom:0.2rem;">
        <div class="skeleton-pulse" style="width:2rem;height:2rem;border-radius:0.25rem;flex-shrink:0;"></div>
        <div class="flex-fill" style="min-width:0;">
          <div class="skeleton-pulse" style="height:10px;width:${[70, 55, 80][i % 3]}%;margin-bottom:4px;"></div>
          <div class="skeleton-pulse" style="height:8px;width:${[40, 30, 50][i % 3]}%;"></div>
        </div>
      </div>
    `;
  }
  return `<div class="sidebar-section" style="flex-grow:1;">${rows}</div>`;
}
