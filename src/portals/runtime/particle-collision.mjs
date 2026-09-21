// Native 0x00712390 ordinary cosmetic-particle collision branch. The sampled
// world position is distinct from the long-particle rendered endpoint.
// Collision randomness is per-particle for deterministic GPU/shadow replay;
// it cannot reproduce the live game's globally interleaved cosmetic RNG.
/** @typedef {{width: number, height: number, x: number, y: number, cells: Uint8Array}} ParticleCollisionField */
const f = Math.fround;

// Only the reviewed eye trails enable collision: zero gravity/attractor and
// airflow <= .02 px/s per step. A reset yields speed < 40 and life <= 1.5s.
// Subsequent worst-case speeds (including <=10 jitter and <=1.82 airflow) are
// (40+10+1.82)*.3 < 15.55, then (15.55+10+1.82)*.3 < 8.22: bounce is disabled.
// Thus at most three resets can each ADD <.5s when remaining life is near 1s.
// Reserve 90 steps + float32/endpoint slack, never clamp the actual lifetime.
export const COLLISION_RETENTION_STEPS = 94;

// The material program is anchored at the portal's world position, not at a
// canvas crop. Unknown cells/outside the reviewed scene deliberately stay air.
export function collisionFieldFor(sim, field) {
  return field && ["eye_room", "teleport_hourglass_return"].includes(sim.effect)
    ? { ...field, x: field.x - sim.x, y: field.y - sim.y }
    : null;
}

export function blocksParticle(field, x, y) {
  const col = Math.trunc(x) + Math.trunc(field.x),
    row = Math.trunc(y) + Math.trunc(field.y);
  if (col < 0 || row < 0 || col >= field.width || row >= field.height)
    return false;
  const kind = field.cells[row * field.width + col];
  return kind === 1 || kind === 3;
}

// CPU reference and GPU restoration path. Both use the same isolated collision
// stream, leaving the emission RNG streams unchanged during shadow replay.
export function collideParticle(p, x, y, field) {
  const previousX = p.x,
    previousY = p.y;
  p.x = x;
  p.y = y;
  if (!p.collideWithGrid || !field) return;
  const dx = f(x - (p.collisionX ?? previousX)),
    dy = f(y - (p.collisionY ?? previousY));
  const distance = f(Math.sqrt(f(f(dx * dx) + f(dy * dy))));
  const steps = Math.min(Math.trunc(f(distance + 0.5)), 60);
  if (!steps) return;
  const tx = distance > 0 ? f(dx / distance) : 0,
    ty = distance > 0 ? f(dy / distance) : 0;
  let sampleX = previousX,
    sampleY = previousY,
    lastX = previousX,
    lastY = previousY;
  const range = (low, high) => {
    p.collisionRng = ((p.collisionRng || 1) * 16807) % 2147483647;
    return f((p.collisionRng / 2147483647) * (high - low) + low);
  };
  for (let i = 0; i < steps; i++) {
    sampleX = f(sampleX + tx);
    sampleY = f(sampleY + ty);
    if (
      i > 0 &&
      Math.trunc(sampleX) === Math.trunc(lastX) &&
      Math.trunc(sampleY) === Math.trunc(lastY)
    )
      continue;
    if (blocksParticle(field, sampleX, sampleY)) {
      p.x = lastX;
      p.y = lastY;
      if (p.collisionBounce === false || p.cellType === "liquid") {
        p.life = -1;
        return;
      }
      if (Math.abs(tx) <= Math.abs(ty)) p.vy = -p.vy;
      else p.vx = -p.vx;
      if (Math.abs(p.vx) < 10) p.vx = f(p.vx + range(-10, 10));
      const damping = range(0.1, 0.3);
      p.vx = f(p.vx * damping);
      p.vy = f(p.vy * damping);
      const speedSquared = f(f(p.vx * p.vx) + f(p.vy * p.vy));
      if (p.life > 1 && speedSquared < 1600) p.life = range(0.5, 1.5);
      if (speedSquared < 100) p.collisionBounce = false;
      return;
    }
    lastX = sampleX;
    lastY = sampleY;
    p.collisionX = Math.trunc(sampleX);
    p.collisionY = Math.trunc(sampleY);
  }
}

export const COLLISION_GLSL = `
uniform highp usampler2D collisionCells;
uniform bool collisionEnabled;
uniform vec2 collisionOrigin;
uniform ivec2 collisionSize;
uint collisionRandom(inout uint state) {
  // Schrage form of Park-Miller: no uint32 multiplication overflow.
  int hi=int(state / 127773u), lo=int(state % 127773u);
  int next=16807*lo-2836*hi;
  state=uint(next>0 ? next : next+2147483647);
  return state;
}
float collisionRange(inout uint state,float low,float high) {
  return (float(collisionRandom(state))*4.656612875e-10)*(high-low)+low;
}
bool blocksParticle(vec2 position) {
  ivec2 cell=ivec2(position)+ivec2(collisionOrigin);
  if(any(lessThan(cell,ivec2(0)))||any(greaterThanEqual(cell,collisionSize))) return false;
  uint kind=texelFetch(collisionCells,cell,0).r;
  return kind==1u||kind==3u;
}
void collideParticle(vec2 previous,inout vec2 position,inout vec2 velocity,inout float life,
                     inout vec4 contact,bool liquid) {
  if(!collisionEnabled) return;
  vec2 movement=position-contact.xy;
  float distance=length(movement);
  int steps=min(int(distance+0.5),60);
  if(steps==0) return;
  vec2 direction=distance>0. ? movement/distance : vec2(0);
  vec2 samplePosition=previous, lastPosition=previous;
  uint high=uint(contact.w), state=uint(contact.z)|((high&32767u)<<16);
  bool bounce=(high&32768u)!=0u;
  for(int i=0;i<60;i++) {
    if(i>=steps) break;
    samplePosition+=direction;
    if(i>0&&all(equal(ivec2(samplePosition),ivec2(lastPosition)))) continue;
    if(blocksParticle(samplePosition)) {
      position=lastPosition;
      if(!bounce||liquid) { life=-1.; return; }
      if(abs(direction.x)<=abs(direction.y)) velocity.y=-velocity.y;
      else velocity.x=-velocity.x;
      if(abs(velocity.x)<10.) velocity.x+=collisionRange(state,-10.,10.);
      velocity*=collisionRange(state,0.1,0.3);
      float speedSquared=dot(velocity,velocity);
      if(life>1.&&speedSquared<1600.) life=collisionRange(state,0.5,1.5);
      if(speedSquared<100.) bounce=false;
      contact.z=float(state&65535u);
      contact.w=float((state>>16)|(bounce?32768u:0u));
      return;
    }
    lastPosition=samplePosition;
    contact.xy=vec2(ivec2(samplePosition));
  }
}
`;
