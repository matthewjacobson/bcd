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
}
