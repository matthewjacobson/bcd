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
  /** For each face `i`, one half-edge on its counter-clockwise boundary cycle. */
  faceEdge: number[];
  /** For each vertex, one half-edge leaving it (`-1` if the vertex is unused). */
  vertexEdge: number[];
  /**
   * One half-edge per boundary cycle of the unbounded face: the outer boundary
   * plus one cycle per hole.
   */
  boundaryCycles: number[];
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
