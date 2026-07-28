/** A 2D point. */
export interface Point {
  x: number;
  y: number;
}

/**
 * A polygon described by an outer boundary ring and zero or more holes.
 *
 * Rings are arrays of points. They may be given in any winding order — the
 * library re-orients them internally (outer counter-clockwise, holes clockwise)
 * before decomposing. Rings should not repeat their first point at the end.
 */
export interface Polygon {
  /** Outer boundary ring (at least 3 points). */
  outer: Point[];
  /** Optional holes, each an inner ring (at least 3 points). */
  holes?: Point[][];
}

/**
 * Connectivity graph over the decomposed faces (a Reeb-like adjacency graph).
 *
 * Two faces are adjacent when they share a vertical cut produced at a critical
 * point of the sweep (a split or merge event).
 */
export interface FaceGraph {
  /**
   * Adjacency list: `adjacency[i]` is the sorted list of face indices that are
   * adjacent to face `i`.
   */
  adjacency: number[][];
  /**
   * Undirected adjacency edges as `[i, j]` pairs with `i < j`. Each adjacency
   * appears exactly once.
   */
  edges: Array<[number, number]>;
}

/**
 * A half-edge of the {@link Dcel}. Every undirected edge of the decomposition
 * is represented by two directed twins; a half-edge has its face on the left.
 */
export interface HalfEdge {
  /** Index (into {@link DecompositionResult.vertices}) of the vertex this half-edge leaves. */
  origin: number;
  /** Index of the oppositely directed half-edge over the same undirected edge. */
  twin: number;
  /** Index of the next half-edge around the same face (counter-clockwise for interior faces). */
  next: number;
  /** Index of the previous half-edge around the same face. */
  prev: number;
  /** Index into {@link DecompositionResult.faces}, or `-1` for the unbounded face. */
  face: number;
}

/**
 * A doubly connected edge list over the decomposition. Faces, vertices and
 * half-edges cross-reference each other by index, so the whole planar
 * subdivision (including the unbounded face) can be traversed topologically.
 */
export interface Dcel {
  /** All half-edges. Twins are `halfEdges[h].twin`; boundary half-edges have `face === -1`. */
  halfEdges: HalfEdge[];
  /** For each face `i`, one half-edge on its counter-clockwise outer boundary cycle. */
  faceEdge: number[];
  /**
   * For each face, one half-edge per *inner* boundary cycle, clockwise. Only
   * present when some face has one — that is, for a {@link decomposeRadial}
   * result containing an annular cell. Faces without inner cycles have `[]`.
   */
  faceInnerEdges?: number[][];
  /** For each vertex, one half-edge leaving it (`-1` if the vertex is unused). */
  vertexEdge: number[];
  /**
   * One half-edge per boundary cycle of the unbounded face: the outer boundary
   * plus one cycle per hole.
   */
  boundaryCycles: number[];
}

/**
 * A cell of a {@link decomposeRadial} decomposition.
 *
 * Most cells are a single loop, exactly like a linear decomposition's face.
 * A cell that wraps the whole way around the sweep centre is an annulus, and
 * an annulus needs two boundary circles — hence the optional inner loops.
 */
export interface RadialFace {
  /** Outer boundary loop, counter-clockwise, indices into the vertex list. */
  ring: number[];
  /**
   * Inner boundary loops, clockwise. Present only for annular cells (a band
   * that encircles the centre); absent for every other cell.
   */
  holes?: number[][];
}

/**
 * A circular boundary edge of a radial cell, centred on the sweep centre.
 *
 * Radial cuts are arcs, not straight lines, so the loops in {@link RadialFace}
 * are exact only if you know which of their edges bulge. Each arc names the
 * loop edge it replaces: the edge leaving position {@link RadialArc.index} of
 * the loop. Every other loop edge is an ordinary straight segment.
 */
export interface RadialArc {
  /** Index into {@link RadialDecompositionResult.faces}. */
  face: number;
  /** `-1` for that face's outer `ring`, otherwise the index into its `holes`. */
  hole: number;
  /** Position within the loop of the vertex the arc leaves. */
  index: number;
  /**
   * How many consecutive loop edges the arc spans, starting at
   * {@link RadialArc.index} and wrapping. Normally `1`; larger when the arc has
   * been tessellated into the loop (which `dcel: true` does), in which case the
   * intervening vertices lie exactly on the arc.
   */
  count: number;
  /** Distance from the sweep centre (constant along the arc). */
  radius: number;
  /** Angle of the arc's start vertex, radians CCW from `+x`, in `(-π, π]`. */
  startAngle: number;
  /**
   * Signed angle swept from `startAngle` to the arc's end, counter-clockwise
   * positive. A point at parameter `t ∈ [0, 1]` sits at
   * `startAngle + t · sweep`. `±2π` for a full circle, in which case the arc
   * starts and ends at the same vertex and its loop has length 1.
   */
  sweep: number;
}

/** Options for {@link decomposeRadial}. */
export interface RadialOptions {
  /**
   * Build a {@link Dcel} over the decomposition. Arcs are tessellated first
   * (see {@link RadialOptions.arcTolerance}) so that every face loop is an
   * ordinary polygon; the arc metadata still describes the exact circles.
   */
  dcel?: boolean;
  /**
   * Direction of the ray along which the polar frame is cut, radians CCW from
   * `+x`. Defaults to a ray that misses the polygon entirely when one exists,
   * otherwise the middle of the widest gap between the angles of the vertices
   * and of the edges' closest approaches.
   *
   * The sweep steps across the cut, so this does **not** affect the
   * decomposition — same cells, same graph, same areas whatever it is set to.
   * It is exposed for reproducibility, and reported back as
   * {@link RadialDecompositionResult.branchAngle}. A value landing on a vertex
   * or a tangency is nudged aside, since those cannot be cut through.
   */
  branchAngle?: number;
  /**
   * Maximum distance between an arc and the polyline standing in for it when
   * {@link RadialOptions.dcel} tessellates the loops. Defaults to `1/1000` of
   * the scale — the larger of the bounding-box diagonal and the distance from
   * the centre to the farthest vertex. Ignored without `dcel`, since arcs are
   * otherwise reported exactly.
   */
  arcTolerance?: number;
}

/** Result of {@link decomposeRadial}. */
export interface RadialDecompositionResult {
  /** The sweep centre the decomposition was computed about. */
  center: Point;
  /** The branch angle actually used (see {@link RadialOptions.branchAngle}). */
  branchAngle: number;
  /** Unique vertices referenced by the faces, in the original coordinate frame. */
  vertices: Point[];
  /** Cells of the decomposition, each an outer loop plus optional inner loops. */
  faces: RadialFace[];
  /** The circular edges of those loops; every unlisted loop edge is straight. */
  arcs: RadialArc[];
  /** Connectivity graph describing which cells are adjacent. */
  graph: FaceGraph;
  /** Doubly connected edge list; present when requested via {@link RadialOptions.dcel}. */
  dcel?: Dcel;
}

/** Options for {@link decompose}. */
export interface DecomposeOptions {
  /**
   * Build a {@link Dcel} over the decomposition. This normalises the face
   * loops first: wherever a face's edge passes through another face's vertex
   * (a T-junction on a shared cut), that vertex is inserted into the loop, so
   * with this option faces may contain collinear vertices along shared seams.
   */
  dcel?: boolean;
}

/** Result of {@link decompose}. */
export interface DecompositionResult {
  /** Unique vertices referenced by the faces, in the original coordinate frame. */
  vertices: Point[];
  /**
   * Faces of the decomposition. Each face is an ordered, counter-clockwise list
   * of indices into {@link DecompositionResult.vertices}.
   */
  faces: number[][];
  /** Connectivity graph describing which faces are adjacent. */
  graph: FaceGraph;
  /** Doubly connected edge list; present when requested via {@link DecomposeOptions.dcel}. */
  dcel?: Dcel;
}
