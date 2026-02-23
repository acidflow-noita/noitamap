
export function setupDropOverlay(
  i18next: any,
  loadProCallback: () => Promise<boolean>
) {
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
        <div class="drop-zone-types">${i18next.t("drawing.import.dropHintVectorizeTypes", "PNG, JPG, WebP, SVG")}</div>
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

  // Store reference in window so pro bundle can access it
  if (window.__noitamap) {
    window.__noitamap.dropOverlay = dropOverlay;
  }

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
      dragCounter = 0;
      dropOverlay.classList.remove("visible");
      importZone.classList.remove("active");
      vectorizeZone.classList.remove("active");
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
      dragCounter = 0;
      dropOverlay.classList.remove("visible");
      importZone.classList.remove("active");
      vectorizeZone.classList.remove("active");
      return;
    }

    const file = e.dataTransfer?.files[0];
    if (!file) {
      dragCounter = 0;
      dropOverlay.classList.remove("visible");
      importZone.classList.remove("active");
      vectorizeZone.classList.remove("active");
      return;
    }

    // Determine action
    const isVectorize = zone === vectorizeZone;
    const isImport = zone === importZone;

    if (!isVectorize && !isImport) return; // Should not happen given check above

    // Handler function name based on zone
    const handlerName = isVectorize ? "handleVectorizeDrop" : "handleImportDrop";

    // If pro handler not ready, try loading pro
    if (!window.__noitamap?.[handlerName]) {
      // Show loading state in the zone
      const loadingEl = zone.querySelector(".drop-zone-loading") as HTMLElement;
      const contentEl = zone.querySelector(".drop-zone-content") as HTMLElement;
      
      if (loadingEl && contentEl) {
        contentEl.style.display = "none";
        loadingEl.style.display = "flex";
      }

      console.log(`[DropOverlay] Pro handler ${handlerName} missing, attempting to load pro...`);
      const loaded = await loadProCallback();
      
      if (!loaded || !window.__noitamap?.[handlerName]) {
        console.warn(`[DropOverlay] Failed to load pro or handler still missing.`);
        // Reset UI
        dragCounter = 0;
        dropOverlay.classList.remove("visible");
        importZone.classList.remove("active");
        vectorizeZone.classList.remove("active");
        if (loadingEl && contentEl) {
          loadingEl.style.display = "none";
          contentEl.style.display = "";
        }
        
        // Show auth prompt only if loading failed due to auth?
        // Actually loadProCallback handles auth check and returns false if no token.
        // We can show a generic "requires subscription" toast or alert.
        // But let's assume loadProCallback logs warnings.
        // Ideally we should use a Toast here, but i18next is available so we can alert.
        alert(i18next.t("drawing.auth.subscriberOnly", "This feature requires a subscription."));
        return;
      }
    }

    // Pro loaded and handler available
    // For vectorize, keep overlay open (it shows progress)
    // For import, close overlay? Or let handler close it?
    // Handler closes it in pro-entry.ts usually.
    // But since we manage overlay here, maybe we should close it for import?
    // Re-checking pro-entry.ts: handleImportDrop DOES NOT close overlay. setupDragAndDrop did.
    // So we should close it here for import.
    // For vectorize, it updates UI inside overlay.

    if (isImport) {
      dragCounter = 0;
      dropOverlay.classList.remove("visible");
      importZone.classList.remove("active");
      vectorizeZone.classList.remove("active");
      if (window.__noitamap?.handleImportDrop) {
        await window.__noitamap.handleImportDrop(file);
      }
    } else if (isVectorize) {
      // Reset active class but keep overlay visible
      importZone.classList.remove("active");
      vectorizeZone.classList.remove("active");
      // Let handler manage the rest (progress etc)
      if (window.__noitamap?.handleVectorizeDrop) {
        await window.__noitamap.handleVectorizeDrop(file);
      }
      // Note: handler should close overlay when done!
      // In pro-entry.ts handleVectorizeDrop: "dropOverlay.classList.remove('visible');"
      // So we must ensure it has access to dropOverlay.
      // We stored it in window.__noitamap.dropOverlay.
    }
  });
}
