import type {
  Point,
  Polygon,
  RadialArc,
  RadialDecompositionResult,
  RadialFace,
  RadialOptions,
} from "./types.js";
import {
  AREA_EPS_REL,
  QUANTUM_REL,
  SEAM_EPS_REL,
  signedArea,
  stripDuplicatePoints,
  wrapPi,
} from "./geometry.js";
import { buildGraph, type AdjPair } from "./sweep.js";
import { radialSweep, type RadialCell } from "./radial-sweep.js";
import { linkHalfEdges } from "./dcel.js";
import { arcSampleAngles, arcSteps } from "./tessellate.js";

const TWO_PI = 2 * Math.PI;

/** The polar frame, flattened into the arrays the sweep works on. */
interface PolarRings {
  /** Radius per vertex. */
  pr: number[];
  /** Angle per vertex, within `[θ₀, θ₀ + 2π]`. */
  pth: number[];
  /** Cartesian position relative to the centre — exact, not round-tripped. */
  pcx: number[];
  pcy: number[];
  prev: number[];
  next: number[];
  /** Branch-ray crossings as `[arriving, leaving]` vertex pairs. */
  wraps: Array<[number, number]>;
  /** True when the ray leaves the region an odd number of times, i.e. starts inside it. */
  centerInside: boolean;
}

/**
 * Compute the *radial* boustrophedon cellular decomposition of a polygon.
 *
 * Where {@link decompose} advances a straight line across the polygon, this
 * advances a **circle** outward from `center`, so cells are bounded by circular
 * arcs and the region is carved into discs, annuli and annular sectors. It is
 * the same algorithm viewed in polar coordinates: mapping `(x, y)` to `(r, θ)`
 * turns the expanding circle into a straight sweep line and the boustrophedon
 * construction applies unchanged.
 *
 * Two things distinguish it from the linear sweep:
 *
 * - `r` is not monotone along a straight edge, so every edge is first split at
 *   its closest approach to `center`. That point is a critical point of the
 *   radial sweep with no linear analogue — it is where the growing circle runs
 *   tangent to an edge and the cross-section changes shape.
 * - The polar frame is a cylinder, not a plane, so cells may wrap the whole way
 *   around the centre. The sweep is cylinder-aware
 *   (see {@link radialSweep}); the ray the frame is cut along is bookkeeping
 *   only and leaves no trace in the result.
 *
 * Runs in `O(n log n)` for `n` vertices.
 *
 * @param polygon Outer ring plus optional holes (any winding order).
 * @param center Point the sweep circle expands from. It may lie inside the
 *   polygon, inside a hole, or outside it entirely, but not on an edge.
 * @param options See {@link RadialOptions}.
 * @returns Vertices, cells (each an outer loop plus, for annuli, inner loops),
 *   the exact arcs along those loops, and the cell connectivity graph.
 */
export function decomposeRadial(
  polygon: Polygon,
  center: Point,
  options?: RadialOptions,
): RadialDecompositionResult {
  if (!polygon || !Array.isArray(polygon.outer)) {
    throw new Error("decomposeRadial: polygon.outer must contain at least 3 points");
  }
  if (!center || !Number.isFinite(center.x) || !Number.isFinite(center.y)) {
    throw new Error("decomposeRadial: center must be a finite point");
  }

  // --- Sanitize and orient rings, translated so `center` is the origin. The
  // interior must lie to the left of every directed edge, and the polar map is
  // orientation-preserving, so this carries over to the polar frame unchanged.
  const outerRing = stripDuplicatePoints(polygon.outer);
  if (outerRing.length < 3) {
    throw new Error("decomposeRadial: polygon.outer must contain at least 3 distinct points");
  }
  const shift = (p: Point): Point => ({ x: p.x - center.x, y: p.y - center.y });
  const rings: Point[][] = [];
  const outer = outerRing.map(shift);
  if (signedArea(outer) < 0) outer.reverse();
  rings.push(outer);
  for (const hole of polygon.holes ?? []) {
    if (!Array.isArray(hole)) continue;
    const h = stripDuplicatePoints(hole);
    if (h.length < 3) continue;
    const hs = h.map(shift);
    if (signedArea(hs) > 0) hs.reverse();
    rings.push(hs);
  }

  // --- Scale. Tolerances follow the bounding box as in the linear sweep, but
  // the sweep coordinate is a radius, so a far-away centre sets the scale too.
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxR = 0;
  for (const ring of rings) {
    for (const p of ring) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
      maxR = Math.max(maxR, Math.hypot(p.x, p.y));
    }
  }
  const scale = Math.max(Math.hypot(maxX - minX, maxY - minY), maxR);
  const quantum = scale * QUANTUM_REL;

  // The centre must not sit on the boundary: the polar map is singular there,
  // so the boundary's angle would be undefined. The cut-off is the same
  // quantum vertices are merged at — any closer and the angles of nearby
  // boundary points stop being meaningful, so refuse rather than mislead.
  for (const ring of rings) {
    for (let i = 0; i < ring.length; i++) {
      if (distanceToSegment(ring[i], ring[(i + 1) % ring.length]) <= quantum) {
        throw new Error("decomposeRadial: center is on (or within rounding of) the polygon boundary");
      }
    }
  }

  const theta0 =
    options?.branchAngle === undefined
      ? chooseBranchAngle(rings)
      : nudgeOffCriticalAngles(rings, options.branchAngle);
  const polar = buildPolarRings(rings, theta0);
  if (polar.pr.length === 0) {
    return {
      center: { ...center },
      branchAngle: theta0,
      vertices: [],
      faces: [],
      arcs: [],
      graph: { adjacency: [], edges: [] },
    };
  }

  const geom = polarGeometry(polar);
  const { cells, adjPairs } = radialSweep({ ...polar, geom, theta0 });

  return assembleRadial(
    cells,
    adjPairs,
    center,
    theta0,
    scale,
    quantum,
    options?.arcTolerance ?? scale / 1000,
    options?.dcel === true,
  );
}

/** Distance from the origin to the segment `a`–`b`. */
function distanceToSegment(a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const dd = dx * dx + dy * dy;
  if (dd === 0) return Math.hypot(a.x, a.y);
  const t = Math.max(0, Math.min(1, -(a.x * dx + a.y * dy) / dd));
  return Math.hypot(a.x + t * dx, a.y + t * dy);
}

/**
 * Pick the direction to cut the polar frame open along.
 *
 * The cut has no effect on the decomposition — the sweep steps across it — but
 * it does have to be unambiguous. The best cut is one the polygon never
 * touches, so the angular intervals subtended by the edges are unioned and the
 * middle of the widest uncovered gap is taken; the ray then produces no
 * crossings at all.
 *
 * When the polygon surrounds the centre there is no such gap, and the middle of
 * the widest gap between the *critical* angles is used instead: the vertices,
 * plus the closest approach of each edge. Steering clear of both keeps the ray
 * crossing edge interiors only, away from any sweep event, which is what keeps
 * the crossing bookkeeping unambiguous.
 */
function chooseBranchAngle(rings: Point[][]): number {
  const norm = (a: number): number => ((a % TWO_PI) + TWO_PI) % TWO_PI;
  const covered: Array<[number, number]> = [];
  for (const ring of rings) {
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i];
      const b = ring[(i + 1) % ring.length];
      const aa = Math.atan2(a.y, a.x);
      // A segment that misses the origin subtends less than π, so the short
      // way round is the interval it actually covers.
      const d = wrapPi(Math.atan2(b.y, b.x) - aa);
      const lo = norm(d >= 0 ? aa : aa + d);
      const hi = lo + Math.abs(d);
      if (hi <= TWO_PI) covered.push([lo, hi]);
      else covered.push([lo, TWO_PI], [0, hi - TWO_PI]);
    }
  }

  const gap = widestGap(covered);
  if (gap !== null) return gap;

  const avoid = criticalAngles(rings);
  let best = -1;
  let bestAt = 0;
  for (let i = 0; i < avoid.length; i++) {
    const lo = avoid[i];
    const hi = i + 1 < avoid.length ? avoid[i + 1] : avoid[0] + TWO_PI;
    if (hi - lo > best) {
      best = hi - lo;
      bestAt = (lo + hi) / 2;
    }
  }
  return norm(bestAt);
}

/**
 * The angles the branch ray must avoid, sorted: every vertex, and every edge's
 * closest approach to the centre. A ray through one of those hits a point that
 * is simultaneously a sweep event and a frame crossing, which are handled by
 * different paths and cannot both apply to one vertex.
 */
function criticalAngles(rings: Point[][]): number[] {
  const norm = (a: number): number => ((a % TWO_PI) + TWO_PI) % TWO_PI;
  const out: number[] = [];
  for (const ring of rings) {
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i];
      const b = ring[(i + 1) % ring.length];
      out.push(norm(Math.atan2(a.y, a.x)));
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const foot = -(a.x * dx + a.y * dy) / (dx * dx + dy * dy);
      if (foot > 0 && foot < 1) out.push(norm(Math.atan2(a.y + foot * dy, a.x + foot * dx)));
    }
  }
  return out.sort((p, q) => p - q);
}

/**
 * Move a caller-supplied branch angle off any critical angle it lands on.
 *
 * Where the frame is cut has no bearing on the decomposition, so shifting the
 * ray a hair changes nothing that is observable except the placement of a few
 * vertices — and it avoids a degeneracy that would otherwise corrupt the sweep.
 */
function nudgeOffCriticalAngles(rings: Point[][], requested: number): number {
  const norm = (a: number): number => ((a % TWO_PI) + TWO_PI) % TWO_PI;
  const want = norm(requested);
  const avoid = criticalAngles(rings);
  if (avoid.length === 0) return want;
  const tol = 1e-7;
  for (let i = 0; i < avoid.length; i++) {
    if (Math.abs(wrapPi(avoid[i] - want)) > tol) continue;
    // Sit midway between this critical angle and the next one round, so the
    // shift stays as small as the geometry allows.
    const hi = i + 1 < avoid.length ? avoid[i + 1] : avoid[0] + TWO_PI;
    return norm(hi - avoid[i] > 2 * tol ? (avoid[i] + hi) / 2 : avoid[i] + tol);
  }
  return want;
}

/** Middle of the widest interval of `[0, 2π)` left uncovered, or `null` if none. */
function widestGap(covered: Array<[number, number]>): number | null {
  if (covered.length === 0) return 0;
  const sorted = [...covered].sort((a, b) => a[0] - b[0]);
  let best = 0;
  let bestAt = 0;
  let reach = 0;
  for (const [lo, hi] of sorted) {
    if (lo - reach > best) {
      best = lo - reach;
      bestAt = (reach + lo) / 2;
    }
    reach = Math.max(reach, hi);
  }
  if (TWO_PI - reach > best) {
    best = TWO_PI - reach;
    bestAt = (reach + TWO_PI) / 2;
  }
  return best > 1e-9 ? bestAt % TWO_PI : null;
}

/**
 * Lift the rings into the polar frame, ready for the sweep.
 *
 * Each edge is split twice over:
 *
 * - at its **closest approach** to the centre, where `r` turns around. That
 *   makes `r` monotone along every sub-edge, which is the invariant the sweep
 *   relies on, and the split point is itself a critical point of the sweep —
 *   the radius at which the growing circle runs tangent to the edge.
 * - at any **branch-ray crossing**, so that no sub-edge straddles the seam of
 *   the angular ordering. Each crossing becomes a pair of coincident vertices,
 *   one at each end of the `θ` window, which the sweep steps between.
 */
function buildPolarRings(rings: Point[][], theta0: number): PolarRings {
  const ux = Math.cos(theta0);
  const uy = Math.sin(theta0);

  const pr: number[] = [];
  const pth: number[] = [];
  const pcx: number[] = [];
  const pcy: number[] = [];
  const prev: number[] = [];
  const next: number[] = [];
  const wraps: Array<[number, number]> = [];
  let crossings = 0;

  for (const ring of rings) {
    // --- Subdivide, flagging the vertices that land on the branch ray.
    const pts: Point[] = [];
    const onRay: boolean[] = [];
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i];
      const b = ring[(i + 1) % ring.length];
      pts.push(a);
      onRay.push(false);

      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const cuts: Array<{ t: number; ray: boolean }> = [];

      const foot = -(a.x * dx + a.y * dy) / (dx * dx + dy * dy);
      if (foot > 1e-12 && foot < 1 - 1e-12) cuts.push({ t: foot, ray: false });

      // cross(u, a + t·d) = 0 puts the point on the branch *line*; the dot
      // product then selects the half of it that is the branch *ray*.
      const cd = ux * dy - uy * dx;
      if (cd !== 0) {
        const t = -(ux * a.y - uy * a.x) / cd;
        if (t > 1e-12 && t < 1 - 1e-12) {
          const px = a.x + t * dx;
          const py = a.y + t * dy;
          if (px * ux + py * uy > 0) cuts.push({ t, ray: true });
        }
      }
      cuts.sort((p, q) => p.t - q.t);
      // If the closest approach lands on the ray, one point serves both roles —
      // and it must be the ray one, whose angle gets snapped onto the cut.
      if (cuts.length === 2 && cuts[1].t - cuts[0].t < 1e-9) {
        cuts.splice(0, 2, cuts[0].ray ? cuts[0] : cuts[1]);
      }
      for (const c of cuts) {
        pts.push({ x: a.x + c.t * dx, y: a.y + c.t * dy });
        onRay.push(c.ray);
      }
    }

    // --- Unwrap the angle around the ring. Every level θ₀ + 2πk the trace
    // passes through is a ray crossing, and those are already vertices, so the
    // trace can be cut there into pieces that each live in one 2π band.
    const m = pts.length;
    const as = pts.map((p) => Math.atan2(p.y, p.x));
    const u: number[] = new Array(m);
    u[0] = theta0 + ((((as[0] - theta0) % TWO_PI) + TWO_PI) % TWO_PI);
    for (let i = 1; i < m; i++) u[i] = u[i - 1] + wrapPi(as[i] - as[i - 1]);
    for (let i = 0; i < m; i++) {
      if (onRay[i]) u[i] = theta0 + TWO_PI * Math.round((u[i] - theta0) / TWO_PI);
    }

    const marks: number[] = [];
    for (let i = 0; i < m; i++) if (onRay[i]) marks.push(i);
    crossings += marks.length;

    const base = pr.length;
    const push = (i: number, th: number): number => {
      const id = pr.length;
      pr.push(Math.hypot(pts[i].x, pts[i].y));
      pth.push(th);
      pcx.push(pts[i].x);
      pcy.push(pts[i].y);
      prev.push(id - 1);
      next.push(id + 1);
      return id;
    };

    if (marks.length === 0) {
      const band = Math.floor((u[0] - theta0) / TWO_PI);
      for (let i = 0; i < m; i++) push(i, u[i] - TWO_PI * band);
    } else {
      // Walk the ring as consecutive chains between crossings. Each crossing
      // ends one chain and begins the next at the opposite edge of the window,
      // which is the pair the sweep steps across.
      for (let k = 0; k < marks.length; k++) {
        const from = marks[k];
        const to = marks[(k + 1) % marks.length];
        const idx: number[] = [from];
        for (let i = (from + 1) % m; ; i = (i + 1) % m) {
          idx.push(i);
          if (i === to) break;
        }
        // Angles continue past the end of the array; re-accumulate along the run.
        const uu: number[] = [u[from]];
        for (let j = 1; j < idx.length; j++) uu.push(uu[j - 1] + wrapPi(as[idx[j]] - as[idx[j - 1]]));
        const lastLevel = Math.round((uu[uu.length - 1] - theta0) / TWO_PI);
        uu[uu.length - 1] = theta0 + TWO_PI * lastLevel;
        const firstLevel = Math.round((uu[0] - theta0) / TWO_PI);
        const band =
          idx.length > 2
            ? Math.floor((uu[1] - theta0) / TWO_PI)
            : Math.min(firstLevel, lastLevel);

        const chainStart = pr.length;
        // The chain's last vertex is shared with the next chain's first, so it
        // is emitted here and the pairing recorded once the successor exists.
        for (let j = 0; j < idx.length; j++) push(idx[j], uu[j] - TWO_PI * band);
        if (k > 0) wraps.push([chainStart - 1, chainStart]);
      }
      wraps.push([pr.length - 1, base]);
    }

    // Close the ring's linkage.
    prev[base] = pr.length - 1;
    next[pr.length - 1] = base;
  }

  return { pr, pth, pcx, pcy, prev, next, wraps, centerInside: crossings % 2 === 1 };
}

/**
 * Edge geometry in the polar frame.
 *
 * A polygon edge is a straight Cartesian segment, so in `(r, θ)` it is a curve;
 * evaluating it at a sweep radius means intersecting the segment with a circle,
 * which is exact. Because every edge was split at its closest approach, `r` is
 * monotone along it and that intersection is unique.
 *
 * Directions need one piece of care. At a closest approach `dr/dθ` is zero, so
 * both edges meeting there leave *straight up* the polar frame and their
 * tangents are parallel — carrying no sign, though the sweep needs one to tell
 * the upper branch from the lower. The chord to the far endpoint does carry it,
 * so it stands in wherever the tangent goes vertical.
 */
function polarGeometry(rings: PolarRings) {
  const { pr, pth, pcx, pcy } = rings;
  const vertical = (dot: number, px: number, py: number, dx: number, dy: number): boolean =>
    Math.abs(dot) <= 1e-9 * Math.hypot(px, py) * Math.hypot(dx, dy);

  /** Cartesian point at radius `x` along the segment from `ai` (the near end) to `bi`. */
  const pointAt = (ai: number, bi: number, x: number): { px: number; py: number } => {
    const ax = pcx[ai];
    const ay = pcy[ai];
    const dx = pcx[bi] - ax;
    const dy = pcy[bi] - ay;
    const a = dx * dx + dy * dy;
    if (a === 0) return { px: ax, py: ay };
    const b = 2 * (ax * dx + ay * dy);
    const c = ax * ax + ay * ay - x * x;
    // `ai` is the near end, so r grows with t and the root we want is the upper
    // one; the other lies before the closest approach, at t < 0.
    let t = (-b + Math.sqrt(Math.max(0, b * b - 4 * a * c))) / (2 * a);
    if (!Number.isFinite(t)) t = 0;
    t = Math.max(0, Math.min(1, t));
    return { px: ax + t * dx, py: ay + t * dy };
  };

  return {
    yAt(ai: number, bi: number, x: number): number {
      if (x <= pr[ai]) return pth[ai];
      if (x >= pr[bi]) return pth[bi];
      const { px, py } = pointAt(ai, bi, x);
      return pth[ai] + wrapPi(Math.atan2(py, px) - pth[ai]);
    },
    tangentAt(ai: number, bi: number, x: number): { dx: number; dy: number } {
      const { px, py } = pointAt(ai, bi, x);
      const dx = pcx[bi] - pcx[ai];
      const dy = pcy[bi] - pcy[ai];
      const dot = px * dx + py * dy;
      if (vertical(dot, px, py, dx, dy)) return { dx: pr[bi] - pr[ai], dy: pth[bi] - pth[ai] };
      // r·(dr/dt, dθ/dt) — a positive rescaling, so cross-product signs hold.
      return { dx: dot, dy: (px * dy - py * dx) / Math.max(x, 1e-300) };
    },
    dirAt(v: number, w: number): { dx: number; dy: number } {
      const px = pcx[v];
      const py = pcy[v];
      const dx = pcx[w] - px;
      const dy = pcy[w] - py;
      const dot = px * dx + py * dy;
      if (vertical(dot, px, py, dx, dy)) return { dx: pr[w] - pr[v], dy: pth[w] - pth[v] };
      return { dx: dot, dy: (px * dy - py * dx) / Math.max(pr[v], 1e-300) };
    },
  };
}

/** One boundary edge of a cell: an arc about the centre, or a straight chord. */
interface CycleSeg {
  from: { r: number; th: number };
  to: { r: number; th: number };
  arc: boolean;
  /** Identifies the arc this edge belongs to once arcs have been tessellated. */
  group?: number;
}

/** Signed area of a loop of straight and circular edges (shoelace, plus `½r²Δθ`). */
function cycleArea(segs: CycleSeg[]): number {
  let a = 0;
  for (const s of segs) {
    if (s.arc) {
      a += s.from.r * s.from.r * (s.to.th - s.from.th);
    } else {
      a +=
        s.from.r * Math.cos(s.from.th) * (s.to.r * Math.sin(s.to.th)) -
        s.to.r * Math.cos(s.to.th) * (s.from.r * Math.sin(s.from.th));
    }
  }
  return a / 2;
}

/** Split a traced cell's `(r, θ)` loop into its straight and circular edges. */
function toCycle(pts: Point[], rEps: number, angEps: number): CycleSeg[] {
  const clean: Array<{ r: number; th: number }> = [];
  for (const p of pts) {
    const last = clean[clean.length - 1];
    if (last && Math.abs(last.r - p.x) <= rEps && Math.abs(last.th - p.y) <= angEps) continue;
    clean.push({ r: p.x, th: p.y });
  }
  while (clean.length > 1) {
    const a = clean[0];
    const b = clean[clean.length - 1];
    if (Math.abs(a.r - b.r) <= rEps && Math.abs(a.th - b.th) <= angEps) clean.pop();
    else break;
  }
  if (clean.length < 2) return [];

  const segs: CycleSeg[] = [];
  for (let i = 0; i < clean.length; i++) {
    const from = clean[i];
    const to = clean[(i + 1) % clean.length];
    // Every sub-edge is monotone in r, so equal radii can only mean a sweep cut.
    segs.push({ from, to, arc: Math.abs(from.r - to.r) <= rEps });
  }
  return segs;
}

/**
 * Break every arc into straight edges, so that cells sharing a cut share their
 * vertices exactly.
 *
 * A DCEL needs the loops to be a proper mesh: an edge of one face must not run
 * through a vertex of another. Arcs are sampled at multiples of a grid that
 * depends only on the radius, *and* at every angle where some cell's boundary
 * already meets that circle. Both cells bounding a cut therefore break it at
 * exactly the same places, leaving no T-junctions to resolve.
 */
function subdivideArcs(
  loopsPerCell: CycleSeg[][][],
  tolerance: number,
  quantum: number,
): void {
  // Angles at which some cell's boundary meets each cut circle.
  const stops = new Map<number, number[]>();
  const rKey = (r: number): number => Math.round(r / Math.max(quantum, 1e-300));
  for (const loops of loopsPerCell) {
    for (const loop of loops) {
      for (const s of loop) {
        if (!s.arc) continue;
        const k = rKey(s.from.r);
        const list = stops.get(k) ?? [];
        list.push(s.from.th, s.to.th);
        stops.set(k, list);
      }
    }
  }

  let group = 0;
  for (const loops of loopsPerCell) {
    for (let li = 0; li < loops.length; li++) {
      const out: CycleSeg[] = [];
      for (const s of loops[li]) {
        if (!s.arc) {
          out.push(s);
          continue;
        }
        const g = group++;
        const r = s.from.r;
        const angles = arcSampleAngles(
          s.from.th,
          s.to.th,
          arcSteps(r, tolerance),
          stops.get(rKey(r)),
        );
        let cur = s.from;
        for (const th of angles) {
          const to = { r, th };
          out.push({ from: cur, to, arc: true, group: g });
          cur = to;
        }
        out.push({ from: cur, to: s.to, arc: true, group: g });
      }
      loops[li] = out;
    }
  }
}

/**
 * Turn traced cells into the public result: split full cells into their two
 * circles, filter slivers, de-duplicate vertices and record the arcs.
 */
function assembleRadial(
  cells: RadialCell[],
  adjPairs: AdjPair[],
  center: Point,
  theta0: number,
  scale: number,
  quantum: number,
  arcTolerance: number,
  withDcel: boolean,
): RadialDecompositionResult {
  const areaEps = scale * scale * AREA_EPS_REL;
  const round = (v: number): number => Math.round(v / quantum) * quantum;
  const angEps = 1e-9;

  // --- Boundary loops per surviving cell.
  const kept: Array<{ uid: number; loops: CycleSeg[][] }> = [];
  for (const cell of cells) {
    let loops: CycleSeg[][];
    if (cell.full) {
      // A full cell is bounded only by its two circles: the outer one
      // counter-clockwise, and — unless it reaches the centre — an inner one
      // clockwise, which is what makes the cell an annulus rather than a disc.
      const inner = cell.pts[0].x;
      const outer = cell.pts[1].x;
      loops = [
        [{ from: { r: outer, th: theta0 }, to: { r: outer, th: theta0 + TWO_PI }, arc: true }],
      ];
      if (inner > quantum) {
        loops.push([
          { from: { r: inner, th: theta0 }, to: { r: inner, th: theta0 - TWO_PI }, arc: true },
        ]);
      }
    } else {
      const segs = toCycle(cell.pts, quantum, angEps);
      if (segs.length === 0) continue;
      loops = [segs];
    }
    if (Math.abs(loops.reduce((s, l) => s + cycleArea(l), 0)) <= areaEps) continue;
    kept.push({ uid: cell.uid, loops });
  }

  if (withDcel) subdivideArcs(kept.map((k) => k.loops), arcTolerance, quantum);

  // --- Vertices, faces and arcs.
  const vertices: Point[] = [];
  const vmap = new Map<string, number>();
  const vertexId = (r: number, th: number): number => {
    const x = r * Math.cos(th);
    const y = r * Math.sin(th);
    const key = `${round(x)}|${round(y)}`;
    let id = vmap.get(key);
    if (id === undefined) {
      id = vertices.length;
      vmap.set(key, id);
      vertices.push({ x: x + center.x, y: y + center.y });
    }
    return id;
  };

  const faces: RadialFace[] = [];
  const arcs: RadialArc[] = [];
  const uidToFace = new Map<number, number>();
  const dcelLoops: number[][] = [];
  const dcelLoopFace: number[] = [];

  for (const { uid, loops } of kept) {
    const faceIndex = faces.length;
    const emit = (segs: CycleSeg[], hole: number): number[] => {
      const ids: number[] = [];
      for (let i = 0; i < segs.length; ) {
        const s = segs[i];
        ids.push(vertexId(s.from.r, s.from.th));
        if (!s.arc) {
          i++;
          continue;
        }
        // Tessellation split one arc across several edges; report it as one.
        let j = i + 1;
        while (j < segs.length && segs[j].arc && segs[j].group === s.group && s.group !== undefined) {
          ids.push(vertexId(segs[j].from.r, segs[j].from.th));
          j++;
        }
        arcs.push({
          face: faceIndex,
          hole,
          index: i,
          count: j - i,
          radius: s.from.r,
          startAngle: Math.atan2(Math.sin(s.from.th), Math.cos(s.from.th)),
          sweep: segs[j - 1].to.th - s.from.th,
        });
        i = j;
      }
      return ids;
    };

    const ring = emit(loops[0], -1);
    const face: RadialFace = { ring };
    dcelLoops.push(ring);
    dcelLoopFace.push(faceIndex);
    if (loops.length > 1) {
      face.holes = loops.slice(1).map((l, i) => {
        const hole = emit(l, i);
        dcelLoops.push(hole);
        dcelLoopFace.push(faceIndex);
        return hole;
      });
    }
    faces.push(face);
    uidToFace.set(uid, faceIndex);
  }

  // The sweep's cross-coordinate is an angle, so its tolerances are angular
  // and its intervals live on a circle rather than a line.
  const graph = buildGraph(
    uidToFace,
    adjPairs,
    faces.length,
    SEAM_EPS_REL,
    (v) => Math.round(v / QUANTUM_REL) * QUANTUM_REL,
    TWO_PI,
  );

  const result: RadialDecompositionResult = {
    center: { ...center },
    branchAngle: theta0,
    vertices,
    faces,
    arcs,
    graph,
  };
  if (withDcel) {
    result.dcel = linkHalfEdges(
      dcelLoops,
      dcelLoopFace,
      faces.length,
      vertices.length,
      vertices.map((v) => v.x),
      vertices.map((v) => v.y),
    );
  }
  return result;
}
