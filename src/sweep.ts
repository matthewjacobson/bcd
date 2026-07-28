import type { Point } from "./types.js";
import { StatusTree, type EdgeGeometry, type StatusNode } from "./status.js";

/**
 * The boustrophedon sweep itself, independent of how the sweep frame was
 * obtained.
 *
 * A vertical line advances in the `+x` direction over a set of rings whose
 * interior lies to the left of every directed edge. Vertices are classified by
 * their two incident edges and the interior turn direction, and the maximal
 * regions between consecutive critical points are traced out as cells.
 *
 * {@link decompose} runs this on a rotated copy of the input, so `(x, y)` is a
 * rotated Cartesian frame and every edge is straight. {@link decomposeRadial}
 * runs it in polar coordinates, so `(x, y)` is `(r, θ)` and edges are the
 * curved images of Cartesian segments — hence the {@link SweepGeometry} hook.
 */

/** An active boundary edge's role: it bounds exactly one cell, from below or above. */
const FLOOR = 0;
const CEIL = 1;

/**
 * An active boundary edge. When `role` is `FLOOR` the interior (its cell) lies
 * above the edge, when `CEIL` the interior lies below it. `ai`/`bi` are the
 * lexicographically ordered endpoint indices, so an edge "ends" (on the right
 * of the sweep) at vertex `bi`.
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

/**
 * A directed adjacency between two cells, tagged with the y-interval `[lo, hi]`
 * (sweep frame, at the shared cut's x) over which they actually touch. The
 * interval lets us contract dropped pass-through cells correctly: two surviving
 * cells are adjacent only if their seam intervals overlap along the whole path.
 */
export type AdjPair = [from: number, to: number, lo: number, hi: number];

/**
 * Edge behaviour in the sweep frame. Beyond the {@link EdgeGeometry} needed by
 * the status tree, the sweep must know the direction in which a ring edge
 * leaves a vertex, to classify that vertex as convex or reflex.
 */
export interface SweepGeometry extends EdgeGeometry {
  /** Direction of the ring edge `{v, w}` at `v`, pointing toward `w`. */
  dirAt(v: number, w: number): { dx: number; dy: number };
}

/** A polygon flattened into vertex arrays with cyclic prev/next linkage. */
export interface SweepInput {
  /** Sweep coordinate (the direction the line advances in). */
  vx: number[];
  /** Cross-sweep coordinate. */
  vy: number[];
  /** Previous vertex in the ring (interior to the left of `prev -> v -> next`). */
  prev: number[];
  /** Next vertex in the ring. */
  next: number[];
  /** Curved-edge geometry; straight segments in `(x, y)` are assumed when absent. */
  geom?: SweepGeometry;
}

export interface SweepResult {
  /** Traced cells as closed point loops in the sweep frame, tagged by cell uid. */
  rawFaces: Array<{ uid: number; pts: Point[] }>;
  /** Directed left-cell -> right-cell adjacencies with their touching intervals. */
  adjPairs: AdjPair[];
}

/** Straight-segment geometry in the sweep frame — the default. */
function straightGeometry(vx: number[], vy: number[]): SweepGeometry {
  return {
    yAt(ai, bi, x) {
      const ax = vx[ai];
      const bx = vx[bi];
      if (ax === bx) return (vy[ai] + vy[bi]) / 2;
      return vy[ai] + ((vy[bi] - vy[ai]) * (x - ax)) / (bx - ax);
    },
    tangentAt(ai, bi) {
      return { dx: vx[bi] - vx[ai], dy: vy[bi] - vy[ai] };
    },
    dirAt(v, w) {
      return { dx: vx[w] - vx[v], dy: vy[w] - vy[v] };
    },
  };
}

/**
 * Sweep the given rings and trace out the boustrophedon cells.
 *
 * Runs in `O(n log n)` for `n` vertices: events are sorted once and the active
 * edges are kept in a balanced status tree, so each event does `O(log n)` work.
 */
export function runSweep(input: SweepInput): SweepResult {
  const { vx, vy, prev, next } = input;
  const geom = input.geom ?? straightGeometry(vx, vy);
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

  const status = new StatusTree<Edge>(vx, vy, geom);
  // Active edges indexed by the vertex they end at (their right endpoint).
  const endsAt: Edge[][] = Array.from({ length: N }, () => []);
  const rawFaces: Array<{ uid: number; pts: Point[] }> = [];
  const adjPairs: AdjPair[] = [];
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

    // Outgoing directions along the two incident edges, at v itself.
    const dp = geom.dirAt(v, p);
    const dn = geom.dirAt(v, n);
    // Turn direction at v (interior on the left): >0 convex, <0 reflex. The
    // incoming direction is the reverse of the outgoing one toward `prev`.
    const turn = -dp.dx * dn.dy + dp.dy * dn.dx;

    if (!pLeft && !nLeft) {
      // Both neighbours to the right: START (convex) or SPLIT (reflex).
      // Decide which outgoing edge is the upper one via the cross product.
      const upperIsNext = dp.dx * dn.dy - dp.dy * dn.dx > 0;
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

  return { rawFaces, adjPairs };
}

/**
 * Resolve cell-level adjacencies into a face-level connectivity graph.
 *
 * `adjPairs` are directed left-cell -> right-cell (the left cell is always
 * created first, so its uid is smaller), each tagged with the y-interval over
 * which the two cells share a vertical cut. When several critical points share
 * a sweep position, a cell can be born and consumed at the same x, producing a
 * zero-area "pass-through" cell that the area filter drops. We must not lose
 * the connections that ran through it, so dropped cells are contracted: each
 * surviving cell links to the surviving cells reachable by walking forward
 * through dropped cells only. Crucially the seam intervals are intersected
 * along the path — a dropped cell is a vertical seam, and two cells on either
 * side touch only where their seams overlap, so an upstream/downstream pair is
 * linked iff that overlap has positive length.
 *
 * @param uidToFace Surviving cells, mapped to their output face index.
 * @param adjPairs All cell-level adjacencies recorded by the sweep.
 * @param faceCount Number of output faces.
 * @param seamEps Shared seams at most this long count as a touch, not an edge.
 * @param round Quantiser used to memoise already-explored seam intervals.
 * @param period Set when the cross-sweep coordinate is periodic — the radial
 *   sweep's is an angle, and a cell that wraps the centre records its intervals
 *   shifted by a whole turn, so they have to be brought into a common frame
 *   before they can be intersected.
 */
export function buildGraph(
  uidToFace: Map<number, number>,
  adjPairs: AdjPair[],
  faceCount: number,
  seamEps: number,
  round: (v: number) => number,
  period = 0,
): { adjacency: number[][]; edges: Array<[number, number]> } {
  const outEdges = new Map<number, AdjPair[]>();
  for (const pair of adjPairs) {
    const list = outEdges.get(pair[0]);
    if (list) list.push(pair);
    else outEdges.set(pair[0], [pair]);
  }

  const adjacency: number[][] = Array.from({ length: faceCount }, () => []);
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
    const stack: Array<[number, number, number]> = (outEdges.get(uid) ?? []).map((p) => [
      p[1],
      p[2],
      p[3],
    ]);
    const visited = new Set<string>();
    while (stack.length) {
      const [w, lo, hi] = stack.pop() as [number, number, number];
      if (hi - lo <= seamEps) continue; // seam pinched to nothing along this path
      const key = `${w}|${round(lo)}|${round(hi)}`;
      if (visited.has(key)) continue;
      visited.add(key);
      const target = uidToFace.get(w);
      if (target !== undefined) {
        link(face, target);
      } else {
        for (const p of outEdges.get(w) ?? []) {
          let plo = p[2];
          let phi = p[3];
          if (period) {
            const k = Math.round((lo + hi - plo - phi) / (2 * period));
            plo += k * period;
            phi += k * period;
          }
          stack.push([p[1], Math.max(lo, plo), Math.min(hi, phi)]);
        }
      }
    }
  }
  for (const list of adjacency) list.sort((x, y) => x - y);
  return { adjacency, edges };
}
