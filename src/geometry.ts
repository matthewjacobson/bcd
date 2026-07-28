import type { Point } from "./types.js";

/**
 * Tolerances, all relative to `span` (the diagonal of the input's bounding
 * box), so behaviour is independent of the units and magnitude of the input.
 */
/** Faces whose absolute area is at most `span² · AREA_EPS_REL` are discarded as slivers. */
export const AREA_EPS_REL = 1e-12;
/** Shared seams shorter than `span · SEAM_EPS_REL` are treated as a touch, not an edge. */
export const SEAM_EPS_REL = 1e-9;
/** Quantum used when merging coincident vertices, as a fraction of `span`. */
export const QUANTUM_REL = 1e-9;

/**
 * Signed area of a ring via the shoelace formula. Positive for a
 * counter-clockwise ring, negative for clockwise.
 */
export function signedArea(ring: Point[]): number {
  let a = 0;
  for (let i = 0, n = ring.length; i < n; i++) {
    const p = ring[i];
    const q = ring[(i + 1) % n];
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}

/** Rotate a point by the rotation defined by `cos`/`sin`. */
export function rotatePoint(p: Point, cos: number, sin: number): Point {
  return { x: p.x * cos - p.y * sin, y: p.x * sin + p.y * cos };
}

/** Strip consecutive duplicate points and a repeated closing point from a ring. */
export function stripDuplicatePoints(ring: Point[]): Point[] {
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

/** Remove consecutive duplicate points and any closing duplicate, up to `round`. */
export function dedupRing(pts: Point[], round: (v: number) => number): Point[] {
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

/** Wrap an angle difference into `(-π, π]`. */
export function wrapPi(a: number): number {
  let v = a % (2 * Math.PI);
  if (v > Math.PI) v -= 2 * Math.PI;
  if (v <= -Math.PI) v += 2 * Math.PI;
  return v;
}
