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

  // ─── Bootstrap Ctrl+V paste handler ──────────────────────────────────────
  // The real paste handler lives in the pro bundle (setupPasteHandler in pro-entry.ts).
  // This bootstrap listener loads the pro bundle on the first paste, then forwards
  // the pasted data to the newly-available handler. It removes itself once pro is loaded.
  const bootstrapPasteHandler = async (e: ClipboardEvent) => {
    // Don't intercept when typing in inputs/textareas
    if (
      e.target instanceof HTMLInputElement ||
      e.target instanceof HTMLTextAreaElement ||
      (e.target instanceof HTMLElement && e.target.isContentEditable)
    )
      return;

    // If pro bundle is already loaded, this bootstrap handler is redundant
    if (window.__noitamap?.handleVectorizeDrop) {
      document.removeEventListener("paste", bootstrapPasteHandler);
      return;
    }

    const clipboardData = e.clipboardData;
    if (!clipboardData) return;

    // ── Extract image blob if present ──
    let imageBlob: File | null = null;
    const files = Array.from(clipboardData.files || []);
    if (files.length > 0) {
      const maybeImage = files.find((f) => f.type.startsWith("image/"));
      if (maybeImage) imageBlob = maybeImage;
    }
    if (!imageBlob) {
      const imageItem = Array.from(clipboardData.items).find(
        (item) => item.kind === "file" && item.type.startsWith("image/"),
      );
      if (imageItem) imageBlob = imageItem.getAsFile();
    }

    // ── Extract JSON text if present ──
    // Read the text synchronously via getData (available during the paste event).
    let jsonText: string | null = null;
    if (!imageBlob) {
      const rawText = clipboardData.getData("text/plain");
      if (rawText) {
        const trimmed = rawText.trim();
        if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
          try {
            const data = JSON.parse(trimmed);
            const isShapeArray = Array.isArray(data) && data.length > 0 && data[0].type && data[0].pos;
            const isDrawingObject = data?.shapes && Array.isArray(data.shapes);
            if (isShapeArray || isDrawingObject) {
              jsonText = trimmed;
            }
          } catch {
            // Not valid JSON — ignore
          }
        }
      }
    }

    // Nothing pasteable found
    if (!imageBlob && !jsonText) return;

    e.preventDefault();
    console.log("[DropOverlay] Paste detected, loading pro bundle…");

    // Show visual loading indicator using the drop overlay
    const loadingEl = vectorizeZone.querySelector(".drop-zone-loading") as HTMLElement;
    const contentEl = vectorizeZone.querySelector(".drop-zone-content") as HTMLElement;
    const progressEl = vectorizeZone.querySelector(".drop-zone-progress") as HTMLElement;
    dropOverlay.classList.add("visible");
    importZone.style.display = "none";
    if (contentEl) contentEl.style.display = "none";
    if (loadingEl) loadingEl.style.display = "flex";
    if (progressEl)
      progressEl.textContent = i18next.t("drawing.import.loadingModule", "Loading image processing module…");

    const loaded = await loadProCallback();

    // Hide loading indicator
    dropOverlay.classList.remove("visible");
    importZone.style.display = "";
    if (contentEl) contentEl.style.display = "";
    if (loadingEl) loadingEl.style.display = "none";

    if (!loaded) return;

    // Remove this bootstrap handler — the pro bundle's handler takes over
    document.removeEventListener("paste", bootstrapPasteHandler);

    // Route to the appropriate pro handler with the extracted data
    if (imageBlob) {
      // Check if it's a WebP with embedded drawing data (import vs vectorize)
      if (imageBlob.type === "image/webp" && window.__noitamap?.handleImportDrop) {
        // Let the pro handler decide — pass as import first
        const file = new File([imageBlob], imageBlob.name || "pasted-image.webp", { type: imageBlob.type });
        await window.__noitamap.handleImportDrop(file);
      } else if (window.__noitamap?.handleVectorizeDrop) {
        const ext = imageBlob.name ? imageBlob.name.split(".").pop() : imageBlob.type.split("/")[1] || "png";
        const file = new File([imageBlob], imageBlob.name || `pasted-image.${ext}`, { type: imageBlob.type });
        await window.__noitamap.handleVectorizeDrop(file);
      }
    } else if (jsonText && window.__noitamap?.handleImportDrop) {
      const file = new File([jsonText], "pasted-drawing.json", { type: "application/json" });
      await window.__noitamap.handleImportDrop(file);
    }
  };

  document.addEventListener("paste", bootstrapPasteHandler);

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
    const ext = file.name?.toLowerCase() ?? "";
    let isDrawingImport = false;

    if (isImport) {
      isDrawingImport = true;
    } else if (isVectorize) {
      if (ext.endsWith(".webp") && file.type === "image/webp") {
        // @ts-ignore
        if (window.__noitamap?.isWebPDrawing) {
          // @ts-ignore
          isDrawingImport = await window.__noitamap.isWebPDrawing(file);
        }
      }
    }

    const handlerName = isDrawingImport ? "handleImportDrop" : "handleVectorizeDrop";

    if (!(await ensureProHandler(handlerName as any, zone as HTMLElement))) return;

    if (isDrawingImport) {
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
