/**
 * Lazy loader for FULL_MATERIALS_FINAL.json (Noita material dump).
 *
 * Kept out of the main bundle (~2 MB) — loaded on demand via fetch() from
 * /assets/full_materials.json and cached by the browser + this module.
 */

export interface MaterialInfo {
  id: string;
  ui_name?: string;
  name_translation_placeholder?: string;
  cell_type?: string;
  graphics?: { color?: string | null; [k: string]: any };
  wang_color?: string | null;
  [k: string]: any;
}

let byId: Map<string, MaterialInfo> | null = null;
let loading: Promise<void> | null = null;

export async function primeMaterialInfo(): Promise<void> {
  if (byId) return;
  if (loading) return loading;
  loading = (async () => {
    try {
      const res = await fetch("assets/full_materials.json", { cache: "force-cache" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const list: MaterialInfo[] = await res.json();
      const m = new Map<string, MaterialInfo>();
      for (const mat of list) if (mat && mat.id) m.set(mat.id, mat);
      byId = m;
    } catch (err) {
      console.warn("[materialInfo] Failed to load FULL_MATERIALS_FINAL.json:", err);
      byId = new Map();
    } finally {
      loading = null;
    }
  })();
  return loading;
}

export function getMaterialInfo(id: string): MaterialInfo | null {
  if (!byId) return null;
  return byId.get(id) ?? null;
}
