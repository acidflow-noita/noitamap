import i18next from "./i18n";

const ID = "seed-report-loading";
const STYLE_ID = "seed-report-loading-style";

/** Ships with the public app, so feedback never waits for a Pro download. */
export function createSeedReportLoading(
  onClose: () => void,
  onRetry: () => void,
) {
  if (!document.getElementById(STYLE_ID)) {
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      #${ID}{position:fixed;top:4.5rem;right:1.25rem;width:48vw;max-width:calc(100vw - 2rem);max-height:calc(100dvh - 6rem);display:flex;flex-direction:column;overflow:hidden;z-index:991;background:var(--surface-1);color:var(--text);border:1px solid var(--border);border-radius:var(--radius-panel);box-shadow:var(--shadow-panel);font:inherit;font-size:var(--control-font-size);line-height:1.5}
      #${ID},#${ID} *{box-sizing:border-box}
      #${ID} [hidden]{display:none!important}
      #${ID} header{display:flex;align-items:center;justify-content:space-between;gap:var(--control-gap);padding:var(--panel-padding);border-bottom:1px solid var(--border-strong)}
      #${ID} h2{font-size:var(--panel-heading-size);font-weight:500;margin:0}
      #${ID} .sr-loading-close{flex-shrink:0;width:var(--control-height);height:var(--control-height);padding:0}
      #${ID} .sr-loading-content{min-height:0;overflow:auto;overscroll-behavior:contain;scrollbar-gutter:stable;padding:var(--panel-padding)}
      #${ID} .sr-loading-hint{color:var(--text-muted);font-size:var(--control-font-size)}
      #${ID} .sr-loading-placeholders{display:grid;grid-template-columns:1fr 1fr;gap:var(--control-gap);margin-top:var(--section-gap)}
      #${ID} .sr-loading-placeholder{height:4rem;border-radius:var(--radius-control);background:var(--surface-2);border:1px solid var(--border-strong);animation:sr-loading-pulse 1.3s ease-in-out infinite alternate}
      #${ID} .sr-loading-actions{display:flex;gap:var(--control-gap);margin-top:var(--section-gap)}
      #${ID} .sr-loading-sheet-handle{display:none}
      @keyframes sr-loading-pulse{to{opacity:.45}}
      @media(prefers-reduced-motion:reduce){#${ID} .sr-loading-placeholder{animation:none}}
      @media(max-width:900px){#${ID}{top:auto;right:0;bottom:0;width:100vw;max-width:none;height:45dvh;max-height:45dvh;border-radius:var(--radius-panel) var(--radius-panel) 0 0}#${ID} header{padding-top:0}#${ID} .sr-loading-content{flex:1}#${ID} .sr-loading-sheet-handle{display:flex;align-items:center;justify-content:center;height:24px;flex-shrink:0}#${ID} .sr-loading-sheet-handle span{width:36px;height:4px;border-radius:4px;background:var(--text-muted)}}
    `;
    document.head.appendChild(style);
  }
  document.getElementById(ID)?.remove();
  const panel = document.createElement("section");
  panel.id = ID;
  panel.setAttribute(
    "aria-label",
    i18next.t("seedReport.title", "Seed report"),
  );
  const header = document.createElement("header");
  const title = document.createElement("h2");
  title.textContent = i18next.t("seedReport.title", "Seed report");
  const close = document.createElement("button");
  close.type = "button";
  close.className = "btn btn-sm btn-outline-light sr-loading-close";
  close.innerHTML = '<i class="bi bi-x-lg" aria-hidden="true"></i>';
  close.setAttribute("aria-label", i18next.t("seedReport.close", "Close"));
  close.addEventListener("click", onClose);
  header.append(title, close);
  const content = document.createElement("div");
  content.className = "sr-loading-content";
  const status = document.createElement("p");
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  const hint = document.createElement("p");
  hint.className = "sr-loading-hint";
  hint.textContent = i18next.t(
    "search.indexingHint",
    "You can navigate the map while data is loading",
  );
  const placeholders = document.createElement("div");
  placeholders.className = "sr-loading-placeholders";
  placeholders.setAttribute("aria-hidden", "true");
  for (let i = 0; i < 4; i++) {
    const block = document.createElement("div");
    block.className = "sr-loading-placeholder";
    placeholders.appendChild(block);
  }
  const actions = document.createElement("div");
  actions.className = "sr-loading-actions";
  const retry = document.createElement("button");
  retry.type = "button";
  retry.className = "btn btn-sm btn-outline-light";
  retry.textContent = i18next.t("seedReport.retry", { defaultValue: "Retry" });
  retry.addEventListener("click", onRetry);
  const reload = document.createElement("button");
  reload.type = "button";
  reload.className = "btn btn-sm btn-outline-light";
  reload.textContent = i18next.t("seedReport.reload", {
    defaultValue: "Reload page",
  });
  reload.addEventListener("click", () => window.location.reload());
  actions.append(retry, reload);
  content.append(status, hint, placeholders, actions);
  const handle = document.createElement("div");
  handle.className = "sr-loading-sheet-handle";
  handle.setAttribute("aria-hidden", "true");
  handle.append(document.createElement("span"));
  panel.append(handle, header, content);
  document.body.appendChild(panel);
  panel.classList.add("open");
  let slowTimer: ReturnType<typeof setTimeout> | undefined;
  const loading = () => {
    clearTimeout(slowTimer);
    panel.setAttribute("aria-busy", "true");
    status.textContent = i18next.t("search.indexing", "Loading data...");
    hint.textContent = i18next.t(
      "search.indexingHint",
      "You can navigate the map while data is loading",
    );
    placeholders.hidden = false;
    actions.hidden = true;
    slowTimer = setTimeout(() => {
      status.textContent = i18next.t("seedReport.loadingSlow", {
        defaultValue: "Still loading the seed report…",
      });
    }, 8000);
  };
  loading();
  return {
    loading,
    error() {
      clearTimeout(slowTimer);
      panel.setAttribute("aria-busy", "false");
      status.textContent = i18next.t("seedReport.loadingFailed", {
        defaultValue:
          "The seed report couldn't be loaded. Try again, or reload the page.",
      });
      hint.textContent = i18next.t("seedReport.loadErrorHint", {
        defaultValue: "You can keep using the map.",
      });
      placeholders.hidden = true;
      actions.hidden = false;
    },
    remove() {
      clearTimeout(slowTimer);
      panel.remove();
    },
  };
}
