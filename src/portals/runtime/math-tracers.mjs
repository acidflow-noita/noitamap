// Original path scheduler, not a recovered Noita system. Particle birth/update
// stays in PortalSimulation.emitTrail, with math-only extended lifetimes.
import { NoitaRandom } from "./portal-physics.mjs";
import { figureSegments } from "./math-figures.mjs";

export const MATH_TRACING = Object.freeze({
  emitters: 8,
  minTravel: 24,
  maxTravel: 40,
});
const topologyCache = new Map();
const EPSILON = 1e-7;

function topologyFor(effect) {
  let topology = topologyCache.get(effect);
  if (topology) return topology;
  // Segment indices are stable across the authored animations. Two distinct
  // projections distinguish shared vertices from accidental 2D crossings (e.g.
  // front/back tesseract vertices coincide in its initial projection).
  const a = figureSegments(effect, 137),
    b = figureSegments(effect, 311);
  const nodes = new Map(),
    ends = [],
    incident = [];
  for (let edge = 0; edge < a.length; edge++) {
    ends.push([0, 0]);
    for (let end = 0; end < 2; end++) {
      const key = [...a[edge][end], ...b[edge][end]]
        .map((v) => Math.round(v * 1e6))
        .join(",");
      let node = nodes.get(key);
      if (node === undefined) {
        node = nodes.size;
        nodes.set(key, node);
        incident.push([]);
      }
      ends[edge][end] = node;
      incident[node].push({ edge, end });
    }
  }
  const seen = new Set(),
    components = [];
  for (let edge = 0; edge < ends.length; edge++) {
    if (seen.has(edge)) continue;
    const component = [],
      queue = [edge];
    seen.add(edge);
    while (queue.length) {
      const current = queue.pop();
      component.push(current);
      for (const node of ends[current])
        for (const neighbor of incident[node]) {
          if (!seen.has(neighbor.edge)) {
            seen.add(neighbor.edge);
            queue.push(neighbor.edge);
          }
        }
    }
    component.sort((x, y) => x - y);
    components.push(component);
  }
  topology = { ends, incident, components };
  topologyCache.set(effect, topology);
  return topology;
}

function length(segment) {
  return Math.hypot(
    segment[1][0] - segment[0][0],
    segment[1][1] - segment[0][1],
  );
}
function point(segment, t) {
  return [
    segment[0][0] + (segment[1][0] - segment[0][0]) * t,
    segment[0][1] + (segment[1][1] - segment[0][1]) * t,
  ];
}

export class FigureTracers {
  constructor(effect, segments, worldSeed, startFrame) {
    this.topology = topologyFor(effect);
    this.random = new NoitaRandom().seed(startFrame, 1, worldSeed);
    this.visited = new Float64Array(segments.length).fill(-1);
    this.sequence = 0;
    this.tracers = [];
    const components = this.topology.components;
    if (components.length > MATH_TRACING.emitters)
      throw new Error("Figure has more disconnected paths than tracers");
    const lengths = components.map((edges) =>
      edges.reduce((sum, edge) => sum + length(segments[edge]), 0),
    );
    const assigned = components.map(() => 1);
    // Every disconnected contour gets a pen; distribute the remaining pens by
    // projected arc length rather than by the number of polyline subdivisions.
    for (let i = components.length; i < MATH_TRACING.emitters; i++) {
      let best = 0;
      for (let j = 1; j < components.length; j++)
        if (lengths[j] / assigned[j] > lengths[best] / assigned[best]) best = j;
      assigned[best]++;
    }
    for (let c = 0; c < components.length; c++)
      for (let i = 0; i < assigned[c]; i++) {
        const edges = components[c];
        let remaining = (lengths[c] * (i + 0.5)) / assigned[c],
          edge = edges[0],
          t = 0;
        for (const candidate of edges) {
          const distance = length(segments[candidate]);
          edge = candidate;
          if (remaining <= distance && distance > EPSILON) {
            t = remaining / distance;
            break;
          }
          remaining -= distance;
        }
        const direction = this.random.integer(0, 1) ? 1 : -1;
        this.tracers.push({
          edge,
          t,
          direction,
          travel: this.random.float(
            MATH_TRACING.minTravel,
            MATH_TRACING.maxTravel,
          ),
          previous: { x: 0, y: 0, cell: null },
        });
      }
  }
  nextEdge(tracer, segments) {
    const end = tracer.direction > 0 ? 1 : 0,
      node = this.topology.ends[tracer.edge][end];
    const candidates = this.topology.incident[node].filter(
      (n) => n.edge !== tracer.edge && length(segments[n.edge]) > EPSILON,
    );
    if (!candidates.length) {
      tracer.direction *= -1;
      return;
    }
    // Fairness prevents whole branches staying dark; independent random choices
    // break ties. No synchronized round-robin toggling of complete edges.
    let least = Infinity,
      choices = [];
    for (const candidate of candidates) {
      const visit = this.visited[candidate.edge];
      if (visit < least) {
        least = visit;
        choices = [candidate];
      } else if (visit === least) choices.push(candidate);
    }
    const next = choices[this.random.integer(0, choices.length - 1)];
    tracer.edge = next.edge;
    tracer.t = next.end;
    tracer.direction = next.end === 0 ? 1 : -1;
    this.visited[next.edge] = this.sequence++;
  }
  trace(segments, emit) {
    for (let id = 0; id < this.tracers.length; id++) {
      const tracer = this.tracers[id];
      let remaining = tracer.travel;
      // A projection can collapse an edge to zero length. Bound traversal and
      // reverse/skip it without tracing a made-up connector across the object.
      for (
        let hops = 0;
        remaining > EPSILON && hops < segments.length * 2 + 1;
        hops++
      ) {
        const segment = segments[tracer.edge],
          distance = length(segment);
        if (distance <= EPSILON) {
          tracer.t = tracer.direction > 0 ? 1 : 0;
          this.nextEdge(tracer, segments);
          continue;
        }
        const available =
          distance * (tracer.direction > 0 ? 1 - tracer.t : tracer.t);
        const travel = Math.min(remaining, available);
        if (travel > EPSILON) {
          const from = point(segment, tracer.t);
          tracer.t = Math.min(
            1,
            Math.max(0, tracer.t + (tracer.direction * travel) / distance),
          );
          emit(tracer, id, tracer.edge, from, point(segment, tracer.t));
          this.visited[tracer.edge] = this.sequence++;
          remaining -= travel;
        }
        if (available <= travel + EPSILON) {
          tracer.t = tracer.direction > 0 ? 1 : 0;
          this.nextEdge(tracer, segments);
        }
      }
    }
  }
}
