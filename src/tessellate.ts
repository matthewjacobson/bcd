import type { Point, RadialDecompositionResult } from "./types.js";

const TWO_PI = 2 * Math.PI;

/**
 * How many equal steps a full turn at `radius` must be split into for the
 * chords to stay within `tolerance` of the circle.
 *
 * The gap between a chord and its arc (the sagitta) is `R·(1 − cos(Δθ/2))`, so
 * inverting that bounds the step. Counting steps per *full turn* rather than
 * per arc is deliberate: it makes the sample angles multiples of `2π/steps`,
 * a grid that depends only on the radius. Two cells sharing part of a cut
 * therefore tessellate it identically, and the shared boundary stays shared.
 */
export function arcSteps(radius: number, tolerance: number): number {
  if (!(radius > 0) || !(tolerance > 0)) return 3;
  const ratio = tolerance / radius;
  const dTheta = ratio >= 1 ? Math.PI : 2 * Math.acos(1 - ratio);
  return Math.max(3, Math.ceil(TWO_PI / dTheta));
}

/**
 * Grid angles strictly inside the arc from `from` to `to`, in sweep order.
 *
 * @param steps Divisions of a full turn (see {@link arcSteps}).
 * @param extra Additional angles (modulo `2π`) that must also be sampled —
 *   used to force a shared cut to break at the same places in every cell.
 */
export function arcSampleAngles(
  from: number,
  to: number,
  steps: number,
  extra?: number[],
): number[] {
  const step = TWO_PI / steps;
  const up = to > from;
  const lo = Math.min(from, to);
  const hi = Math.max(from, to);
  const eps = step * 1e-6;
  const out: number[] = [];
  for (let k = Math.ceil((lo + eps) / step); k * step < hi - eps; k++) out.push(k * step);
  if (extra) {
    for (const raw of extra) {
      // Lift each angle into every 2π window the arc passes through.
      const base = lo + (((raw - lo) % TWO_PI) + TWO_PI) % TWO_PI;
      for (let a = base; a < hi - eps; a += TWO_PI) if (a > lo + eps) out.push(a);
    }
  }
  out.sort((a, b) => a - b);
  if (!up) out.reverse();
  // Drop values that coincide after sorting (a grid angle can equal an extra).
  return out.filter((v, i) => i === 0 || Math.abs(v - out[i - 1]) > eps);
}

/** A loop edge that is circular rather than straight. */
interface SubArc {
  radius: number;
  from: number;
  to: number;
}

/**
 * Index a face's arcs by the loop position they start at, splitting arcs that
 * already span several loop edges into one record per edge.
 */
function subArcs(
  result: RadialDecompositionResult,
  faceIndex: number,
): Map<string, SubArc> {
  const { center, vertices, faces } = result;
  const face = faces[faceIndex];
  const loopOf = (hole: number): number[] =>
    hole < 0 ? face.ring : ((face.holes as number[][])[hole] ?? []);
  const angleOf = (v: number): number =>
    Math.atan2(vertices[v].y - center.y, vertices[v].x - center.x);

  const out = new Map<string, SubArc>();
  for (const arc of result.arcs) {
    if (arc.face !== faceIndex) continue;
    const loop = loopOf(arc.hole);
    const n = loop.length;
    if (n === 0) continue;
    const count = arc.count;
    const dir = Math.sign(arc.sweep) || 1;
    let angle = arc.startAngle;
    for (let k = 0; k < count; k++) {
      const i = (arc.index + k) % n;
      const nextAngle =
        k + 1 === count
          ? arc.startAngle + arc.sweep
          : advance(angle, angleOf(loop[(i + 1) % n]), dir);
      out.set(`${arc.hole}:${i}`, { radius: arc.radius, from: angle, to: nextAngle });
      angle = nextAngle;
    }
  }
  return out;
}

/** The representative of `target` (mod 2π) strictly beyond `from` in direction `dir`. */
function advance(from: number, target: number, dir: number): number {
  const delta = (((dir * (target - from)) % TWO_PI) + TWO_PI) % TWO_PI;
  return from + dir * delta;
}

/**
 * Approximate one radial cell by straight-line loops.
 *
 * {@link decomposeRadial} reports cells exactly: circular edges stay circular
 * and are described by {@link RadialDecompositionResult.arcs} rather than being
 * flattened. This walks a cell's loops and substitutes a polyline for every
 * such edge, which is what you want for rendering, area checks, or handing the
 * cell to code that only speaks polygons.
 *
 * @param result A radial decomposition.
 * @param faceIndex Which cell to flatten.
 * @param tolerance Maximum distance between an arc and its polyline. Defaults
 *   to 1/1000 of the cell's largest radius.
 * @returns The outer loop first, then one loop per hole (annular cells only).
 *   Points are in the original coordinate frame and do not repeat the first.
 */
export function tessellateRadialFace(
  result: RadialDecompositionResult,
  faceIndex: number,
  tolerance?: number,
): Point[][] {
  const face = result.faces[faceIndex];
  if (!face) throw new RangeError(`tessellateRadialFace: no face ${faceIndex}`);
  const { center, vertices } = result;
  const arcs = subArcs(result, faceIndex);

  let maxR = 0;
  for (const arc of arcs.values()) maxR = Math.max(maxR, arc.radius);
  const tol = tolerance ?? Math.max(maxR, 1) / 1000;

  const flatten = (loop: number[], hole: number): Point[] => {
    const out: Point[] = [];
    for (let i = 0; i < loop.length; i++) {
      out.push(vertices[loop[i]]);
      const arc = arcs.get(`${hole}:${i}`);
      if (!arc) continue;
      const steps = arcSteps(arc.radius, tol);
      for (const a of arcSampleAngles(arc.from, arc.to, steps)) {
        out.push({
          x: center.x + arc.radius * Math.cos(a),
          y: center.y + arc.radius * Math.sin(a),
        });
      }
    }
    return out;
  };

  const loops = [flatten(face.ring, -1)];
  if (face.holes) face.holes.forEach((h, i) => loops.push(flatten(h, i)));
  return loops;
}
