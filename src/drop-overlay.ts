export function setupDropOverlay(i18next: any, loadProCallback: () => Promise<boolean>) {
  const dropOverlay = document.createElement("div");
  dropOverlay.className = "drop-overlay";
  dropOverlay.innerHTML = `
    <div class="drop-zone drop-zone-import">
      <div class="drop-zone-content">
        <i class="bi bi-file-earmark-arrow-down" style="font-size:2rem"></i>
        <div class="drop-zone-title">${i18next.t("drawing.import.dropHintImport", "Import Drawing")}</div>
        <div class="drop-zone-types">${i18next.t("drawing.import.dropHintImportTypes", "WebP or JSON")}</div>
      </div>
      <div class="drop-zone-loading" style="display:none">
        <div class="spinner-border text-light" role="status"></div>
      </div>
    </div>
    <div class="drop-zone drop-zone-vectorize">
      <div class="drop-zone-content">
        <i class="bi bi-vector-pen" style="font-size:2rem"></i>
        <div class="drop-zone-title">${i18next.t("drawing.import.dropHintVectorize", "Vectorize Image")}</div>
        <div class="drop-zone-types">${i18next.t("drawing.import.dropHintVectorizeTypes", "Drop or Ctrl+V: PNG, JPG, WebP, GIF, BMP, ICO")}</div>
      </div>
      <div class="drop-zone-loading" style="display:none">
        <div class="spinner-border text-light" role="status"></div>
        <div class="drop-zone-progress"></div>
      </div>
    </div>
  `;
  document.body.appendChild(dropOverlay);

  const importZone = dropOverlay.querySelector(".drop-zone-import") as HTMLElement;
  const vectorizeZone = dropOverlay.querySelector(".drop-zone-vectorize") as HTMLElement;
  let dragCounter = 0;

  function resetOverlay() {
    dragCounter = 0;
    dropOverlay.classList.remove("visible");
    importZone.classList.remove("active");
    vectorizeZone.classList.remove("active");
  }

  // Store reference in window so pro bundle can access it
  if (window.__noitamap) {
    window.__noitamap.dropOverlay = dropOverlay;
    window.__noitamap.resetDragState = resetOverlay;
  }

  /**
   * Ensure the pro handler is loaded, returning true if ready.
   * Shows loading spinner in the given zone element while loading.
   */
  async function ensureProHandler(
    handlerName: "handleVectorizeDrop" | "handleImportDrop",
    zone?: HTMLElement,
  ): Promise<boolean> {
    if (window.__noitamap?.[handlerName]) return true;

    let loadingEl: HTMLElement | null = null;
    let contentEl: HTMLElement | null = null;
    if (zone) {
      loadingEl = zone.querySelector(".drop-zone-loading") as HTMLElement;
      contentEl = zone.querySelector(".drop-zone-content") as HTMLElement;
      if (loadingEl && contentEl) {
        contentEl.style.display = "none";
        loadingEl.style.display = "flex";
      }
    }

    console.log(`[DropOverlay] Pro handler ${handlerName} missing, attempting to load pro...`);
    const loaded = await loadProCallback();

    if (!loaded || !window.__noitamap?.[handlerName]) {
      console.warn(`[DropOverlay] Failed to load pro or handler still missing.`);
      resetOverlay();
      if (loadingEl && contentEl) {
        loadingEl.style.display = "none";
        contentEl.style.display = "";
      }
      alert(i18next.t("drawing.auth.subscriberOnly", "This feature requires a subscription."));
      return false;
    }
    return true;
  }

  // ─── Ctrl+V / Paste handler ────────────────────────────────────────────────
  document.addEventListener("paste", async (e) => {
    // Ignore paste if user is typing in an input or textarea
    const active = document.activeElement;
    if (
      active instanceof HTMLInputElement ||
      active instanceof HTMLTextAreaElement ||
      (active as HTMLElement)?.isContentEditable
    ) {
      return;
    }

    const items = e.clipboardData?.items;
    if (!items) return;

    // Look for an image item in the clipboard
    let imageItem: DataTransferItem | null = null;
    let fileItem: DataTransferItem | null = null;
    for (const item of items) {
      if (item.kind === "file" && item.type.startsWith("image/")) {
        imageItem = item;
      } else if (item.kind === "file") {
        fileItem = item;
      }
    }

    if (!imageItem && !fileItem) return;

    e.preventDefault();

    const file = (imageItem ?? fileItem)!.getAsFile();
    if (!file) return;

    // Decide: import or vectorize based on file type
    const ext = file.name?.toLowerCase() ?? "";
    const isDrawingImport = ext.endsWith(".json") || (ext.endsWith(".webp") && file.type === "image/webp" && !imageItem);

    if (isDrawingImport) {
      // Import drawing (JSON or WebP drawing export)
      if (!(await ensureProHandler("handleImportDrop"))) return;
      await window.__noitamap!.handleImportDrop!(file);
    } else {
      // Vectorize image (screenshots, PNGs, JPGs, etc.)
      if (!(await ensureProHandler("handleVectorizeDrop"))) return;
      await window.__noitamap!.handleVectorizeDrop!(file);
    }
  });

  // ─── Drag & Drop handlers ─────────────────────────────────────────────────
  document.addEventListener("dragenter", (e) => {
    // Check if dragging files
    if (!e.dataTransfer?.types?.includes("Files")) return;

    e.preventDefault();
    dragCounter++;
    if (dragCounter === 1) {
      dropOverlay.classList.add("visible");
    }
  });

  document.addEventListener("dragleave", (e) => {
    e.preventDefault();
    dragCounter--;
    if (dragCounter <= 0) {
      resetOverlay();
    }
  });

  document.addEventListener("dragover", (e) => {
    e.preventDefault();
    if (e.dataTransfer) {
      e.dataTransfer.dropEffect = "copy";
    }
    // Only highlight zones if overlay is visible (dragenter fires first)
    if (dropOverlay.classList.contains("visible")) {
      const target = e.target as HTMLElement;
      const zone = target.closest(".drop-zone");
      importZone.classList.toggle("active", zone === importZone);
      vectorizeZone.classList.toggle("active", zone === vectorizeZone);
    }
  });

  document.addEventListener("drop", async (e) => {
    e.preventDefault();

    // Only reset if we are dropping on valid zone or outside
    const target = e.target as HTMLElement;
    const zone = target.closest(".drop-zone");

    // If dropped outside zones, just close overlay
    if (!zone) {
      resetOverlay();
      return;
    }

    const file = e.dataTransfer?.files[0];
    if (!file) {
      resetOverlay();
      return;
    }

    // Determine action
    const isVectorize = zone === vectorizeZone;
    const isImport = zone === importZone;

    if (!isVectorize && !isImport) return;

    const handlerName = isVectorize ? "handleVectorizeDrop" : "handleImportDrop";

    if (!(await ensureProHandler(handlerName as any, zone as HTMLElement))) return;

    if (isImport) {
      resetOverlay();
      if (window.__noitamap?.handleImportDrop) {
        await window.__noitamap.handleImportDrop(file);
      }
    } else if (isVectorize) {
      // Reset drag state but keep overlay visible for progress
      dragCounter = 0;
      importZone.classList.remove("active");
      vectorizeZone.classList.remove("active");
      if (window.__noitamap?.handleVectorizeDrop) {
        await window.__noitamap.handleVectorizeDrop(file);
      }
    }
  });
}
