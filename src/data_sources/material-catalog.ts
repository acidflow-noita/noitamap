/** Shared lazy material catalog for public hooks and Pro card details. Calling
 * code retains its access checks; importing this module never starts a fetch. */
export interface MaterialCatalogEntry {
  id: string;
  [key: string]: any;
}

let byId: Map<string, MaterialCatalogEntry> | null = null;
let loading: Promise<void> | null = null;

export function loadMaterialCatalog(): Promise<void> {
  if (byId) return Promise.resolve();
  return loading ??= (async () => {
    try {
      const response = await fetch('assets/full_materials.json', { cache: 'force-cache' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const list: MaterialCatalogEntry[] = await response.json();
      const materials = new Map<string, MaterialCatalogEntry>();
      for (const material of list) {
        if (material?.id && !materials.has(material.id)) materials.set(material.id, material);
      }
      byId = materials;
    } catch (error) {
      // Preserve non-throwing card loaders, but leave a failed request retryable
      // when another card or public hook next asks for the catalog.
      console.warn('[material-catalog] Failed to load full_materials.json:', error);
    }
  })().finally(() => { loading = null; });
}

export function getCatalogMaterial(id: string): MaterialCatalogEntry | null {
  return byId?.get(id) ?? null;
}
