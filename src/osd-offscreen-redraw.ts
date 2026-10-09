const installed = new WeakMap<object, () => void>();

/** OSD treats an image with no drawn tiles as needing its first tile. For an
 * offscreen parallel world that never happens, keeping the entire canvas in
 * an idle redraw loop. Use OSD's own draw-area calculation to distinguish it
 * from a visible image still waiting for tiles. */
export function installOffscreenRedrawGuard(viewer: any, enabled: () => boolean): () => void {
  const existing = installed.get(viewer);
  if (existing) return existing;
  let disposed = false;
  const items = new Map<any, { original: (...args: any[]) => any; wrapper: (...args: any[]) => any; active: boolean }>();
  const attach = (item: any) => {
    if (items.has(item) || typeof item?.setDrawn !== 'function') return;
    const original = item.setDrawn;
    const entry = { original, wrapper: null! as (...args: any[]) => any, active: true };
    entry.wrapper = function(this: any, ...args: any[]) {
      const needsDraw = original.apply(this, args);
      if (needsDraw && !disposed && entry.active && enabled()
        && typeof this.getDrawArea === 'function' && !this.getDrawArea()) {
        this._needsDraw = false;
        return false;
      }
      return needsDraw;
    };
    items.set(item, entry);
    item.setDrawn = entry.wrapper;
  };
  const detach = (item: any) => {
    const entry = items.get(item);
    if (!entry) return;
    entry.active = false;
    if (item.setDrawn === entry.wrapper) item.setDrawn = entry.original;
    items.delete(item);
  };
  const added = ({ item }: any) => attach(item);
  const removed = ({ item }: any) => detach(item);
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    for (const item of [...items.keys()]) detach(item);
    viewer.world.removeHandler('add-item', added);
    viewer.world.removeHandler('remove-item', removed);
    viewer.removeHandler('before-destroy', dispose);
    installed.delete(viewer);
  };
  installed.set(viewer, dispose);
  viewer.world.addHandler('add-item', added);
  viewer.world.addHandler('remove-item', removed);
  viewer.addHandler('before-destroy', dispose);
  for (let i = 0; i < viewer.world.getItemCount(); i++) attach(viewer.world.getItemAt(i));
  return dispose;
}
