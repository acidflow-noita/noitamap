/** Drawing owns map gestures for the whole sidebar session, including its
 * loading shell and temporary Move/pan tool. Do not infer this from OSD's
 * navigation flag: drawing and panning can both leave that flag enabled. */
export function drawingOwnsMapPointer(): boolean {
  return !!(
    document.querySelector<HTMLInputElement>("#drawToggleBtn")?.checked ||
    document.querySelector(".drawing-sidebar.open, .drawing-toolbar.open")
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
