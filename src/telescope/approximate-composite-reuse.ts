export interface ApproximateComposite {
  blob: Blob;
  minX: number;
  minY: number;
  osdWidth: number;
}

export function canShareApproximateComposites(generation: {
  isNGP: boolean; worldSize: number; tileLayers: readonly object[];
}): boolean {
  // render-perf's fill overlays use world-coordinate edge noise even in its
  // cheap renderer. Their edges can differ between horizontal worlds.
  return !generation.isNGP && generation.worldSize === 70 &&
    !generation.tileLayers.some(layer => 'isFill' in layer && layer.isFill);
}

/** The cheap NG0 renderer wraps its biome lookup by exactly one world width.
 * Horizontal worlds therefore have identical terrain pixels; only their map
 * placement differs. This does NOT apply to scenes, POIs, full pixels or NG+,
 * whose upstream tile-to-world offset differs from the biome-map width. */
export class ApproximateCompositeReuse {
  private readonly composites = new Map<string, ApproximateComposite>();

  constructor(
    private readonly worldWidth: number,
    private readonly shareHorizontal: boolean,
  ) {}

  private key(pw: number, plane: number): string {
    return `${this.shareHorizontal ? 0 : pw},${plane}`;
  }

  remember(pw: number, plane: number, composite: ApproximateComposite): void {
    const key = this.key(pw, plane);
    if (this.composites.has(key)) return;
    this.composites.set(key, {
      ...composite,
      minX: composite.minX - (this.shareHorizontal ? pw * this.worldWidth : 0),
    });
  }

  get(pw: number, plane: number): ApproximateComposite | undefined {
    const composite = this.composites.get(this.key(pw, plane));
    if (!composite) return undefined;
    return {
      ...composite,
      minX: composite.minX + (this.shareHorizontal ? pw * this.worldWidth : 0),
    };
  }
}
