import { createInstantClip } from './instant-terrain-clip';
import { WORLD_HEIGHT, WORLD_TOP, type TerrainOwnership, type VerticalPlane } from './terrain-policy';
import type { StaticTerrainMask } from './static-terrain-mask';

export interface TerrainViewportPlan {
  x: number;
  y: number;
  width: number;
  height: number;
  scale: number;
  pixelWidth: number;
  pixelHeight: number;
}

export interface TerrainViewportInputs {
  owners: Pick<TerrainOwnership, 'width' | 'owners'>[];
  masks: StaticTerrainMask[];
  center: number;
  /** Supplied by the UI because workers may lack device-memory/touch hints. */
  maskCacheBytes?: number;
}

/** Horizontal wrapping and absolute-world noise already belong to the shader.
 * One viewport therefore needs at most three draws, not one job per OSD tile
 * or parallel world. Every adjacent strip uses the same integer screen edge. */
export function terrainViewportStrips(plan: TerrainViewportPlan, center: number) {
  const strips = [];
  for (const plane of [-1, 0, 1] as VerticalPlane[]) {
    const top = WORLD_TOP + plane * WORLD_HEIGHT;
    const start = Math.max(0, Math.min(plan.pixelHeight, Math.ceil((top - plan.y) / plan.scale - 0.5)));
    const end = Math.max(0, Math.min(plan.pixelHeight, Math.ceil((top + WORLD_HEIGHT - plan.y) / plan.scale - 0.5)));
    if (end <= start) continue;
    const y = plan.y + start * plan.scale;
    const height = end - start;
    strips.push({ plane, offsetY: start, view: {
      x: plan.x, y, width: plan.pixelWidth, height, scale: plan.scale,
      camX: plan.x + plan.pixelWidth * plan.scale / 2 + center * 512,
      camY: y + height * plan.scale / 2 + 7168,
      camZ: 1 / plan.scale, pw: 0, pwVertical: 0,
      edgeNoise: true, materialTextures: true, engineTerrain: true,
    } });
  }
  return strips;
}

/** Runs in the GPU worker. Mask expansion, clipping and all-plane composition
 * finish there before a single transferable frame reaches the UI thread. */
export function createTerrainViewportCompositor(inputs: TerrainViewportInputs) {
  const clip = createInstantClip(inputs.owners, inputs.masks, { maxBytes: inputs.maskCacheBytes });
  const surface = document.createElement('canvas');
  const scratch = document.createElement('canvas');
  const output = surface.getContext('2d')!;
  const context = scratch.getContext('2d')!;
  if (!output || !context) throw new Error('Viewport canvas unavailable');
  return {
    render(resources: { setPlane(plane: VerticalPlane): void; render(view: any): any }, plan: TerrainViewportPlan) {
      if (![plan.x, plan.y, plan.scale, plan.pixelWidth, plan.pixelHeight].every(Number.isFinite)
        || plan.scale <= 0 || !Number.isInteger(plan.pixelWidth) || !Number.isInteger(plan.pixelHeight)
        || plan.pixelWidth < 1 || plan.pixelHeight < 1) throw new Error('Invalid terrain viewport');
      if (surface.width !== plan.pixelWidth) surface.width = plan.pixelWidth;
      if (surface.height !== plan.pixelHeight) surface.height = plan.pixelHeight;
      output.clearRect(0, 0, surface.width, surface.height);
      output.imageSmoothingEnabled = false;
      for (const { plane, offsetY, view } of terrainViewportStrips(plan, inputs.center)) {
        if (!clip.hasTerrain(view)) continue;
        resources.setPlane(plane);
        const image = resources.render(view);
        if (!image) throw new Error('GPU viewport draw unavailable');
        if (scratch.width !== view.width) scratch.width = view.width;
        if (scratch.height !== view.height) scratch.height = view.height;
        context.clearRect(0, 0, scratch.width, scratch.height);
        clip.draw(context, image, view);
        output.drawImage(scratch, 0, offsetY);
      }
      return surface;
    },
    dispose() {
      clip.dispose();
      surface.width = surface.height = scratch.width = scratch.height = 0;
    },
  };
}
