import { uncoveredReportMapRect, type ReportPanelBounds } from '../report-map-highlights';

/** Use the same uncovered rectangle as report overview fitting. Positive
 * offsets place the target left of a sidebar or above a bottom sheet. */
export function poiNavigationOffsets(
  width: number,
  height: number,
  panel?: ReportPanelBounds,
  canvas?: ReportPanelBounds,
  legacySidebarWidth = 0,
): { offsetXPx: number; offsetYPx: number } {
  const rect = panel ? uncoveredReportMapRect(width, height, panel, canvas) : null;
  return rect ? {
    offsetXPx: width / 2 - (rect.left + rect.right) / 2,
    offsetYPx: height / 2 - (rect.top + rect.bottom) / 2,
  } : { offsetXPx: Math.max(0, legacySidebarWidth) / 2, offsetYPx: 0 };
}
