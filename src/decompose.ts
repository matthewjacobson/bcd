import type { Dcel, DecomposeOptions, DecompositionResult, Point, Polygon } from "./types.js";
import {
  AREA_EPS_REL,
  QUANTUM_REL,
  SEAM_EPS_REL,
  dedupRing,
  rotatePoint,
  signedArea,
  stripDuplicatePoints,
} from "./geometry.js";
import { buildDcel } from "./dcel.js";
import { buildGraph, runSweep, type AdjPair } from "./sweep.js";

/**
 * Compute the boustrophedon cellular decomposition of a polygon.
 *
 * A vertical sweep line advances in the `+x` direction *after* the polygon has
 * been rotated so that `angle` aligns with `+x`; cells are the maximal regions
 * between consecutive critical points (split/merge events) of the sweep. The
 * returned faces and graph are expressed back in the original coordinate frame.
 *
 * Runs in `O(n log n)` time for `n` vertices using a balanced sweep-line status
 * tree of active edges.
 *
 * @param polygon Outer ring plus optional holes (any winding order).
 * @param angle Sweep direction in radians, measured counter-clockwise from the
 *   `+x` axis. The decomposition slices perpendicular to this direction.
 * @param options Set `dcel: true` to also build a doubly connected edge list
 *   (this inserts T-junction vertices into the face loops, see
 *   {@link DecomposeOptions.dcel}).
 * @returns Vertices, faces (CCW vertex-index loops) and the face connectivity graph.
 */
export function decompose(
  polygon: Polygon,
  angle: number,
  options?: DecomposeOptions,
): DecompositionResult {
  if (!polygon || !Array.isArray(polygon.outer)) {
    throw new Error("decompose: polygon.outer must contain at least 3 points");
  }

  // Sanitize rings: drop consecutive duplicate points and a repeated closing
  // point. A duplicated vertex would otherwise create a zero-length edge that
  // corrupts the sweep's vertex classification.
  const outerRing = stripDuplicatePoints(polygon.outer);
  if (outerRing.length < 3) {
    throw new Error("decompose: polygon.outer must contain at least 3 distinct points");
  }
  const holeRings: Point[][] = [];
  for (const hole of polygon.holes ?? []) {
    if (!Array.isArray(hole)) continue;
    const h = stripDuplicatePoints(hole);
    if (h.length >= 3) holeRings.push(h);
  }

  // Centre the polygon on its bounding box before rotating and scale every
  // tolerance to the box diagonal, so results don't degrade for inputs far
  // from the origin and don't depend on the units used.
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const ring of [outerRing, ...holeRings]) {
    for (const p of ring) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
  }
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const span = Math.hypot(maxX - minX, maxY - minY);

  // Rotate by -angle so the sweep direction becomes +x; remember the inverse.
  const cosA = Math.cos(-angle);
  const sinA = Math.sin(-angle);
  const cosB = Math.cos(angle);
  const sinB = Math.sin(angle);
  const rot = (p: Point): Point => rotatePoint({ x: p.x - cx, y: p.y - cy }, cosA, sinA);

  // Re-orient rings so the interior lies to the left of every directed edge:
  // outer counter-clockwise, holes clockwise.
  const rings: Point[][] = [];
  const outer = outerRing.map(rot);
  if (signedArea(outer) < 0) outer.reverse();
  rings.push(outer);
  for (const hole of holeRings) {
    const h = hole.map(rot);
    if (signedArea(h) > 0) h.reverse();
    rings.push(h);
  }

  // Flatten rings into vertex arrays with prev/next linkage (global indices).
  const vx: number[] = [];
  const vy: number[] = [];
  const prev: number[] = [];
  const next: number[] = [];
  for (const ring of rings) {
    const start = vx.length;
    const n = ring.length;
    for (let k = 0; k < n; k++) {
      vx.push(ring[k].x);
      vy.push(ring[k].y);
      prev.push(start + ((k - 1 + n) % n));
      next.push(start + ((k + 1) % n));
    }
  }

  const { rawFaces, adjPairs } = runSweep({ vx, vy, prev, next });
  return assemble(rawFaces, adjPairs, cosB, sinB, cx, cy, span, options?.dcel === true);
}

/**
 * Turn raw traced cells into the public result: filter slivers, rotate back to
 * the original frame, de-duplicate vertices, and resolve the adjacency graph.
 */
function assemble(
  rawFaces: Array<{ uid: number; pts: Point[] }>,
  adjPairs: AdjPair[],
  cos: number,
  sin: number,
  cx: number,
  cy: number,
  span: number,
  withDcel: boolean,
): DecompositionResult {
  const quantum = span * QUANTUM_REL;
  const areaEps = span * span * AREA_EPS_REL;
  const seamEps = span * SEAM_EPS_REL;
  const round = (v: number): number => Math.round(v / quantum) * quantum;

  const uidToFace = new Map<number, number>();
  const faceRings: Point[][] = [];
  for (const rf of rawFaces) {
    const ring = dedupRing(rf.pts, round);
    if (ring.length < 3) continue;
    if (Math.abs(signedArea(ring)) <= areaEps) continue;
    uidToFace.set(rf.uid, faceRings.length);
    faceRings.push(ring);
  }

  const vertices: Point[] = [];
  const vmap = new Map<string, number>();
  // Rotated-frame (sweep-frame) coordinates per vertex id; internal seams are
  // vertical in this frame, which the DCEL normalisation relies on.
  const rpx: number[] = [];
  const rpy: number[] = [];
  let faces: number[][] = faceRings.map((ring) =>
    ring.map((pt) => {
      // Key on the rotated-back but still centred coordinates: their magnitude
      // is bounded by the span, so quantisation never loses precision even
      // when the input sits far from the origin.
      const orig = rotatePoint(pt, cos, sin);
      const key = `${round(orig.x)}|${round(orig.y)}`;
      let id = vmap.get(key);
      if (id === undefined) {
        id = vertices.length;
        vmap.set(key, id);
        vertices.push({ x: orig.x + cx, y: orig.y + cy });
        rpx.push(pt.x);
        rpy.push(pt.y);
      }
      return id;
    }),
  );

  const graph = buildGraph(uidToFace, adjPairs, faceRings.length, seamEps, round);

  let dcel: Dcel | undefined;
  if (withDcel) {
    const built = buildDcel(faces, rpx, rpy, quantum);
    faces = built.loops;
    dcel = built.dcel;
  }

  const result: DecompositionResult = { vertices, faces, graph };
  if (dcel) result.dcel = dcel;
  return result;
}
