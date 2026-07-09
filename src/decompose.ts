import type { Dcel, DecomposeOptions, DecompositionResult, Point, Polygon } from "./types.js";
import { rotatePoint, signedArea } from "./geometry.js";
import { buildDcel } from "./dcel.js";
import { StatusTree, type StatusNode } from "./status.js";

/**
 * An active boundary edge. It bounds exactly one cell: when `role` is `FLOOR`
 * the interior (its cell) lies above the edge, when `CEIL` the interior lies
 * below it. `ai`/`bi` are the lexicographically ordered endpoint indices, so an
 * edge "ends" (on the right of the sweep) at vertex `bi`.
 */
interface Edge extends StatusNode {
  cell: Cell;
  role: typeof FLOOR | typeof CEIL;
}

/** A cell currently being traced by the sweep. */
interface Cell {
  uid: number;
  floor: Edge;
  ceil: Edge;
  /** Points along the floor, ordered left-to-right (increasing sweep coord). */
  floorPts: Point[];
  /** Points along the ceiling, ordered left-to-right. */
  ceilPts: Point[];
}

const FLOOR = 0;
const CEIL = 1;

/**
 * A directed adjacency between two cells, tagged with the y-interval `[lo, hi]`
 * (rotated frame, at the shared cut's x) over which they actually touch. The
 * interval lets us contract dropped pass-through cells correctly: two surviving
 * cells are adjacent only if their seam intervals overlap along the whole path.
 */
type AdjPair = [from: number, to: number, lo: number, hi: number];

/**
 * Tolerances, all relative to `span` (the diagonal of the input's bounding
 * box), so behaviour is independent of the units and magnitude of the input.
 */
/** Faces whose absolute area is at most `span² · AREA_EPS_REL` are discarded as slivers. */
const AREA_EPS_REL = 1e-12;
/** Shared seams shorter than `span · SEAM_EPS_REL` are treated as a touch, not an edge. */
const SEAM_EPS_REL = 1e-9;
/** Quantum used when merging coincident vertices, as a fraction of `span`. */
const QUANTUM_REL = 1e-9;

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
  const N = vx.length;

  // Lexicographic order (x, then y). This implicitly tilts the sweep line by an
  // infinitesimal amount, removing the ambiguity of perfectly vertical edges.
  const lexLess = (i: number, j: number): boolean =>
    vx[i] < vx[j] || (vx[i] === vx[j] && vy[i] < vy[j]);

  const point = (i: number): Point => ({ x: vx[i], y: vy[i] });

  // Create an active edge between vertices i and j (cell assigned by makeCell).
  const newEdge = (i: number, j: number, role: typeof FLOOR | typeof CEIL): Edge => {
    const left = lexLess(i, j) ? i : j;
    const right = lexLess(i, j) ? j : i;
    return {
      ai: left,
      bi: right,
      // Assigned immediately by makeCell / the caller before use.
      cell: null as unknown as Cell,
      role,
      left: null,
      right: null,
      parent: null,
      height: 1,
    };
  };

  const makeCell = (
    uid: number,
    floor: Edge,
    ceil: Edge,
    floorPts: Point[],
    ceilPts: Point[],
  ): Cell => {
    const cell: Cell = { uid, floor, ceil, floorPts, ceilPts };
    floor.cell = cell;
    ceil.cell = cell;
    return cell;
  };

  const order = Array.from({ length: N }, (_, i) => i).sort((i, j) =>
    lexLess(i, j) ? -1 : lexLess(j, i) ? 1 : 0,
  );

  const status = new StatusTree<Edge>(vx, vy);
  // Active edges indexed by the vertex they end at (their right endpoint).
  const endsAt: Edge[][] = Array.from({ length: N }, () => []);
  const rawFaces: Array<{ uid: number; pts: Point[] }> = [];
  // Directed left-cell -> right-cell uid pairs, each tagged with the y-interval
  // (in the rotated frame, at the shared cut's x) over which the two cells touch.
  const adjPairs: Array<AdjPair> = [];
  let uid = 0;

  const addEdge = (e: Edge): void => {
    status.insert(e);
    endsAt[e.bi].push(e);
  };
  const closeCell = (c: Cell): void => {
    rawFaces.push({ uid: c.uid, pts: c.floorPts.concat([...c.ceilPts].reverse()) });
  };

  for (const v of order) {
    status.sweepX = vx[v];
    const p = prev[v];
    const n = next[v];
    const pLeft = lexLess(p, v);
    const nLeft = lexLess(n, v);

    // Turn direction at v (interior on the left): >0 convex, <0 reflex.
    const turn =
      (vx[v] - vx[p]) * (vy[n] - vy[v]) - (vy[v] - vy[p]) * (vx[n] - vx[v]);

    if (!pLeft && !nLeft) {
      // Both neighbours to the right: START (convex) or SPLIT (reflex).
      // Decide which outgoing edge is the upper one via the cross product.
      const dpx = vx[p] - vx[v];
      const dpy = vy[p] - vy[v];
      const dnx = vx[n] - vx[v];
      const dny = vy[n] - vy[v];
      const upperIsNext = dpx * dny - dpy * dnx > 0;
      const upper = upperIsNext ? n : p;
      const lower = upperIsNext ? p : n;

      if (turn > 0) {
        // START: a fresh cell begins at this left tip.
        const floor = newEdge(v, lower, FLOOR);
        const ceil = newEdge(v, upper, CEIL);
        makeCell(uid++, floor, ceil, [point(v)], [point(v)]);
        addEdge(floor);
        addEdge(ceil);
      } else {
        // SPLIT: cut the cell containing v into a lower and an upper cell.
        const x = vx[v];
        const below = status.floorBelow(vy[v]);
        if (!below || below.role !== FLOOR) {
          // Numerically detached: open a fresh cell so we never crash.
          const floor = newEdge(v, lower, FLOOR);
          const ceil = newEdge(v, upper, CEIL);
          makeCell(uid++, floor, ceil, [point(v)], [point(v)]);
          addEdge(floor);
          addEdge(ceil);
          continue;
        }
        const c = below.cell;
        const yf = status.yOf(c.floor);
        const yc = status.yOf(c.ceil);
        c.floorPts.push({ x, y: yf });
        c.ceilPts.push({ x, y: yc });
        closeCell(c);

        // c.floor continues as the floor of the lower cell; c.ceil as the
        // ceiling of the upper cell. Both stay in the tree, re-homed below.
        const lowCeil = newEdge(v, lower, CEIL);
        const highFloor = newEdge(v, upper, FLOOR);
        const low = makeCell(uid++, c.floor, lowCeil, [{ x, y: yf }], [point(v)]);
        const high = makeCell(uid++, highFloor, c.ceil, [point(v)], [{ x, y: yc }]);
        addEdge(lowCeil);
        addEdge(highFloor);
        // c spans [yf, yc]; the split point vy[v] divides it: the lower cell
        // shares [yf, vy[v]] with c, the upper cell shares [vy[v], yc].
        adjPairs.push([c.uid, low.uid, yf, vy[v]], [c.uid, high.uid, vy[v], yc]);
      }
    } else if (pLeft && nLeft) {
      // Both neighbours to the left: END (convex) or MERGE (reflex).
      const ends = endsAt[v];
      if (turn > 0) {
        // END: the cell whose floor and ceiling both terminate at v closes.
        if (ends.length === 2) {
          const c = ends[0].cell;
          c.floorPts.push(point(v));
          c.ceilPts.push(point(v));
          closeCell(c);
          status.remove(ends[0]);
          status.remove(ends[1]);
        }
      } else if (ends.length === 2) {
        // MERGE: a lower and an upper cell fuse into one.
        const ceilEnding = ends[0].role === CEIL ? ends[0] : ends[1]; // lower cell's ceil
        const floorEnding = ends[0].role === FLOOR ? ends[0] : ends[1]; // upper cell's floor
        const low = ceilEnding.cell;
        const high = floorEnding.cell;
        if (low !== high) {
          const x = vx[v];
          const yf = status.yOf(low.floor);
          const yc = status.yOf(high.ceil);
          low.ceilPts.push(point(v));
          low.floorPts.push({ x, y: yf });
          closeCell(low);
          high.floorPts.push(point(v));
          high.ceilPts.push({ x, y: yc });
          closeCell(high);
          status.remove(ceilEnding);
          status.remove(floorEnding);
          // low.floor and high.ceil stay in the tree, now bounding the merge.
          const merged = makeCell(uid++, low.floor, high.ceil, [{ x, y: yf }], [{ x, y: yc }]);
          // merged spans [yf, yc]; the merge point vy[v] divides it: the lower
          // cell shares [yf, vy[v]] with merged, the upper cell [vy[v], yc].
          adjPairs.push([low.uid, merged.uid, yf, vy[v]], [high.uid, merged.uid, vy[v], yc]);
        }
      }
    } else {
      // REGULAR: the boundary bends; one cell's floor or ceiling continues.
      const e = endsAt[v][0];
      if (e) {
        const right = pLeft ? n : p;
        const cont = newEdge(v, right, e.role);
        cont.cell = e.cell;
        if (e.role === FLOOR) {
          e.cell.floorPts.push(point(v));
          e.cell.floor = cont;
        } else {
          e.cell.ceilPts.push(point(v));
          e.cell.ceil = cont;
        }
        status.remove(e);
        addEdge(cont);
      }
    }
  }

  return assemble(rawFaces, adjPairs, cosB, sinB, cx, cy, span, options?.dcel === true);
}

/** Strip consecutive duplicate points and a repeated closing point from a ring. */
function stripDuplicatePoints(ring: Point[]): Point[] {
  const out: Point[] = [];
  for (const p of ring) {
    const last = out[out.length - 1];
    if (last && last.x === p.x && last.y === p.y) continue;
    out.push(p);
  }
  while (out.length > 1) {
    const a = out[0];
    const b = out[out.length - 1];
    if (a.x === b.x && a.y === b.y) out.pop();
    else break;
  }
  return out;
}

/** Remove consecutive duplicate points and any closing duplicate. */
function dedupRing(pts: Point[], round: (v: number) => number): Point[] {
  const out: Point[] = [];
  for (const p of pts) {
    const last = out[out.length - 1];
    if (last && round(last.x) === round(p.x) && round(last.y) === round(p.y)) continue;
    out.push(p);
  }
  while (out.length > 1) {
    const a = out[0];
    const b = out[out.length - 1];
    if (round(a.x) === round(b.x) && round(a.y) === round(b.y)) out.pop();
    else break;
  }
  return out;
}

/**
 * Turn raw traced cells into the public result: filter slivers, rotate back to
 * the original frame, de-duplicate vertices, and resolve the adjacency graph.
 */
function assemble(
  rawFaces: Array<{ uid: number; pts: Point[] }>,
  adjPairs: Array<AdjPair>,
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

  // Build the adjacency graph. `adjPairs` are directed left-cell -> right-cell
  // (the left cell is always created first, so its uid is smaller), each tagged
  // with the y-interval over which the two cells share a vertical cut. When
  // several critical points share a sweep position, a cell can be born and
  // consumed at the same x, producing a zero-area "pass-through" cell that the
  // area filter drops. We must not lose the connections that ran through it, so
  // dropped cells are contracted: each surviving cell links to the surviving
  // cells reachable by walking forward through dropped cells only. Crucially the
  // seam intervals are intersected along the path — a dropped cell is a vertical
  // seam, and two cells on either side touch only where their seams overlap, so
  // an upstream/downstream pair is linked iff that overlap has positive length.
  const outEdges = new Map<number, AdjPair[]>();
  for (const pair of adjPairs) {
    const list = outEdges.get(pair[0]);
    if (list) list.push(pair);
    else outEdges.set(pair[0], [pair]);
  }
  const alive = (uid: number): boolean => uidToFace.has(uid);

  const adjacency: number[][] = faceRings.map(() => []);
  const edges: Array<[number, number]> = [];
  const seen = new Set<string>();
  const link = (fa: number, fb: number): void => {
    if (fa === fb) return;
    const lo = Math.min(fa, fb);
    const hi = Math.max(fa, fb);
    const key = `${lo}_${hi}`;
    if (seen.has(key)) return;
    seen.add(key);
    edges.push([lo, hi]);
    adjacency[fa].push(fb);
    adjacency[fb].push(fa);
  };

  for (const [uid, face] of uidToFace) {
    // Each stack frame carries the cell to visit and the seam interval reaching
    // it from `face` (intersected across every dropped cell already traversed).
    const stack: Array<[number, number, number]> = (outEdges.get(uid) ?? []).map(
      (p) => [p[1], p[2], p[3]],
    );
    const visited = new Set<string>();
    while (stack.length) {
      const [w, lo, hi] = stack.pop() as [number, number, number];
      if (hi - lo <= seamEps) continue; // seam pinched to nothing along this path
      const key = `${w}|${round(lo)}|${round(hi)}`;
      if (visited.has(key)) continue;
      visited.add(key);
      if (alive(w)) {
        link(face, uidToFace.get(w) as number);
      } else {
        for (const p of outEdges.get(w) ?? []) {
          stack.push([p[1], Math.max(lo, p[2]), Math.min(hi, p[3])]);
        }
      }
    }
  }
  for (const list of adjacency) list.sort((x, y) => x - y);

  let dcel: Dcel | undefined;
  if (withDcel) {
    const built = buildDcel(faces, rpx, rpy, quantum);
    faces = built.loops;
    dcel = built.dcel;
  }

  const result: DecompositionResult = { vertices, faces, graph: { adjacency, edges } };
  if (dcel) result.dcel = dcel;
  return result;
}
