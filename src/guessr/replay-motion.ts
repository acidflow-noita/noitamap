export const REPLAY_MOVE_MS = 700;
const timing: KeyframeAnimationOptions = {
  duration: REPLAY_MOVE_MS,
  easing: 'cubic-bezier(0.333333, 0, 0.666667, 1)',
  fill: 'both',
};

/** The camera, map and marker for one recorded action pause and cancel together. */
export class ReplayMotion {
  readonly reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  private animations = new Map<Animation, () => void>();
  private paused = false;
  private cancelled = false;

  async animate(element: Element, frames: Keyframe[], onInterrupt?: (progress: number) => void): Promise<boolean> {
    if (this.cancelled || this.reduced || typeof element.animate !== 'function') return !this.cancelled;
    const animation = element.animate(frames, timing);
    this.animations.set(animation, () => {
      onInterrupt?.(animation.effect?.getComputedTiming().progress ?? 0);
      animation.cancel();
    });
    if (this.paused) animation.pause();
    try {
      await animation.finished;
      return !this.cancelled;
    } catch (error) {
      if (this.cancelled) return false;
      throw error;
    } finally {
      this.animations.delete(animation);
      animation.cancel();
    }
  }

  pause(): void {
    this.paused = true;
    for (const animation of this.animations.keys()) animation.pause();
  }

  cancel(): void {
    if (this.cancelled) return;
    this.cancelled = true;
    for (const stop of this.animations.values()) stop();
    this.animations.clear();
  }
}
