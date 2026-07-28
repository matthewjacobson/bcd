import type { Point } from "./types.js";
import { StatusTree, type EdgeGeometry, type StatusNode } from "./status.js";
import type { AdjPair } from "./sweep.js";

const TWO_PI = 2 * Math.PI;

/**
 * The boustrophedon sweep on a *cylinder*.
 *
 * In polar coordinates the expanding sweep circle becomes a straight sweep
 * line, but the frame it sweeps is a cylinder: `θ` and `θ + 2π` are the same
 * place. The cross-section at a radius is therefore a set of arcs *around* a
 * circle, and the cell above the topmost boundary edge is the same cell as the
 * one below the bottommost. Everything else — the START / SPLIT / END / MERGE /
 * REGULAR classification, the balanced status tree, the O(n log n) bound — is
 * the ordinary boustrophedon construction, shared with {@link runSweep}.
 *
 * The cylinder costs three things a flat sweep does not need:
 *
 * - **Wrapping cells.** A cell may run the long way round through `θ₀`. Its
 *   ceiling then sits *below* its floor in the tree's ordering, so each cell
 *   carries `2π` shifts that lift its two boundaries into one continuous frame.
 * - **A full cell.** When no boundary edge is active the cross-section is the
 *   whole circle, and the cell is a disc or an annulus with no bounding edges
 *   at all. It is born at the centre (if the centre is inside the region) or
 *   whenever a merge closes a wrapping cell onto itself, and it dies at the
 *   first tangency that breaks the circle open.
 * - **Wrap events.** Edges are cut where they cross `θ₀` so that none of them
 *   ever straddles the tree's ordering seam. Each cut is a non-event
 *   geometrically: the edge simply leaves the top of the tree and re-enters at
 *   the bottom, and the cell it bounds carries on.
 *
 * Cutting the edges is what keeps the ordering valid, and handling the cut as
 * an event rather than a boundary is what keeps the cut out of the answer.
 */

const FLOOR = 0;
const CEIL = 1;

interface Edge extends StatusNode {
  cell: Cell;
  role: typeof FLOOR | typeof CEIL;
}

interface Cell {
  uid: number;
  floor: Edge | null;
  ceil: Edge | null;
  floorPts: Point[];
  ceilPts: Point[];
  /** Multiple of `2π` lifting raw floor angles into this cell's frame. */
  floorShift: number;
  /** Likewise for the ceiling; exceeds `floorShift` when the cell wraps. */
  ceilShift: number;
  /** Cross-section is the whole circle: no bounding edges, inner radius below. */
  full: boolean;
  innerR: number;
}

/** A traced cell. `full` cells are annuli (or a disc when the inner radius is 0). */
export interface RadialCell {
  uid: number;
  /** Closed loop in `(r, θ)`, with `θ` continuous — it may leave `[θ₀, θ₀+2π]`. */
  pts: Point[];
  full: boolean;
}

export interface RadialSweepInput {
  /** Radius of each vertex. */
  pr: number[];
  /** Angle of each vertex, in `[θ₀, θ₀ + 2π]`. */
  pth: number[];
  prev: number[];
  next: number[];
  /**
   * Branch-ray crossings, as vertex pairs `[arriving, leaving]`: the boundary
   * reaches `arriving` at one edge of the `θ` window and carries on from
   * `leaving` at the other. The two are the same point of the plane.
   */
  wraps: Array<[number, number]>;
  /** Whether the sweep centre lies inside the region (a disc is born at `r = 0`). */
  centerInside: boolean;
  geom: EdgeGeometry & { dirAt(v: number, w: number): { dx: number; dy: number } };
  theta0: number;
}

export function radialSweep(input: RadialSweepInput): {
  cells: RadialCell[];
  adjPairs: AdjPair[];
} {
  const { pr, pth, prev, next, geom, theta0 } = input;
  const N = pr.length;
  const thetaTop = theta0 + TWO_PI;

  const wrapNext = new Int32Array(N).fill(-1);
  const wrapPrev = new Int32Array(N).fill(-1);
  for (const [a, b] of input.wraps) {
    wrapNext[a] = b;
    wrapPrev[b] = a;
  }

  const lexLess = (i: number, j: number): boolean =>
    pr[i] < pr[j] || (pr[i] === pr[j] && pth[i] < pth[j]);
  const point = (i: number): Point => ({ x: pr[i], y: pth[i] });

  const newEdge = (i: number, j: number, role: typeof FLOOR | typeof CEIL): Edge => ({
    ai: lexLess(i, j) ? i : j,
    bi: lexLess(i, j) ? j : i,
    cell: null as unknown as Cell,
    role,
    left: null,
    right: null,
    parent: null,
    height: 1,
  });

  const cells: RadialCell[] = [];
  const adjPairs: AdjPair[] = [];
  let uid = 0;

  const makeCell = (
    floor: Edge | null,
    ceil: Edge | null,
    floorPts: Point[],
    ceilPts: Point[],
    floorShift: number,
    ceilShift: number,
  ): Cell => {
    const cell: Cell = {
      uid: uid++,
      floor,
      ceil,
      floorPts,
      ceilPts,
      floorShift,
      ceilShift,
      full: false,
      innerR: 0,
    };
    if (floor) floor.cell = cell;
    if (ceil) ceil.cell = cell;
    return cell;
  };

  const status = new StatusTree<Edge>(pr, pth, geom);
  const endsAt: Edge[][] = Array.from({ length: N }, () => []);
  const addEdge = (e: Edge): void => {
    status.insert(e);
    endsAt[e.bi].push(e);
  };
  const closeCell = (c: Cell): void => {
    cells.push({ uid: c.uid, pts: c.floorPts.concat([...c.ceilPts].reverse()), full: false });
  };

  /** Height of a cell's floor / ceiling in that cell's own continuous frame. */
  const floorY = (c: Cell): number => status.yOf(c.floor as Edge) + c.floorShift;
  const ceilY = (c: Cell): number => status.yOf(c.ceil as Edge) + c.ceilShift;
  /** Lift a raw vertex angle into the frame of the cell it falls inside. */
  const liftInto = (c: Cell, y: number): number => {
    const lo = floorY(c);
    let v = y;
    while (v < lo - 1e-9) v += TWO_PI;
    while (v > lo + TWO_PI + 1e-9) v -= TWO_PI;
    return v;
  };

  // --- The full cell: no bounding edges, cross-section the whole circle.
  let full: Cell | null = null;
  const openFull = (innerR: number): Cell => {
    const c = makeCell(null, null, [], [], 0, TWO_PI);
    c.full = true;
    c.innerR = innerR;
    return c;
  };
  const closeFull = (c: Cell, outerR: number): void => {
    cells.push({
      uid: c.uid,
      pts: [
        { x: c.innerR, y: theta0 },
        { x: outerR, y: theta0 },
        { x: outerR, y: thetaTop },
        { x: c.innerR, y: thetaTop },
      ],
      full: true,
    });
  };
  if (input.centerInside) full = openFull(0);

  const order = Array.from({ length: N }, (_, i) => i).sort((i, j) =>
    lexLess(i, j) ? -1 : lexLess(j, i) ? 1 : 0,
  );
  const done = new Uint8Array(N);

  for (const v of order) {
    if (done[v]) continue;
    status.sweepX = pr[v];

    // --- A branch-ray crossing: not an event, just a change of representative.
    if (wrapNext[v] >= 0 || wrapPrev[v] >= 0) {
      const a = wrapNext[v] >= 0 ? v : wrapPrev[v];
      const b = wrapNext[a];
      done[a] = 1;
      done[b] = 1;
      // Exactly one side ends here (r is monotone through a crossing); the
      // other side takes over, at the opposite edge of the θ window.
      const inEnds = lexLess(prev[a], a);
      const ending = inEnds ? endsAt[a][0] : endsAt[b][0];
      if (!ending) continue;
      const from = inEnds ? a : b;
      const to = inEnds ? b : a;
      const onward = inEnds ? next[b] : prev[a];
      const cont = newEdge(to, onward, ending.role);
      const cell = ending.cell;
      cont.cell = cell;
      if (ending.role === FLOOR) {
        cell.floorPts.push({ x: pr[from], y: pth[from] + cell.floorShift });
        cell.floorShift += pth[from] - pth[to];
        cell.floor = cont;
      } else {
        cell.ceilPts.push({ x: pr[from], y: pth[from] + cell.ceilShift });
        cell.ceilShift += pth[from] - pth[to];
        cell.ceil = cont;
      }
      status.remove(ending);
      addEdge(cont);
      continue;
    }

    done[v] = 1;
    const p = prev[v];
    const n = next[v];
    const pLeft = lexLess(p, v);
    const nLeft = lexLess(n, v);
    const dp = geom.dirAt(v, p);
    const dn = geom.dirAt(v, n);
    const turn = -dp.dx * dn.dy + dp.dy * dn.dx;

    if (!pLeft && !nLeft) {
      const upperIsNext = dp.dx * dn.dy - dp.dy * dn.dx > 0;
      const upper = upperIsNext ? n : p;
      const lower = upperIsNext ? p : n;

      if (full) {
        // The growing circle has touched the boundary: the disc/annulus breaks
        // open into a single cell that runs the long way round the centre.
        closeFull(full, pr[v]);
        const floor = newEdge(v, upper, FLOOR);
        const ceil = newEdge(v, lower, CEIL);
        const c = makeCell(
          floor,
          ceil,
          [point(v)],
          [{ x: pr[v], y: pth[v] + TWO_PI }],
          0,
          TWO_PI,
        );
        addEdge(floor);
        addEdge(ceil);
        adjPairs.push([full.uid, c.uid, theta0, thetaTop]);
        full = null;
      } else if (turn > 0) {
        // START: a fresh cell begins at this closest approach.
        const floor = newEdge(v, lower, FLOOR);
        const ceil = newEdge(v, upper, CEIL);
        makeCell(floor, ceil, [point(v)], [point(v)], 0, 0);
        addEdge(floor);
        addEdge(ceil);
      } else {
        // SPLIT: the cell containing v divides into a lower and an upper cell.
        let below = status.floorBelow(pth[v]);
        if (!below) below = status.maxNode(); // wrap: nothing below, take the top
        if (!below || below.role !== FLOOR) {
          const floor = newEdge(v, lower, FLOOR);
          const ceil = newEdge(v, upper, CEIL);
          makeCell(floor, ceil, [point(v)], [point(v)], 0, 0);
          addEdge(floor);
          addEdge(ceil);
          continue;
        }
        const c = below.cell;
        const x = pr[v];
        const yf = floorY(c);
        const yc = ceilY(c);
        const yv = liftInto(c, pth[v]);
        c.floorPts.push({ x, y: yf });
        c.ceilPts.push({ x, y: yc });
        closeCell(c);

        const lowCeil = newEdge(v, lower, CEIL);
        const highFloor = newEdge(v, upper, FLOOR);
        const shift = yv - pth[v];
        const low = makeCell(c.floor, lowCeil, [{ x, y: yf }], [{ x, y: yv }], c.floorShift, shift);
        const high = makeCell(highFloor, c.ceil, [{ x, y: yv }], [{ x, y: yc }], shift, c.ceilShift);
        addEdge(lowCeil);
        addEdge(highFloor);
        adjPairs.push([c.uid, low.uid, yf, yv], [c.uid, high.uid, yv, yc]);
      }
    } else if (pLeft && nLeft) {
      const ends = endsAt[v];
      if (ends.length !== 2) continue;
      if (turn > 0) {
        // END: the cell whose floor and ceiling both terminate at v closes.
        const c = ends[0].cell;
        c.floorPts.push({ x: pr[v], y: pth[v] + c.floorShift });
        c.ceilPts.push({ x: pr[v], y: pth[v] + c.ceilShift });
        closeCell(c);
        status.remove(ends[0]);
        status.remove(ends[1]);
      } else {
        const ceilEnding = ends[0].role === CEIL ? ends[0] : ends[1];
        const floorEnding = ends[0].role === FLOOR ? ends[0] : ends[1];
        const low = ceilEnding.cell;
        const high = floorEnding.cell;
        const x = pr[v];
        if (low === high) {
          // The cell wrapped all the way round and has now closed on itself:
          // beyond this radius the cross-section is a full circle again.
          low.ceilPts.push({ x, y: pth[v] + low.ceilShift });
          low.floorPts.push({ x, y: pth[v] + low.floorShift });
          closeCell(low);
          status.remove(ceilEnding);
          status.remove(floorEnding);
          full = openFull(x);
          adjPairs.push([low.uid, full.uid, theta0, thetaTop]);
        } else {
          // MERGE: a lower and an upper cell fuse into one.
          const yf = floorY(low);
          const yc = ceilY(high);
          low.ceilPts.push({ x, y: pth[v] + low.ceilShift });
          low.floorPts.push({ x, y: yf });
          closeCell(low);
          high.floorPts.push({ x, y: pth[v] + high.floorShift });
          high.ceilPts.push({ x, y: yc });
          closeCell(high);
          status.remove(ceilEnding);
          status.remove(floorEnding);
          // Re-express the upper cell's frame in the lower cell's, so the
          // merged cell's two boundaries stay in one continuous frame.
          const delta = low.ceilShift - high.floorShift;
          const yMerge = pth[v] + low.ceilShift;
          const merged = makeCell(
            low.floor,
            high.ceil,
            [{ x, y: yf }],
            [{ x, y: yc + delta }],
            low.floorShift,
            high.ceilShift + delta,
          );
          adjPairs.push(
            [low.uid, merged.uid, yf, yMerge],
            [high.uid, merged.uid, yMerge, yc + delta],
          );
        }
      }
    } else {
      // REGULAR: the boundary bends; one cell's floor or ceiling continues.
      const e = endsAt[v][0];
      if (!e) continue;
      const right = pLeft ? n : p;
      const cont = newEdge(v, right, e.role);
      cont.cell = e.cell;
      if (e.role === FLOOR) {
        e.cell.floorPts.push({ x: pr[v], y: pth[v] + e.cell.floorShift });
        e.cell.floor = cont;
      } else {
        e.cell.ceilPts.push({ x: pr[v], y: pth[v] + e.cell.ceilShift });
        e.cell.ceil = cont;
      }
      status.remove(e);
      addEdge(cont);
    }
  }

  return { cells, adjPairs };
}
