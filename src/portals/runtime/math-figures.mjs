// Original particle constructions, deliberately separate from the Noita catalog.
// The impossible forms are 2D optical projections, not claims of realizable solids.
const TAU = Math.PI * 2;
export const MATH_GROUPS = Object.freeze({
  illusions: "Impossible / ambiguous projections",
  polyhedra: "Polyhedra & 4D",
  knots: "Knots & links",
  surfaces: "Surfaces",
  curves: "Curves",
  fractals: "Fractals",
});
export const MATH_EFFECTS = Object.freeze({
  math_penrose: {
    label: "Penrose triangle",
    group: "illusions",
    description:
      "A cyclic three-beam optical illusion, traced in purple sparks.",
  },
  math_blivet: {
    label: "Impossible trident",
    group: "illusions",
    description:
      "A blivet-style line drawing: three round ends merge into two incompatible flat-sided branches.",
  },
  math_necker: {
    label: "Necker cube",
    group: "illusions",
    description:
      "An ambiguous wireframe cube: either face can appear to be in front.",
  },
  math_tesseract: {
    label: "Rotating tesseract",
    group: "polyhedra",
    description:
      "A 4D hypercube rotated in XW and YZ, projected into three dimensions.",
  },
  math_trefoil: {
    label: "Trefoil knot",
    group: "knots",
    description: "The closed (2,3) torus knot, slowly turning in space.",
  },
  math_hopf: {
    label: "Hopf link",
    group: "knots",
    description: "Two linked circles, turning together without intersecting.",
  },
  math_mobius: {
    label: "Möbius strip",
    group: "surfaces",
    description:
      "A one-sided strip with one half-twist, drawn as a wire lattice.",
  },
  math_tetrahedron: {
    label: "Tetrahedron",
    group: "polyhedra",
    description:
      "Four triangular faces and six edges: the simplest Platonic solid.",
  },
  math_octahedron: {
    label: "Octahedron",
    group: "polyhedra",
    description: "Eight triangular faces, slowly rotating as a double pyramid.",
  },
  math_icosahedron: {
    label: "Icosahedron",
    group: "polyhedra",
    description: "A golden-ratio construction with twenty triangular faces.",
  },
  math_dodecahedron: {
    label: "Dodecahedron",
    group: "polyhedra",
    description: "Twelve pentagonal faces traced along thirty rotating edges.",
  },
  math_figure_eight: {
    label: "Figure-eight knot",
    group: "knots",
    description:
      "The four-crossing knot, a single closed curve turning in three dimensions.",
  },
  math_cinquefoil: {
    label: "Cinquefoil knot",
    group: "knots",
    description:
      "The five-crossing (2,5) torus knot, woven into one continuous loop.",
  },
  math_torus_knot: {
    label: "(3,4) torus knot",
    group: "knots",
    description:
      "A single closed strand with winding numbers (3,4), forming an eight-crossing torus knot.",
  },
  math_torus: {
    label: "Torus lattice",
    group: "surfaces",
    description:
      "A rotating doughnut surface outlined by intersecting meridians and parallels.",
  },
  math_sphere: {
    label: "Spherical lattice",
    group: "surfaces",
    description:
      "Latitude circles and pole-to-pole meridians reveal a rotating sphere.",
  },
  math_klein: {
    label: "Klein bottle",
    group: "surfaces",
    description:
      "A figure-eight immersion of the closed, one-sided surface; it must self-intersect in 3D.",
  },
  math_lissajous: {
    label: "3D Lissajous curve",
    group: "curves",
    description:
      "Three sine waves with frequencies 3:4:5 weave a spatial curve.",
  },
  math_viviani: {
    label: "Viviani’s curve",
    group: "curves",
    description:
      "A spatial figure-eight formed where a sphere meets a tangent cylinder.",
  },
  math_rose: {
    label: "Seven-petal rose",
    group: "curves",
    description:
      "The polar curve r = cos(7θ), traced through seven symmetric petals.",
  },
  math_sierpinski: {
    label: "Sierpiński triangle",
    group: "fractals",
    description:
      "Three recursive subdivisions leave twenty-seven little triangles and nested gaps.",
  },
  math_koch: {
    label: "Koch snowflake",
    group: "fractals",
    description:
      "Three rounds of equilateral bumps turn a triangle into a 192-edge snowflake.",
  },
  math_hilbert: {
    label: "Hilbert curve",
    group: "fractals",
    description:
      "An order-four approximation of the space-filling curve: one unbroken 16 × 16 path.",
  },
});
function rotate(p, t) {
  // Begin at an oblique view (not overlapping front/back faces), then turn
  // around multiple axes so rings, knots and lattices reveal their depth.
  const a = t * 0.00613 + 0.35,
    b = 0.4 + Math.sin(t * 0.002) * 0.32,
    roll = t * 0.0011,
    ca = Math.cos(a),
    sa = Math.sin(a),
    cb = Math.cos(b),
    sb = Math.sin(b),
    cr = Math.cos(roll),
    sr = Math.sin(roll);
  const x = p[0] * ca - p[2] * sa,
    z = p[2] * ca + p[0] * sa,
    y = p[1] * cb - z * sb;
  return [x * cr - y * sr, x * sr + y * cr, z * cb + p[1] * sb];
}
function projected(p, t, scale = 55) {
  const [x, y] = rotate(p, t);
  return [x * scale, y * scale];
}
function wire(vertices, edges, t, scale) {
  const v = vertices.map((p) => projected(p, t, scale));
  return edges.map(([a, b]) => [v[a], v[b]]);
}
function loop(points) {
  return points.map((p, i) => [p, points[(i + 1) % points.length]]);
}
function turnPlanar(segments, frame, tilt = 0.55) {
  // A full in-plane turn, not a near-static sway. Bound the two tilt angles so
  // planar math stays readable rather than disappearing edge-on. Impossible
  // drawings use tilt=0: rotate their projection without inventing a 3D solid.
  const roll = frame * 0.0038,
    yaw = Math.sin(frame * 0.003) * tilt,
    pitch = Math.sin(frame * 0.0021) * tilt * 0.75,
    cr = Math.cos(roll),
    sr = Math.sin(roll),
    cy = Math.cos(yaw),
    sy = Math.sin(yaw),
    cp = Math.cos(pitch),
    sp = Math.sin(pitch);
  const project = ([x, y]) => {
    const rx = x * cr - y * sr,
      ry = x * sr + y * cr,
      z = rx * sy,
      depth = z * cp + ry * sp,
      perspective = 420 / (420 - depth);
    return [rx * cy * perspective, (ry * cp - z * sp) * perspective];
  };
  return segments.map((edge) => edge.map(project));
}

// Sample the new constructions once. Only their projection changes per frame;
// stable edge indices let the same eight pens keep following each figure.
function polyline(vertices, scale, closed = true) {
  return {
    vertices,
    edges: Array.from(
      { length: vertices.length - (closed ? 0 : 1) },
      (_, i) => [i, (i + 1) % vertices.length],
    ),
    scale,
  };
}
function curve(count, point, scale, period = TAU) {
  return polyline(
    Array.from({ length: count }, (_, i) => point((period * i) / count)),
    scale,
  );
}
function solid(vertices, scale) {
  const pairs = [];
  let shortest = Infinity;
  for (let a = 0; a < vertices.length; a++)
    for (let b = a + 1; b < vertices.length; b++) {
      const distance = Math.hypot(
        ...vertices[a].map((v, i) => v - vertices[b][i]),
      );
      shortest = Math.min(shortest, distance);
      pairs.push({ edge: [a, b], distance });
    }
  return {
    vertices,
    edges: pairs
      .filter((p) => Math.abs(p.distance - shortest) < 1e-8)
      .map((p) => p.edge),
    scale,
  };
}
function cyclicVertices(a, b) {
  const vertices = [];
  for (const x of [-a, a])
    for (const y of [-b, b]) vertices.push([0, x, y], [x, y, 0], [y, 0, x]);
  return vertices;
}
function torusKnot(p, q, count) {
  return curve(
    count,
    (t) => {
      const r = 2 + 0.7 * Math.cos(q * t);
      return [r * Math.cos(p * t), r * Math.sin(p * t), 0.7 * Math.sin(q * t)];
    },
    30,
  );
}
function lattice(point, scale, { wrapV = true, twist = false } = {}) {
  const uSteps = 48,
    vSteps = 24,
    columns = wrapV ? vSteps : vSteps + 1,
    vertices = [],
    edges = [];
  for (let u = 0; u < uSteps; u++)
    for (let v = 0; v < columns; v++)
      vertices.push(point((TAU * u) / uSteps, (TAU * v) / vSteps));
  for (let u = 0; u < uSteps; u++)
    for (let v = 0; v < columns; v++) {
      const index = u * columns + v;
      // Four parallels (three on a sphere, omitting its collapsed polar rings).
      if (v % 6 === 0 && (wrapV || (v > 0 && v < vSteps))) {
        // The Klein seam reverses its transverse parameter, rather than
        // connecting the last row as an ordinary orientable torus.
        const nextV = twist && u === uSteps - 1 ? (vSteps - v) % vSteps : v;
        edges.push([index, ((u + 1) % uSteps) * columns + nextV]);
      }
      // Eight finely subdivided meridians, joined at the parallel crossings.
      if (u % 6 === 0 && (wrapV || v < vSteps))
        edges.push([index, u * columns + ((v + 1) % columns)]);
    }
  return { vertices, edges, scale, speed: 0.55 };
}
function sierpinski() {
  const vertices = [],
    edges = [],
    midpoint = (a, b) => a.map((v, i) => (v + b[i]) / 2);
  function triangle(a, b, c, depth) {
    if (!depth) {
      const i = vertices.length;
      vertices.push(a, b, c);
      edges.push([i, i + 1], [i + 1, i + 2], [i + 2, i]);
      return;
    }
    const ab = midpoint(a, b),
      bc = midpoint(b, c),
      ca = midpoint(c, a);
    triangle(a, ab, ca, depth - 1);
    triangle(ab, b, bc, depth - 1);
    triangle(ca, bc, c, depth - 1);
  }
  triangle([0, -1], [Math.sqrt(3) / 2, 0.5], [-Math.sqrt(3) / 2, 0.5], 3);
  return { vertices, edges, scale: 90, planar: true };
}
function koch() {
  let points = [
    [0, -1],
    [Math.sqrt(3) / 2, 0.5],
    [-Math.sqrt(3) / 2, 0.5],
  ];
  for (let depth = 0; depth < 3; depth++) {
    const next = [];
    for (const [a, b] of loop(points)) {
      const dx = (b[0] - a[0]) / 3,
        dy = (b[1] - a[1]) / 3;
      next.push(
        a,
        [a[0] + dx, a[1] + dy],
        [
          a[0] + 1.5 * dx + (Math.sqrt(3) * dy) / 2,
          a[1] + 1.5 * dy - (Math.sqrt(3) * dx) / 2,
        ],
        [a[0] + 2 * dx, a[1] + 2 * dy],
      );
    }
    points = next;
  }
  return { ...polyline(points, 88), planar: true };
}
function hilbert() {
  const size = 16,
    points = [];
  for (let index = 0; index < size * size; index++) {
    let x = 0,
      y = 0,
      bits = index;
    for (let side = 1; side < size; side *= 2) {
      const rx = (bits >> 1) & 1,
        ry = (bits ^ rx) & 1;
      if (!ry) {
        if (rx) {
          x = side - 1 - x;
          y = side - 1 - y;
        }
        [x, y] = [y, x];
      }
      x += side * rx;
      y += side * ry;
      bits >>= 2;
    }
    points.push([(2 * x) / (size - 1) - 1, (2 * y) / (size - 1) - 1]);
  }
  return { ...polyline(points, 76, false), planar: true };
}
const PHI = (1 + Math.sqrt(5)) / 2;
const meshes = {
  math_tetrahedron: solid(
    [
      [1, 1, 1],
      [1, -1, -1],
      [-1, 1, -1],
      [-1, -1, 1],
    ],
    50,
  ),
  math_octahedron: solid(
    [
      [1, 0, 0],
      [-1, 0, 0],
      [0, 1, 0],
      [0, -1, 0],
      [0, 0, 1],
      [0, 0, -1],
    ],
    80,
  ),
  math_icosahedron: solid(cyclicVertices(1, PHI), 46),
  math_dodecahedron: solid(
    [
      ...Array.from({ length: 8 }, (_, i) => [
        i & 1 ? 1 : -1,
        i & 2 ? 1 : -1,
        i & 4 ? 1 : -1,
      ]),
      ...cyclicVertices(1 / PHI, PHI),
    ],
    49,
  ),
  math_figure_eight: curve(
    192,
    (t) => {
      const r = 2 + Math.cos(2 * t);
      return [r * Math.cos(3 * t), r * Math.sin(3 * t), Math.sin(4 * t)];
    },
    27,
  ),
  math_cinquefoil: torusKnot(2, 5, 160),
  math_torus_knot: torusKnot(3, 4, 192),
  math_torus: lattice((u, v) => {
    const r = 1.1 + 0.36 * Math.cos(v);
    return [r * Math.cos(u), r * Math.sin(u), 0.36 * Math.sin(v)];
  }, 61),
  math_sphere: lattice(
    (u, v) => [
      Math.sin(v / 2) * Math.cos(u),
      Math.sin(v / 2) * Math.sin(u),
      Math.cos(v / 2),
    ],
    86,
    { wrapV: false },
  ),
  math_klein: lattice(
    (u, v) => {
      const c = Math.cos(u / 2),
        s = Math.sin(u / 2),
        r = 2.3 + c * Math.sin(v) - s * Math.sin(2 * v);
      return [
        r * Math.cos(u),
        r * Math.sin(u),
        s * Math.sin(v) + c * Math.sin(2 * v),
      ];
    },
    24,
    { twist: true },
  ),
  math_lissajous: curve(
    240,
    (t) => [Math.sin(3 * t + 0.35), Math.sin(4 * t), Math.sin(5 * t + 0.9)],
    55,
  ),
  math_viviani: curve(
    160,
    (t) => [Math.cos(2 * t), Math.sin(2 * t), 2 * Math.sin(t)],
    39,
  ),
  // For an odd-petal rose, [0, π) traces the curve exactly once, not twice.
  math_rose: {
    ...curve(
      168,
      (t) => [Math.cos(7 * t) * Math.cos(t), Math.cos(7 * t) * Math.sin(t)],
      85,
      Math.PI,
    ),
    planar: true,
  },
  math_sierpinski: sierpinski(),
  math_koch: koch(),
  math_hilbert: hilbert(),
};

export function figureSegments(key, frame) {
  if (key === "math_penrose") {
    // Three nested cycles with cyclic corner joins; only rotate the 2D illusion.
    const outer = [
        [0, -83],
        [84, 62],
        [-84, 62],
      ],
      inner = [
        [0, -31],
        [38, 35],
        [-38, 35],
      ];
    const middle = [
      [0, -64],
      [68, 53],
      [-68, 53],
    ];
    const segments = [...loop(outer), ...loop(inner)];
    for (let i = 0; i < 3; i++) {
      const j = (i + 1) % 3;
      segments.push(
        [outer[i], middle[i]],
        [middle[i], inner[j]],
        [middle[i], middle[j]],
      );
    }
    return turnPlanar(segments, frame, 0);
  }
  if (key === "math_blivet") {
    const edges = [];
    for (const cy of [-40, 0, 40]) {
      const ring = Array.from({ length: 28 }, (_, i) => {
        const a = (TAU * i) / 28;
        return [-68 + 8 * Math.cos(a), cy + 12 * Math.sin(a)];
      });
      edges.push(...loop(ring));
    }
    // Deliberately incompatible 2D edge continuations, not a hidden 3D mesh.
    edges.push(
      [
        [-68, -52],
        [62, -22],
      ],
      [
        [-68, -28],
        [62, 2],
      ],
      [
        [-68, -12],
        [36, 12],
      ],
      [
        [-68, 12],
        [62, 42],
      ],
      [
        [-68, 28],
        [36, 52],
      ],
      [
        [-68, 52],
        [62, 82],
      ],
      [
        [62, -22],
        [80, -12],
      ],
      [
        [80, -12],
        [80, 52],
      ],
      [
        [80, 52],
        [62, 42],
      ],
      [
        [62, 42],
        [62, -22],
      ],
      [
        [36, 12],
        [54, 22],
      ],
      [
        [54, 22],
        [54, 72],
      ],
      [
        [54, 72],
        [36, 62],
      ],
      [
        [36, 62],
        [36, 12],
      ],
      [
        [54, 72],
        [62, 82],
      ],
      [
        [62, 82],
        [80, 72],
      ],
      [
        [80, 72],
        [80, 52],
      ],
    );
    return turnPlanar(
      edges.map((e) => e.map(([x, y]) => [x, y - 14])),
      frame,
      0,
    );
  }
  if (key === "math_necker") {
    const vertices = Array.from({ length: 8 }, (_, i) => [
      i & 1 ? 1 : -1,
      i & 2 ? 1 : -1,
      i & 4 ? 1 : -1,
    ]);
    const edges = [];
    for (let i = 0; i < 8; i++)
      for (let d = 0; d < 3; d++)
        if (!(i & (1 << d))) edges.push([i, i ^ (1 << d)]);
    return wire(vertices, edges, frame * 0.65 + 95, 45);
  }
  if (key === "math_tesseract") {
    const a = frame * 0.005,
      c = Math.cos(a),
      s = Math.sin(a),
      b = frame * 0.0031,
      cb = Math.cos(b),
      sb = Math.sin(b);
    const vertices = Array.from({ length: 16 }, (_, i) => {
      const x = i & 1 ? 1 : -1,
        y = i & 2 ? 1 : -1,
        z = i & 4 ? 1 : -1,
        w = i & 8 ? 1 : -1;
      const xx = x * c - w * s,
        ww = w * c + x * s,
        yy = y * cb - z * sb,
        zz = z * cb + y * sb,
        projection = 2.5 / (3.5 - ww);
      return [xx * projection, yy * projection, zz * projection];
    });
    const edges = [];
    for (let i = 0; i < 16; i++)
      for (let d = 0; d < 4; d++)
        if (!(i & (1 << d))) edges.push([i, i ^ (1 << d)]);
    return wire(vertices, edges, frame * 0.45, 37);
  }
  if (key === "math_trefoil") {
    const points = Array.from({ length: 120 }, (_, i) => {
      const t = (TAU * i) / 120,
        r = 2 + Math.cos(3 * t);
      return projected(
        [r * Math.cos(2 * t), r * Math.sin(2 * t), Math.sin(3 * t)],
        frame,
        27,
      );
    });
    return loop(points);
  }
  if (key === "math_hopf") {
    const a = [],
      b = [];
    for (let i = 0; i < 80; i++) {
      const t = (TAU * i) / 80;
      a.push(projected([Math.cos(t) - 0.5, Math.sin(t), 0], frame, 52));
      b.push(projected([Math.cos(t) + 0.5, 0, Math.sin(t)], frame, 52));
    }
    return [...loop(a), ...loop(b)];
  }
  if (key === "math_mobius") {
    const point = (u, v) =>
      projected(
        [
          (1 + v * Math.cos(u / 2)) * Math.cos(u),
          (1 + v * Math.cos(u / 2)) * Math.sin(u),
          v * Math.sin(u / 2),
        ],
        frame,
        64,
      );
    const edges = [];
    for (let i = 0; i < 72; i++)
      for (const v of [-0.35, 0, 0.35])
        edges.push([point((TAU * i) / 72, v), point((TAU * (i + 1)) / 72, v)]);
    for (let i = 0; i < 24; i++)
      edges.push([point((TAU * i) / 24, -0.35), point((TAU * i) / 24, 0.35)]);
    return edges;
  }
  if (Object.hasOwn(meshes, key)) {
    const mesh = meshes[key];
    if (mesh.planar) {
      const points = mesh.vertices.map(([x, y]) => [
        x * mesh.scale,
        y * mesh.scale,
      ]);
      return turnPlanar(
        mesh.edges.map(([a, b]) => [points[a], points[b]]),
        frame,
      );
    }
    return wire(
      mesh.vertices,
      mesh.edges,
      frame * (mesh.speed ?? 0.65) - 40,
      mesh.scale,
    );
  }
  throw new RangeError(`Unknown mathematical figure: ${key}`);
}
