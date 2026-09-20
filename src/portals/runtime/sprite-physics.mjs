import { DT } from "./portal-physics.mjs";
const f = Math.fround;
const clamp = (x) => Math.min(1, Math.max(0, x));
// noita.exe 0x00da8430. Scale velocity is additive/second, NOT a per-frame multiplier.
export function stepSprite(p, dt = DT) {
  p.delay = f(p.delay - dt);
  if (p.delay > 0) return true;
  p.elapsed = f(p.elapsed + dt);
  if (p.elapsed < 0) return true;
  for (let i = 0; i < 4; i++)
    p.color[i] = clamp(f(f(p.colorChange[i] * dt) + p.color[i]));
  let angle = f(f(Math.atan2(p.sine, p.cosine)) + f(p.angularVelocity * dt));
  p.cosine = f(Math.cos(angle));
  p.sine = f(Math.sin(angle));
  p.scaleX = f(p.scaleX + f(p.scaleVelocityX * dt));
  p.scaleY = f(p.scaleY + f(p.scaleVelocityY * dt));
  if (p.velocityRotation) {
    const length = f(Math.sqrt(f(f(p.vx * p.vx) + f(p.vy * p.vy))));
    angle = f(
      (length === 0 ? 0 : f(Math.atan2(f(p.vy / length), f(p.vx / length)))) -
        f(Math.PI / 2),
    );
    p.cosine = f(Math.cos(angle));
    p.sine = f(Math.sin(angle));
  }
  p.x = f(p.x + f(p.vx * dt));
  p.y = f(p.y + f(p.vy * dt));
  p.vx = f(f(p.gx * dt) + p.vx);
  p.vy = f(p.vy + f(p.gy * dt));
  p.vx = f(p.vx - f(f(p.vx * p.slowdown) * dt));
  p.vy = f(p.vy - f(f(p.vy * p.slowdown) * dt));
  return p.elapsed < p.life;
}
