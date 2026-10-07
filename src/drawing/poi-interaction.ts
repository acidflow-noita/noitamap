let reportedOwnership: boolean | undefined;
const listeners = new Set<(owned: boolean) => void>();

/** Pro reports its open-menu/editor/visible-drawing state. This is independent
 * of authentication and OSD navigation (temporary pan still belongs to drawing). */
export function setDrawingMapOwnership(owned: boolean): void {
  const previous = drawingOwnsMapPointer();
  reportedOwnership = owned;
  if (owned !== previous) for (const listener of listeners) listener(owned);
}

export function onDrawingMapOwnershipChange(listener: (owned: boolean) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function drawingOwnsMapPointer(): boolean {
  if (reportedOwnership !== undefined) return reportedOwnership;
  // Independently deployed older Pro bundles cannot report their state yet.
  // Preserve their active-session guard, but a loading shell alone owns nothing.
  const hooks = window.__noitamap;
  const ready = hooks?.isProFeatureReady?.('drawing') ?? !!hooks?.handleImportDrop;
  return !!(
    (ready && document.querySelector<HTMLInputElement>("#drawToggleBtn")?.checked) ||
    document.querySelector('.drawing-sidebar.open:not(#drawing-sidebar-skel), .drawing-toolbar.open:not(#drawing-toolbar-skel)')
  );
}

/** OSD also emits canvas-click on release after a drag (quick=false). */
export function canOpenPOIFromCanvas(event: {
  quick?: boolean;
  preventDefaultAction?: boolean;
}): boolean {
  return (
    event.quick === true &&
    !event.preventDefaultAction &&
    !drawingOwnsMapPointer()
  );
}
