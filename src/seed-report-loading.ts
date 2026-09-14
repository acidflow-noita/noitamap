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
      #${ID}{position:fixed;top:4.5rem;right:1.5rem;width:clamp(22rem,40vw,60vw);max-height:calc(100vh - 6rem);overflow:auto;z-index:991;background:var(--surface-1);color:var(--text);border:1px solid var(--border);border-radius:var(--radius-panel);box-shadow:var(--shadow-panel);font-size:.85rem;transform:translateX(calc(100% + 2rem));transition:transform .3s ease}
      #${ID}.open{transform:translateX(0)}
      #${ID} [hidden]{display:none!important}
      #${ID} header{display:flex;align-items:center;justify-content:space-between;padding:.6rem .85rem;border-bottom:1px solid var(--border-strong)}
      #${ID} h2{font-size:inherit;font-weight:600;margin:0}
      #${ID} .sr-loading-close{background:none;border:0;color:var(--text-muted);font-size:1.25rem;cursor:pointer;padding:0 .35rem}
      #${ID} .sr-loading-content{padding:1rem .85rem}
      #${ID} .sr-loading-hint{color:var(--text-muted);font-size:.8rem}
      #${ID} .sr-loading-placeholders{display:grid;grid-template-columns:1fr 1fr;gap:.6rem;margin-top:1rem}
      #${ID} .sr-loading-placeholder{height:4rem;border-radius:var(--radius-control);background:var(--surface-2);border:1px solid var(--border-strong);animation:sr-loading-pulse 1.3s ease-in-out infinite alternate}
      #${ID} .sr-loading-actions{display:flex;gap:.5rem;margin-top:1rem}
      @keyframes sr-loading-pulse{to{opacity:.45}}
      #${ID}[data-preview="v2"]{top:4.5rem;right:1.25rem;width:clamp(34rem,44vw,42rem);max-width:calc(100vw - 2rem);max-height:calc(100dvh - 6rem);font-size:.875rem}
      @media(prefers-reduced-motion:reduce){#${ID}{transition:none}#${ID} .sr-loading-placeholder{animation:none}}
      @media(max-width:900px){#${ID}{top:3.5rem;right:.5rem;width:calc(100vw - 1rem);max-height:calc(100vh - 4.5rem);font-size:.8rem}}
      @media(max-width:600px){#${ID}[data-preview="v2"]{top:auto;bottom:.5rem;right:.5rem;width:calc(100vw - 1rem);max-width:none;max-height:75dvh}}
    `;
    document.head.appendChild(style);
  }
  document.getElementById(ID)?.remove();
  const panel = document.createElement("section");
  panel.id = ID;
  if (new URLSearchParams(window.location.search).get("reportPreview") === "v2") panel.dataset.preview = "v2";
  panel.setAttribute(
    "aria-label",
    i18next.t("seedReport.title", "Seed report"),
  );
  const header = document.createElement("header");
  const title = document.createElement("h2");
  title.textContent = i18next.t("seedReport.title", "Seed report");
  const close = document.createElement("button");
  close.type = "button";
  close.className = "sr-loading-close";
  close.textContent = "×";
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
  panel.append(header, content);
  document.body.appendChild(panel);
  void panel.offsetWidth;
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
