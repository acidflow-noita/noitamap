const INTERVALS = [1000 / 60, 1000 / 30, 1000 / 20, 1000 / 15];

/** Sustained load lowers cadence; a longer recovery window avoids oscillation.
 * A slow frame must never permanently disable an otherwise healthy renderer. */
export class SunFramePacing {
  private level = 0;
  private slow = 0;
  private fast = 0;
  get intervalMS() { return INTERVALS[this.level]; }
  get fps() { return Math.round(1000 / this.intervalMS); }
  observe(costMS: number, warm: boolean) {
    if (warm || !Number.isFinite(costMS)) return;
    this.slow = costMS > this.intervalMS * .85 ? this.slow + 1 : 0;
    this.fast = this.level > 0 && costMS < INTERVALS[this.level - 1] * .65 ? this.fast + 1 : 0;
    if (this.slow >= 6 && this.level < INTERVALS.length - 1) {
      this.level++; this.slow = this.fast = 0;
    } else if (this.fast >= 45 && this.level > 0) {
      this.level--; this.slow = this.fast = 0;
    }
  }
}
