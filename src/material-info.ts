/**
 * Lazy loader for FULL_MATERIALS_FINAL.json (Noita material dump).
 *
 * Kept out of the main bundle (~2 MB) — loaded on demand via fetch() from
 * /assets/full_materials.json and cached by the browser + this module.
 */

import { getCatalogMaterial, loadMaterialCatalog } from './data_sources/material-catalog';

export interface MaterialInfo {
  id: string;
  ui_name?: string;
  name_translation_placeholder?: string;
  cell_type?: string;
  graphics?: { color?: string | null; [k: string]: any };
  wang_color?: string | null;
  [k: string]: any;
}

export const primeMaterialInfo = loadMaterialCatalog;

export function getMaterialInfo(id: string): MaterialInfo | null {
  return getCatalogMaterial(id);
}
